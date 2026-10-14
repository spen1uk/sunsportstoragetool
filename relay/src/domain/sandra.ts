import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, canSeeConversation, canSeeContact, visibilitySql } from './authz.js';
import { audit, publish } from './events.js';
import { queueOutboundTx } from './messaging.js';
import { checkSmsAllowed } from './consent.js';
import { getSummary } from './summary.js';
import { getMatches, availabilityOf } from './inventory.js';
import { loadHours } from './hours.js';
import { notify, recipientsForConversation } from './notifications.js';
import { checkAuthority, type ServiceContext } from './service-identities.js';
import { emitServiceEvent } from './service-events.js';

// ---------- capability checks ----------
export function need(ctx: ServiceContext, scope: string) { if (!ctx.scopes.has(scope)) throw new HttpError(403, `missing scope ${scope}`, { code: 'missing_scope', scope }); }
/** Autonomy ladder: read_only < drafts < send. Scopes say WHAT; autonomy says how far it may act without a human. */
export function needAutonomy(ctx: ServiceContext, level: 'drafts' | 'send') {
  const rank = { read_only: 0, drafts: 1, send: 2 } as const;
  if (rank[ctx.autonomy] < rank[level]) throw new HttpError(403, `autonomy level “${ctx.autonomy}” does not allow this (needs “${level}”)`, { code: 'autonomy_too_low', required: level });
}
async function visibleConversation(c: Pick<PoolClient, 'query'>, ctx: ServiceContext, id: string) {
  const v = visibilitySql(ctx.actor, 'c', 3);
  const r = (await c.query(`SELECT c.* FROM conversations c WHERE c.id=$1 AND c.workspace_id=$2 AND ${v.sql}`, [id, ctx.workspaceId, ...v.params])).rows[0];
  if (!r) throw new HttpError(404, 'conversation not found');   // same answer for "missing" and "not yours": no probing across departments
  return r;
}

// ---------- reads ----------
const originOf = (m: { direction: string; sender_type: string }) => m.direction === 'inbound' ? 'customer' : m.sender_type === 'staff' ? 'staff' : m.sender_type === 'sandra' ? 'assistant' : m.sender_type;
export const messageDto = (m: any) => ({
  id: m.id, seq: m.seq, direction: m.direction, origin: originOf(m), body: m.body, status: m.status, createdAt: new Date(m.created_at).toISOString(),
  // Anything a customer typed is DATA, never instructions. The flag is explicit so a consumer cannot forget.
  untrusted: m.direction === 'inbound',
});
const conversationDto = (r: any) => ({
  id: r.id, contactId: r.contact_id, revision: r.revision, status: r.status, responsibility: r.responsibility, handlingMode: r.handling_mode,
  assigneeUserId: r.assignee_user_id, departmentId: r.department_id, tags: r.tags, lastInboundAt: r.last_inbound_at && new Date(r.last_inbound_at).toISOString(),
  lastOutboundAt: r.last_outbound_at && new Date(r.last_outbound_at).toISOString(), lastTakeoverAt: r.last_takeover_at && new Date(r.last_takeover_at).toISOString(),
});

export async function listConversationsFor(ctx: ServiceContext, q: { handlingMode?: string; responsibility?: string; limit?: number }) {
  need(ctx, 'conversations:read');
  const v = visibilitySql(ctx.actor, 'c', 2);
  const params: unknown[] = [ctx.workspaceId, ...v.params]; const where = ['c.workspace_id=$1', v.sql];
  if (q.handlingMode) { params.push(q.handlingMode); where.push(`c.handling_mode=$${params.length}`); }
  if (q.responsibility) { params.push(q.responsibility); where.push(`c.responsibility=$${params.length}`); }
  params.push(Math.min(q.limit ?? 50, 200));
  const rows = (await pool.query(`SELECT c.* FROM conversations c WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length}`, params)).rows;
  return { conversations: rows.map(conversationDto) };
}

