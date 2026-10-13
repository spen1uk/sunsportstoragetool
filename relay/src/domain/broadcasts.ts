import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { config } from '../config.js';
import { HttpError, atLeastManager, type Actor } from './authz.js';
import { checkSmsAllowed, type Purpose } from './consent.js';
import { enqueue } from './queue.js';
import { publish } from './events.js';
import { queueOutboundTx } from './messaging.js';
import { automationVars } from './autoresponse.js';
import { loadAutomationSettings } from './hours.js';
import { render } from './templates.js';
import { assertTimezone, quietHoursEnd, zonedToUtc } from './time.js';
import { smsSegments } from './segments.js';
import { validateAttachments } from './media.js';

const audienceSchema = z.object({ tags: z.array(z.string().min(1).max(40)).max(20).default([]), matchAll: z.boolean().default(false), contactIds: z.array(z.string().uuid()).max(5000).default([]) });
export type Audience = z.infer<typeof audienceSchema>;
const input = z.object({ name: z.string().min(1).max(100), purpose: z.enum(['marketing', 'transactional']), body: z.string().min(1).max(1600), mediaIds: z.array(z.string().uuid()).max(5).default([]), audience: audienceSchema, batchSize: z.number().int().min(1).max(500).default(25), intervalSeconds: z.number().int().min(1).max(86400).default(60) });