export async function getConversationFor(ctx: ServiceContext, id: string, opts: { messageLimit?: number; beforeSeq?: number } = {}) {
  need(ctx, 'conversations:read');
  const c = await visibleConversation(pool, ctx, id);
  const out: Record<string, unknown> = { conversation: conversationDto(c) };
  const ct = (await pool.query('SELECT inbound_blocked, outbound_blocked, do_not_text, sms_opted_out, marketing_status FROM contacts WHERE id=$1', [c.contact_id])).rows[0];
  const verdict = checkSmsAllowed(ct, 'conversational');
  out.sms = verdict.allowed ? { canSend: true } : { canSend: false, reason: verdict.reason };
  const flags = await recentAuthorityFlags(c.id, c.workspace_id);
  out.humanRequiredTopics = flags;   // topics the customer raised that the owner reserved for people
  if (ctx.scopes.has('messages:read')) {
    const lim = Math.min(opts.messageLimit ?? 50, 200);
    const rows = (await pool.query(`SELECT m.* FROM messages m WHERE m.conversation_id=$1 AND m.redacted_at IS NULL AND m.status<>'suppressed' ${opts.beforeSeq ? 'AND (m.created_at, m.seq) < (SELECT created_at, seq FROM messages WHERE seq=$3)' : ''} ORDER BY m.created_at DESC, m.seq DESC LIMIT $2`, opts.beforeSeq ? [id, lim, opts.beforeSeq] : [id, lim])).rows;
    out.messages = rows.reverse().map(messageDto);
  }
  return out;
}

async function recentAuthorityFlags(conversationId: string, workspaceId: string): Promise<string[]> {
  const { ensureDefaultRules } = await import('./service-identities.js');
  await ensureDefaultRules(pool, workspaceId);
  const text = (await pool.query(`SELECT body FROM messages WHERE conversation_id=$1 AND direction='inbound' AND redacted_at IS NULL ORDER BY seq DESC LIMIT 5`, [conversationId])).rows.map((r) => r.body as string).join(' ').toLowerCase();
  const rules = (await pool.query('SELECT topic, keywords FROM assistant_rules WHERE workspace_id=$1 AND enabled', [workspaceId])).rows;
  return rules.filter((r) => (r.keywords as string[]).some((k) => text.includes(k.toLowerCase()))).map((r) => r.topic as string);
}

export async function getContactFor(ctx: ServiceContext, contactId: string) {
  need(ctx, 'contacts:read');
  if (!(await canSeeContact(pool, ctx.actor, contactId))) throw new HttpError(404, 'contact not found');
  const c = (await pool.query('SELECT id, first_name, last_name, company, email, tags, preferred_channel FROM contacts WHERE id=$1 AND erased_at IS NULL', [contactId])).rows[0];
  if (!c) throw new HttpError(404, 'contact not found');
  const boats = (await pool.query('SELECT relation, year, make, model FROM customer_boats WHERE contact_id=$1', [contactId])).rows;
  const prefs = (await pool.query('SELECT budget_min, budget_max, boat_types, length_min, length_max, features FROM contact_preferences WHERE contact_id=$1', [contactId])).rows[0] ?? null;
  const out: Record<string, unknown> = { id: c.id, firstName: c.first_name, lastName: c.last_name, company: c.company, tags: c.tags, boats, preferences: prefs };   // internal notes are never exposed
  if (ctx.scopes.has('contacts:pii')) {
    out.email = c.email;
    out.phones = (await pool.query(`SELECT original_value FROM contact_identities WHERE contact_id=$1 AND kind='phone'`, [contactId])).rows.map((r) => r.original_value);
  }
  return out;
}
export async function getSummaryFor(ctx: ServiceContext, contactId: string) { need(ctx, 'summaries:read'); return getSummary(ctx.actor, contactId); }
export async function getMatchesFor(ctx: ServiceContext, contactId: string) { need(ctx, 'inventory:read'); return getMatches(ctx.actor, contactId); }