const manager = (a: Actor) => { if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to manage broadcasts'); };
async function load(a: Actor, id: string) { const b = (await pool.query('SELECT * FROM broadcasts WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0]; if (!b) throw new HttpError(404, 'broadcast not found'); return b; }

export async function createBroadcast(a: Actor, i: unknown, kind: 'broadcast' | 'review_request' = 'broadcast') {
  manager(a); const b = input.parse(i);
  if (!b.audience.tags.length && !b.audience.contactIds.length) throw new HttpError(400, 'choose an audience (tags or specific customers)');
  if (b.mediaIds.length) { const c = await pool.connect(); try { const bad = await validateAttachments(c, a.workspaceId, b.mediaIds); if (bad) throw new HttpError(400, bad); } finally { c.release(); } }
  const r = await pool.query(`INSERT INTO broadcasts (workspace_id, name, purpose, body, media_ids, audience, batch_size, interval_seconds, created_by, kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [a.workspaceId, b.name, b.purpose, b.body, b.mediaIds, JSON.stringify(b.audience), b.batchSize, b.intervalSeconds, a.userId, kind]);
  return r.rows[0].id as string;
}
export async function updateBroadcast(a: Actor, id: string, i: unknown) {
  manager(a); const cur = await load(a, id); if (cur.status !== 'draft') throw new HttpError(409, 'only drafts can be edited');
  const b = input.parse(i);
  await pool.query(`UPDATE broadcasts SET name=$2, purpose=$3, body=$4, media_ids=$5, audience=$6, batch_size=$7, interval_seconds=$8 WHERE id=$1`, [id, b.name, b.purpose, b.body, b.mediaIds, JSON.stringify(b.audience), b.batchSize, b.intervalSeconds]);
}

export interface Plan { eligible: { contactId: string; name: string; text: string; segments: number; phone: string }[]; excluded: { contactId: string; name: string; reason: string }[] }
/** Resolve the audience NOW: tag/explicit selection → exclusions (consent, no phone, duplicate number, missing details) → personalized text. */
export const REVIEW_REASK_DAYS = 90;
export async function planAudience(workspaceId: string, b: { purpose: Purpose; body: string; audience: Audience; kind?: string }): Promise<Plan> {
  const au = audienceSchema.parse(b.audience);
  const rows = (await pool.query(
    `SELECT ct.*, (SELECT ci.normalized FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.kind='phone' ORDER BY ci.is_primary DESC, ci.created_at LIMIT 1) AS phone
     FROM contacts ct WHERE ct.workspace_id=$1 AND ct.merged_into IS NULL AND (
       ($2::text[] <> '{}' AND CASE WHEN $3 THEN ct.tags @> $2::text[] ELSE ct.tags && $2::text[] END) OR ct.id = ANY($4::uuid[])) ORDER BY ct.created_at, ct.id`, [workspaceId, au.tags, au.matchAll, au.contactIds])).rows;
  const plan: Plan = { eligible: [], excluded: [] }; const seenPhones = new Set<string>();
  for (const c of rows) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.phone || 'Unknown';
    const ex = (reason: string) => plan.excluded.push({ contactId: c.id, name, reason });
    if (!c.phone) { ex('no_phone'); continue; }
    const v = checkSmsAllowed(c, b.purpose); if (!v.allowed) { ex(v.reason); continue; }
    if (seenPhones.has(c.phone)) { ex('duplicate_number'); continue; }
    // Review requests are SENTIMENT-BLIND: the only exclusions are consent/contactability and "already asked recently".
    if (b.kind === 'review_request' && (await pool.query(`SELECT 1 FROM review_request_log WHERE contact_id=$1 AND requested_at > now() - ($2||' days')::interval`, [c.id, String(REVIEW_REASK_DAYS)])).rowCount) { ex('recently_asked'); continue; }
    const { text, missing } = render(b.body, await automationVars(workspaceId, c.id));
    if (missing.length) { ex(`missing_details:${missing.join(',')}`); continue; }
    seenPhones.add(c.phone); plan.eligible.push({ contactId: c.id, name, text, segments: smsSegments(text).segments, phone: c.phone });
  }
  if (plan.eligible.length > config.broadcastMaxRecipients) throw new HttpError(400, `audience of ${plan.eligible.length} exceeds this workspace's safety limit of ${config.broadcastMaxRecipients} recipients per broadcast`);
  return plan;
}

export async function previewBroadcast(a: Actor, id: string) {
  const b = await load(a, id); const plan = await planAudience(a.workspaceId, { purpose: b.purpose, body: b.body, audience: b.audience, kind: b.kind });
  const reasons: Record<string, number> = {}; for (const e of plan.excluded) reasons[e.reason.split(':')[0]] = (reasons[e.reason.split(':')[0]] ?? 0) + 1;
  const segs = plan.eligible.reduce((n, r) => n + r.segments, 0);
  const rate = (await pool.query(`SELECT value FROM workspace_settings WHERE workspace_id=$1 AND key='sms_cost_per_segment'`, [a.workspaceId])).rows[0]?.value;
  return {
    eligibleCount: plan.eligible.length, excludedCount: plan.excluded.length, excludedByReason: reasons, excludedSample: plan.excluded.slice(0, 20),
    samples: plan.eligible.slice(0, 5).map((r) => ({ name: r.name, text: r.text, segments: r.segments })),
    usage: { totalSegments: segs, mmsAttachments: b.media_ids.length, estimatedCostUsd: rate && !b.media_ids.length ? Math.round(segs * Number(rate) * 10000) / 10000 : null,
      note: rate ? (b.media_ids.length ? 'Cost not estimated for MMS (provider MMS pricing not entered).' : `Estimated from your entered rate of $${rate}/segment; carrier fees may add to this.`) : 'Cost unknown: no SMS provider/pricing has been entered. Segment counts are estimates; the provider’s count is authoritative.' },
    safeguards: 'Opt-outs, do-not-text and marketing consent are checked again for every recipient at the moment of sending.',
  };
}

export async function approveBroadcast(a: Actor, id: string, when: { sendNow: true } | { localTime: string; timezone?: string }) {
  manager(a); const b = await load(a, id); if (b.status !== 'draft') throw new HttpError(409, `broadcast is ${b.status}`);
  let at = new Date(); let tz: string | null = null; let local: string | null = null;
  if (!('sendNow' in when)) {
    tz = when.timezone ?? (await pool.query('SELECT timezone FROM workspaces WHERE id=$1', [a.workspaceId])).rows[0].timezone;
    try { assertTimezone(tz!); at = zonedToUtc(when.localTime, tz!).utc; } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (at.getTime() < Date.now() + 30_000) throw new HttpError(400, 'scheduled time must be in the future'); local = when.localTime;
  }
  const plan = await planAudience(a.workspaceId, { purpose: b.purpose, body: b.body, audience: b.audience, kind: b.kind });
  if (!plan.eligible.length) throw new HttpError(409, 'no eligible recipients');
  await tx(async (c) => {
    for (const r of plan.eligible) await c.query(`INSERT INTO broadcast_recipients (broadcast_id, contact_id) VALUES ($1,$2)`, [id, r.contactId]);
    for (const r of plan.excluded) await c.query(`INSERT INTO broadcast_recipients (broadcast_id, contact_id, status, reason) VALUES ($1,$2,'skipped',$3) ON CONFLICT DO NOTHING`, [id, r.contactId, r.reason]);
    await c.query(`UPDATE broadcasts SET status='scheduled', approved_by=$2, approved_at=now(), scheduled_for=$3, timezone=$4, local_time=$5 WHERE id=$1`, [id, a.userId, at, tz, local]);
    await c.query(`INSERT INTO audit_events (workspace_id, actor_user_id, action, target_type, target_id, meta) VALUES ($1,$2,'broadcast.approve','broadcast',$3,$4)`, [a.workspaceId, a.userId, id, JSON.stringify({ eligible: plan.eligible.length, excluded: plan.excluded.length, purpose: b.purpose })]);
    await enqueue(c, 'broadcast_tick', { broadcastId: id }, { runAt: at, workspaceId: a.workspaceId, dedupeKey: `${id}:start` });
  });
  return { eligible: plan.eligible.length, excluded: plan.excluded.length, startsAt: at };
}

export async function setBroadcastState(a: Actor, id: string, action: 'pause' | 'resume' | 'cancel') {
  manager(a); const b = await load(a, id);
  await tx(async (c) => {
    if (action === 'pause') { if (!['scheduled', 'sending'].includes(b.status)) throw new HttpError(409, `cannot pause a ${b.status} broadcast`); await c.query(`UPDATE broadcasts SET status='paused' WHERE id=$1`, [id]); }
    else if (action === 'resume') { if (b.status !== 'paused') throw new HttpError(409, 'not paused'); await c.query(`UPDATE broadcasts SET status='sending' WHERE id=$1`, [id]); await enqueue(c, 'broadcast_tick', { broadcastId: id }, { workspaceId: a.workspaceId, dedupeKey: `${id}:resume:${Date.now()}` }); }
    else {
      if (!['draft', 'scheduled', 'sending', 'paused'].includes(b.status)) throw new HttpError(409, `cannot cancel a ${b.status} broadcast`);
      await c.query(`UPDATE broadcasts SET status='cancelled', completed_at=now() WHERE id=$1`, [id]);
      await c.query(`UPDATE broadcast_recipients SET status='skipped', reason='broadcast_cancelled', updated_at=now() WHERE broadcast_id=$1 AND status='pending'`, [id]);
      await c.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE kind='broadcast_tick' AND status='pending' AND payload->>'broadcastId'=$1`, [id]);
    }
    await c.query(`INSERT INTO audit_events (workspace_id, actor_user_id, action, target_type, target_id) VALUES ($1,$2,$3,'broadcast',$4)`, [a.workspaceId, a.userId, `broadcast.${action}`, id]);
  });
}

/** Worker handler: send one throttled batch, re-evaluating consent and eligibility for every recipient at the moment of sending. */
export async function runBroadcastTick(broadcastId: string) {
  const b = (await pool.query('SELECT b.*, ws.global_automation_pause FROM broadcasts b JOIN workspaces ws ON ws.id=b.workspace_id WHERE b.id=$1', [broadcastId])).rows[0];
  if (!b || !['scheduled', 'sending'].includes(b.status)) return;                            // paused/cancelled/completed: do nothing
  const later = (at: Date) => enqueue(pool, 'broadcast_tick', { broadcastId }, { runAt: at, workspaceId: b.workspace_id, dedupeKey: `${broadcastId}:t:${at.getTime()}:${Math.random().toString(36).slice(2, 6)}` });
  if (b.global_automation_pause) return void (await later(new Date(Date.now() + 15 * 60_000)));
  if (b.purpose === 'marketing') {
    const st = await loadAutomationSettings(pool, b.workspace_id); const tz = (await pool.query('SELECT timezone FROM workspaces WHERE id=$1', [b.workspace_id])).rows[0].timezone;
    const end = quietHoursEnd(new Date(), tz, st.quiet_start_hour, st.quiet_end_hour); if (end) return void (await later(end));      // marketing respects quiet hours
  }
  if (b.status === 'scheduled') await pool.query(`UPDATE broadcasts SET status='sending', started_at=now() WHERE id=$1 AND status='scheduled'`, [broadcastId]);
  const batch = (await pool.query(`SELECT id, contact_id FROM broadcast_recipients WHERE broadcast_id=$1 AND status='pending' ORDER BY id LIMIT $2`, [broadcastId, b.batch_size])).rows;
  const ch = (await pool.query(`SELECT id FROM channels WHERE workspace_id=$1 AND kind='sms' ORDER BY is_simulated DESC LIMIT 1`, [b.workspace_id])).rows[0];
  for (const r of batch) {
    await tx(async (c) => {
      const cur = (await c.query('SELECT status FROM broadcasts WHERE id=$1', [broadcastId])).rows[0]; if (!['sending'].includes(cur.status)) return;      // paused/cancelled mid-batch
      const rec = (await c.query(`SELECT status FROM broadcast_recipients WHERE id=$1 FOR UPDATE`, [r.id])).rows[0]; if (rec.status !== 'pending') return;
      const mark = (status: string, reason: string | null, messageId?: string) => c.query(`UPDATE broadcast_recipients SET status=$2, reason=$3, message_id=$4, updated_at=now() WHERE id=$1`, [r.id, status, reason, messageId ?? null]);
      const ct = (await c.query(`SELECT ct.*, (SELECT ci.id FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.kind='phone' ORDER BY ci.is_primary DESC, ci.created_at LIMIT 1) AS ident FROM contacts ct WHERE ct.id=$1`, [r.contact_id])).rows[0];
      if (!ct || ct.merged_into || !ct.ident || !ch) return mark('skipped', 'contact_unavailable');
      const v = checkSmsAllowed(ct, b.purpose); if (!v.allowed) return mark('suppressed', v.reason);          // opt-out etc. re-checked NOW
      const { text, missing } = render(b.body, await automationVars(b.workspace_id, ct.id)); if (missing.length) return mark('skipped', `missing_details:${missing.join(',')}`);
      // The conversation is created closed so a broadcast doesn't clutter the inbox; a customer reply reopens it.
      const cv = (await c.query(`INSERT INTO conversations (workspace_id, contact_id, channel_id, contact_identity_id, status, responsibility) VALUES ($1,$2,$3,$4,'closed','closed')
        ON CONFLICT (workspace_id, contact_id, channel_id) DO UPDATE SET contact_identity_id=COALESCE(conversations.contact_identity_id, EXCLUDED.contact_identity_id) RETURNING id`, [b.workspace_id, ct.id, ch.id, ct.ident])).rows[0];
      const res = await queueOutboundTx(c, { workspaceId: b.workspace_id, conversationId: cv.id, body: text, senderType: 'staff', senderUserId: b.approved_by, purpose: b.purpose, idempotencyKey: `bc:${broadcastId}:${ct.id}`, mediaIds: b.media_ids, autoKind: 'broadcast', passive: true });
      if (res.ok) { await mark('queued', null, res.messageId); if (b.kind === 'review_request') await c.query('INSERT INTO review_request_log (contact_id, broadcast_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ct.id, broadcastId]); } else await mark('suppressed', res.reason, res.messageId);
    });
  }
  const left = (await pool.query(`SELECT count(*)::int n FROM broadcast_recipients WHERE broadcast_id=$1 AND status='pending'`, [broadcastId])).rows[0].n;
  const state = (await pool.query('SELECT status FROM broadcasts WHERE id=$1', [broadcastId])).rows[0].status;
  if (state === 'sending') {
    if (left === 0) { await pool.query(`UPDATE broadcasts SET status='completed', completed_at=now() WHERE id=$1`, [broadcastId]); }
    else await later(new Date(Date.now() + b.interval_seconds * 1000));
  }
  await publish(pool, b.workspace_id, 'broadcast.updated', { broadcastId });
}

export async function listBroadcasts(a: Actor) {
  return (await pool.query(`SELECT b.id, b.name, b.purpose, b.status, b.scheduled_for, b.created_at, b.audience,
      (SELECT count(*)::int FROM broadcast_recipients r WHERE r.broadcast_id=b.id) AS recipients FROM broadcasts b WHERE b.workspace_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [a.workspaceId])).rows;
}
export async function getBroadcast(a: Actor, id: string) {
  const b = await load(a, id);
  const rows = (await pool.query(
    `SELECT r.id, r.contact_id, r.status AS recipient_status, r.reason, m.status AS message_status, m.status_detail, ct.first_name, ct.last_name,
       (SELECT original_value FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.kind='phone' ORDER BY is_primary DESC LIMIT 1) AS phone,
       EXISTS (SELECT 1 FROM messages rep WHERE rep.conversation_id=m.conversation_id AND rep.direction='inbound' AND rep.created_at > m.created_at AND rep.created_at < m.created_at + interval '48 hours') AS replied_48h
     FROM broadcast_recipients r JOIN contacts ct ON ct.id=r.contact_id LEFT JOIN messages m ON m.id=r.message_id WHERE r.broadcast_id=$1 ORDER BY r.id`, [id])).rows;
  // Delivery states are reported exactly as known: provider acceptance is NOT delivery.
  const counts: Record<string, number> = {};
  for (const r of rows) { const k = r.message_status ?? r.recipient_status; counts[k] = (counts[k] ?? 0) + 1; }
  return { broadcast: { id: b.id, kind: b.kind, name: b.name, purpose: b.purpose, body: b.body, status: b.status, scheduledFor: b.scheduled_for, startedAt: b.started_at, completedAt: b.completed_at, batchSize: b.batch_size, intervalSeconds: b.interval_seconds, audience: b.audience },
    progress: { total: rows.length, counts, replies48h: rows.filter((r) => r.replied_48h).length },
    recipients: rows.map((r) => ({ contactId: r.contact_id, name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.phone, phone: r.phone, status: r.message_status ?? r.recipient_status, detail: r.status_detail ?? r.reason, replied: r.replied_48h })) };
}