export async function listInventoryFor(ctx: ServiceContext) {
  need(ctx, 'inventory:read');
  const rows = (await pool.query(`SELECT b.id, b.status, b.year, b.make, b.model, b.boat_type, b.length_ft, b.price, b.listing_url, s.key AS source_key, s.last_success_sync_at, s.stale_after_hours, s.is_source_of_truth
    FROM inventory_boats b JOIN inventory_sources s ON s.id=b.source_id WHERE b.workspace_id=$1 ORDER BY b.updated_at DESC LIMIT 500`, [ctx.workspaceId])).rows;
  // `availability` is the only field that may be repeated to a customer as availability. Anything but 'available' must not be promised.
  return { boats: rows.map((b) => ({ id: b.id, title: [b.year, b.make, b.model].filter(Boolean).join(' '), boatType: b.boat_type, lengthFt: b.length_ft === null ? null : Number(b.length_ft), price: b.price === null ? null : Number(b.price), listingUrl: b.listing_url,
    availability: availabilityOf(b, b), sourceLastSyncedAt: b.last_success_sync_at && new Date(b.last_success_sync_at).toISOString() })) };
}

export async function businessInfoFor(ctx: ServiceContext) {
  need(ctx, 'business:read');
  const ws = (await pool.query('SELECT name, timezone, global_automation_pause FROM workspaces WHERE id=$1', [ctx.workspaceId])).rows[0];
  const h = await loadHours(pool, ctx.workspaceId);
  const days = [...h.byWeekday.entries()].sort((a, b) => a[0] - b[0]).map(([weekday, d]) => ({ weekday, closed: d.closed, open: d.open, close: d.close }));
  const ch = (await pool.query('SELECT is_simulated, is_live_enabled FROM channels WHERE workspace_id=$1', [ctx.workspaceId])).rows;
  return { name: ws.name, timezone: ws.timezone, hours: h.configured ? { configured: true, days } : { configured: false, note: 'Business hours have not been entered; do not state hours.' }, automationPaused: ws.global_automation_pause,
    texting: { live: ch.some((x) => x.is_live_enabled && !x.is_simulated) } };
}

// ---------- idempotent writes ----------
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}` : JSON.stringify(v ?? null);
export interface IdemResult { status: number; body: unknown; replay: boolean }

/**
 * Run `fn` at most once per (identity, Idempotency-Key). The ledger insert, the write and the stored response share one transaction:
 *  - same key + same request  → the stored response is replayed (even if state has changed since)
 *  - same key + different request → 422, nothing executed
 *  - concurrent duplicates → the second blocks on the unique key until the first commits, then replays
 * Thrown HttpErrors roll everything back (and are not stored), so a transient 4xx can be retried with the same key.
 */
export async function idempotent(ctx: ServiceContext, key: string | undefined, method: string, path: string, body: unknown, correlationId: string | undefined,
  fn: (c: PoolClient) => Promise<{ status: number; body: unknown }>): Promise<IdemResult> {
  if (!key || key.length < 8 || key.length > 100) throw new HttpError(400, 'Idempotency-Key header (8-100 chars) is required for writes', { code: 'idempotency_key_required' });
  const hashv = createHash('sha256').update(`${method} ${path} ${stable(body)}`).digest('hex');
  return tx(async (c) => {
    const ins = await c.query(`INSERT INTO service_requests (identity_id, idem_key, request_hash, status_code, response, correlation_id) VALUES ($1,$2,$3,0,'null',$4) ON CONFLICT DO NOTHING RETURNING idem_key`, [ctx.identityId, key, hashv, correlationId ?? null]);
    if (!ins.rowCount) {
      const prev = (await c.query('SELECT request_hash, status_code, response FROM service_requests WHERE identity_id=$1 AND idem_key=$2', [ctx.identityId, key])).rows[0];
      if (prev.request_hash !== hashv) throw new HttpError(422, 'Idempotency-Key was already used with a different request', { code: 'idempotency_key_reuse' });
      return { status: prev.status_code, body: prev.response, replay: true };
    }
    const r = await fn(c);
    await c.query('UPDATE service_requests SET status_code=$3, response=$4 WHERE identity_id=$1 AND idem_key=$2', [ctx.identityId, key, r.status, JSON.stringify(r.body)]);
    return { ...r, replay: false };
  });
}

const auditSvc = (c: PoolClient, ctx: ServiceContext, action: string, targetId: string, meta: object, correlationId?: string) =>
  audit(c, { workspaceId: ctx.workspaceId, actorType: 'service', action, targetType: 'conversation', targetId, meta: { identity: ctx.name, identityId: ctx.identityId, correlationId, ...meta } });

// ----- send -----
const staleBody = (cur: { revision: number; handling_mode: string }, yours: number) => ({ error: 'stale_revision', currentRevision: cur.revision, handlingMode: cur.handling_mode, yourRevision: yours, note: 'The conversation changed since you read it (customer reply, staff takeover, or another send). Re-read it before deciding again.' });
export const sendSchema = z.object({ body: z.string().min(1).max(1600), expectedRevision: z.number().int().min(0) }).strict();
export async function sendFor(ctx: ServiceContext, c: PoolClient, conversationId: string, input: z.infer<typeof sendSchema>, idemKey: string, correlationId?: string) {
  need(ctx, 'messages:send'); needAutonomy(ctx, 'send');
  const conv = await visibleConversation(c, ctx, conversationId);
  // Fence first: if the world moved since the caller read it, nothing else about this request matters.
  if (conv.revision !== input.expectedRevision) {
    await auditSvc(c, ctx, 'assistant.send.rejected', conversationId, { reason: 'stale_revision', expectedRevision: input.expectedRevision }, correlationId);
    return { status: 409, body: staleBody(conv, input.expectedRevision) };
  }
  // Authority: topics reserved for people never go out under the assistant's name. They become a staff draft instead.
  const verdict = await checkAuthority(c, ctx.workspaceId, conversationId, input.body);
  if (!verdict.ok) {
    const d = await c.query(`INSERT INTO assistant_drafts (workspace_id, conversation_id, identity_id, body, reason, base_revision) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.workspaceId, conversationId, ctx.identityId, input.body, `authority:${verdict.topic}`, conv.revision]);
    await auditSvc(c, ctx, 'assistant.send.blocked_authority', conversationId, { topic: verdict.topic, draftId: d.rows[0].id }, correlationId);
    await notify(c, { workspaceId: ctx.workspaceId, userIds: await recipientsForConversation(c, conversationId), type: 'assistant_draft', title: `${ctx.name} drafted a reply that needs a person (${verdict.topic.replaceAll('_', ' ')})`, conversationId });
    await publish(c, ctx.workspaceId, 'conversation.updated', { conversationId });
    return { status: 422, body: { error: 'authority_required', topic: verdict.topic, detail: verdict.detail, draftId: d.rows[0].id, note: 'Not sent. Saved as a draft for staff.' } };
  }
  const r = await queueOutboundTx(c, { workspaceId: ctx.workspaceId, conversationId, body: input.body, senderType: 'sandra', purpose: 'conversational', idempotencyKey: `svc:${ctx.identityId}:${idemKey}`, expectedRevision: input.expectedRevision, serviceIdentityId: ctx.identityId });
  if (r.ok) {
    await auditSvc(c, ctx, 'assistant.send', conversationId, { messageId: r.messageId, expectedRevision: input.expectedRevision }, correlationId);
    const cur = (await c.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
    return { status: 202, body: { messageId: r.messageId, status: r.status, revision: cur } };
  }
  await auditSvc(c, ctx, 'assistant.send.rejected', conversationId, { reason: r.reason, expectedRevision: input.expectedRevision }, correlationId);
  if (r.reason === 'stale_revision') {
    // Tell the caller exactly what changed so it can re-evaluate rather than blindly retry.
    const cur = (await c.query('SELECT revision, handling_mode FROM conversations WHERE id=$1', [conversationId])).rows[0];
    return { status: 409, body: staleBody(cur, input.expectedRevision) };
  }
  const status = ['not_sandra_handling', 'automation_paused', 'draft_only_mode', 'global_pause', 'conversation_closed'].includes(r.reason) ? 409 : 422;
  return { status, body: { error: r.reason, messageId: r.messageId } };
}

// ----- drafts -----
export const draftSchema = z.object({ body: z.string().min(1).max(1600), expectedRevision: z.number().int().min(0).optional() }).strict();
export async function createDraftFor(ctx: ServiceContext, c: PoolClient, conversationId: string, input: z.infer<typeof draftSchema>, correlationId?: string) {
  need(ctx, 'drafts:write'); needAutonomy(ctx, 'drafts');
  const conv = await visibleConversation(c, ctx, conversationId);
  if (/\{\{\s*[a-z0-9_]+\s*\}\}/i.test(input.body)) return { status: 422, body: { error: 'unresolved_template_variables' } };
  const d = await c.query(`INSERT INTO assistant_drafts (workspace_id, conversation_id, identity_id, body, base_revision) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.workspaceId, conversationId, ctx.identityId, input.body, input.expectedRevision ?? conv.revision]);
  // A newer pending draft supersedes older pending drafts from the same identity (staff should see one suggestion, not a pile).
  await c.query(`UPDATE assistant_drafts SET status='dismissed', decided_at=now() WHERE conversation_id=$1 AND identity_id=$2 AND status='pending' AND id<>$3`, [conversationId, ctx.identityId, d.rows[0].id]);
  await auditSvc(c, ctx, 'assistant.draft.create', conversationId, { draftId: d.rows[0].id }, correlationId);
  await publish(c, ctx.workspaceId, 'conversation.updated', { conversationId });
  return { status: 201, body: { draftId: d.rows[0].id } };
}

// ----- tags / assign / handoff / pause / tasks -----
export const tagsSchema = z.object({ add: z.array(z.string().trim().min(1).max(40)).max(10).default([]), remove: z.array(z.string().trim().min(1).max(40)).max(10).default([]) }).strict();
export async function tagsFor(ctx: ServiceContext, c: PoolClient, conversationId: string, input: z.infer<typeof tagsSchema>, correlationId?: string) {
  need(ctx, 'conversations:write'); needAutonomy(ctx, 'drafts');
  await visibleConversation(c, ctx, conversationId);
  const r = await c.query(`UPDATE conversations SET tags = (SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}') FROM unnest(tags || $2::text[]) t WHERE NOT (t = ANY($3::text[]))) WHERE id=$1 RETURNING tags`, [conversationId, input.add, input.remove]);
  await auditSvc(c, ctx, 'assistant.tags', conversationId, input, correlationId);
  await publish(c, ctx.workspaceId, 'conversation.updated', { conversationId });
  return { status: 200, body: { tags: r.rows[0].tags } };
}

export const handoffSchema = z.object({ reason: z.string().min(1).max(500), assigneeUserId: z.string().uuid().optional(), createTask: z.boolean().default(false) }).strict();
/** Hand the conversation to people: handling→human (fence bumps, so anything still queued from the assistant is dropped) and notify staff. */
export async function handoffFor(ctx: ServiceContext, c: PoolClient, conversationId: string, input: z.infer<typeof handoffSchema>, correlationId?: string) {
  need(ctx, 'conversations:write'); needAutonomy(ctx, 'drafts');
  const conv = await visibleConversation(c, ctx, conversationId);
  if (input.assigneeUserId) {
    const m = (await c.query(`SELECT m.role, COALESCE(array_agg(md.department_id) FILTER (WHERE md.department_id IS NOT NULL), '{}') AS deps FROM memberships m LEFT JOIN membership_departments md ON md.membership_id=m.id WHERE m.workspace_id=$1 AND m.user_id=$2 GROUP BY m.id`, [ctx.workspaceId, input.assigneeUserId])).rows[0];
    if (!m) throw new HttpError(400, 'assignee is not a member of this workspace');
    if (conv.department_id && !['owner', 'admin'].includes(m.role)) {
      const d = (await c.query('SELECT restricted FROM departments WHERE id=$1', [conv.department_id])).rows[0];
      if (!m.deps.includes(conv.department_id) && (d.restricted || m.role === 'staff')) throw new HttpError(400, 'assignee lacks access to this department');
    }
  }
  await c.query('SELECT 1 FROM conversations WHERE id=$1 FOR UPDATE', [conversationId]);
  await c.query(`UPDATE conversations SET handling_mode='human', revision=revision+1, assignee_user_id=COALESCE($2, assignee_user_id), responsibility=CASE WHEN status='open' THEN 'needs_our_reply' ELSE responsibility END WHERE id=$1`, [conversationId, input.assigneeUserId ?? null]);
  await c.query(`UPDATE messages SET status='suppressed', status_detail='assistant_handoff' WHERE conversation_id=$1 AND status='queued' AND sender_type='sandra'`, [conversationId]);
  await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'handling_mode',$4)`, [ctx.workspaceId, conv.contact_id, conversationId, `${ctx.name} handed off to staff: ${input.reason.slice(0, 200)}`]);
  await notify(c, { workspaceId: ctx.workspaceId, userIds: input.assigneeUserId ? [input.assigneeUserId] : await recipientsForConversation(c, conversationId), type: 'assistant_handoff', title: `${ctx.name} needs a person: ${input.reason.slice(0, 80)}`, conversationId });
  let taskId: string | undefined;
  if (input.createTask) taskId = await insertTask(c, ctx, { title: `Follow up (assistant handoff): ${input.reason}`.slice(0, 200), conversationId, contactId: conv.contact_id, assigneeUserId: input.assigneeUserId ?? conv.assignee_user_id });
  await emitServiceEvent(c, ctx.workspaceId, 'conversation.handling_changed', { conversationId, contactId: conv.contact_id, payload: { mode: 'human', by: 'assistant' } });
  await auditSvc(c, ctx, 'assistant.handoff', conversationId, { reason: input.reason, taskId }, correlationId);
  await publish(c, ctx.workspaceId, 'conversation.updated', { conversationId });
  const rev = (await c.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
  return { status: 200, body: { ok: true, revision: rev, taskId: taskId ?? null } };
}

/** Pause = stop all automated handling of this conversation, without assigning it to anyone. */
export async function pauseFor(ctx: ServiceContext, c: PoolClient, conversationId: string, correlationId?: string) {
  need(ctx, 'conversations:write'); needAutonomy(ctx, 'drafts');
  const conv = await visibleConversation(c, ctx, conversationId);
  await c.query('SELECT 1 FROM conversations WHERE id=$1 FOR UPDATE', [conversationId]);
  await c.query(`UPDATE conversations SET handling_mode='paused', revision=revision+1 WHERE id=$1`, [conversationId]);
  await c.query(`UPDATE messages SET status='suppressed', status_detail='assistant_paused' WHERE conversation_id=$1 AND status='queued' AND sender_type IN ('sandra','automation')`, [conversationId]);
  await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'handling_mode',$4)`, [ctx.workspaceId, conv.contact_id, conversationId, `${ctx.name} paused automation on this conversation`]);
  await emitServiceEvent(c, ctx.workspaceId, 'conversation.handling_changed', { conversationId, contactId: conv.contact_id, payload: { mode: 'paused', by: 'assistant' } });
  await auditSvc(c, ctx, 'assistant.pause', conversationId, {}, correlationId);
  await publish(c, ctx.workspaceId, 'conversation.updated', { conversationId });
  const rev = (await c.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
  return { status: 200, body: { ok: true, revision: rev } };
}

async function insertTask(c: PoolClient, ctx: ServiceContext, t: { title: string; conversationId: string; contactId: string; assigneeUserId?: string | null; dueAt?: Date | null }) {
  // Tasks need a human owner. Default: the conversation's assignee, else the workspace owner who created this identity.
  const idn = (await c.query('SELECT created_by FROM service_identities WHERE id=$1', [ctx.identityId])).rows[0];
  const assignee = t.assigneeUserId ?? idn.created_by;
  const r = await c.query(`INSERT INTO tasks (workspace_id, title, assignee_user_id, created_by, due_at, contact_id, conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.workspaceId, t.title, assignee, idn.created_by, t.dueAt ?? null, t.contactId, t.conversationId]);
  await notify(c, { workspaceId: ctx.workspaceId, userIds: [assignee], type: 'task_assigned', title: `New task: ${t.title.slice(0, 80)}`, refId: r.rows[0].id });
  return r.rows[0].id as string;
}
export const taskSchema = z.object({ title: z.string().min(1).max(200), assigneeUserId: z.string().uuid().optional(), dueAt: z.string().datetime().optional() }).strict();
export async function taskFor(ctx: ServiceContext, c: PoolClient, conversationId: string, input: z.infer<typeof taskSchema>, correlationId?: string) {
  need(ctx, 'tasks:write'); needAutonomy(ctx, 'drafts');
  const conv = await visibleConversation(c, ctx, conversationId);
  if (input.assigneeUserId && !(await c.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [ctx.workspaceId, input.assigneeUserId])).rowCount) throw new HttpError(400, 'assignee is not a member of this workspace');
  const id = await insertTask(c, ctx, { title: `[${ctx.name}] ${input.title}`.slice(0, 200), conversationId, contactId: conv.contact_id, assigneeUserId: input.assigneeUserId ?? conv.assignee_user_id, dueAt: input.dueAt ? new Date(input.dueAt) : null });
  await auditSvc(c, ctx, 'assistant.task.create', conversationId, { taskId: id }, correlationId);
  return { status: 201, body: { taskId: id } };
}

export async function visibleToService(ctx: ServiceContext, conversationId: string) { return canSeeConversation(pool, ctx.actor, conversationId); }

// ---------- staff-side draft handling ----------
export async function listDraftsForStaff(a: import('./authz.js').Actor, conversationId: string) {
  if (!(await canSeeConversation(pool, a, conversationId))) throw new HttpError(404, 'conversation not found');
  return (await pool.query(`SELECT d.id, d.body, d.reason, d.base_revision, d.created_at, i.name AS assistant_name, c.revision AS current_revision
    FROM assistant_drafts d LEFT JOIN service_identities i ON i.id=d.identity_id JOIN conversations c ON c.id=d.conversation_id WHERE d.conversation_id=$1 AND d.status='pending' ORDER BY d.created_at DESC`, [conversationId])).rows;
}
export async function decideDraft(a: import('./authz.js').Actor, draftId: string, decision: 'used' | 'dismissed') {
  const d = (await pool.query('SELECT conversation_id, body FROM assistant_drafts WHERE id=$1 AND workspace_id=$2 AND status=\'pending\'', [draftId, a.workspaceId])).rows[0];
  if (!d) throw new HttpError(404, 'draft not found or already decided');
  if (!(await canSeeConversation(pool, a, d.conversation_id))) throw new HttpError(404, 'draft not found or already decided');
  await pool.query(`UPDATE assistant_drafts SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1`, [draftId, decision, a.userId]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: `assistant.draft.${decision}`, targetType: 'conversation', targetId: d.conversation_id, meta: { draftId } });
  return { body: d.body as string };
}
