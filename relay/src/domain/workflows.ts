import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tx } from '../db/pool.js';
import { HttpError, atLeastManager, isAdmin, requireConversation, type Actor } from './authz.js';
import { enqueue } from './queue.js';
import { publish } from './events.js';
import { queueOutboundTx } from './messaging.js';
import { notify, recipientsForConversation } from './notifications.js';
import { automationVars } from './autoresponse.js';
import { loadAutomationSettings, loadHours, nextOpenAt, openState, type Hours } from './hours.js';
import { quietHoursEnd } from './time.js';
import { render } from './templates.js';

// ---------- definition (bounded actions only — no code, no arbitrary URLs) ----------
const cond = z.object({ field: z.enum(['department', 'tag', 'handling_mode', 'responsibility', 'business_hours', 'message_contains', 'assigned']), op: z.enum(['is', 'is_not', 'contains', 'is_set', 'is_empty']).default('is'), value: z.string().max(100).optional() });
export type Cond = z.infer<typeof cond>;
const step: z.ZodType<Step> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), minutes: z.number().int().min(1).max(43200), businessHoursOnly: z.boolean().optional() }),
  z.object({ type: z.literal('send_message'), body: z.string().max(1600).optional(), templateId: z.string().uuid().optional(), kind: z.enum(['follow_up', 'workflow']).default('workflow'), requireQuestion: z.boolean().optional(), expectsReply: z.boolean().optional() }),
  z.object({ type: z.literal('add_tag'), tag: z.string().min(1).max(40) }),
  z.object({ type: z.literal('assign'), userId: z.string().uuid() }),
  z.object({ type: z.literal('create_task'), title: z.string().min(1).max(200), assigneeId: z.string().uuid().optional(), dueInHours: z.number().int().min(1).max(720).optional() }),
  z.object({ type: z.literal('set_responsibility'), state: z.enum(['needs_our_reply', 'waiting_on_customer', 'waiting_on_staff']) }),
  z.object({ type: z.literal('notify_staff'), message: z.string().min(1).max(200), userId: z.string().uuid().optional() }),
  z.object({ type: z.literal('branch'), if: cond, then: z.array(step).max(20), else: z.array(step).max(20).default([]) }),
  z.object({ type: z.literal('end') }),
])) as never;
export type Step =
  | { type: 'wait'; minutes: number; businessHoursOnly?: boolean }
  | { type: 'send_message'; body?: string; templateId?: string; kind: 'follow_up' | 'workflow'; requireQuestion?: boolean; expectsReply?: boolean }
  | { type: 'add_tag'; tag: string } | { type: 'assign'; userId: string } | { type: 'create_task'; title: string; assigneeId?: string; dueInHours?: number }
  | { type: 'set_responsibility'; state: 'needs_our_reply' | 'waiting_on_customer' | 'waiting_on_staff' } | { type: 'notify_staff'; message: string; userId?: string }
  | { type: 'branch'; if: Cond; then: Step[]; else: Step[] } | { type: 'end' };

const trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inbound_message') }),
  z.object({ type: z.literal('no_response'), afterHours: z.number().min(1).max(720), requireQuestion: z.boolean().optional(), businessHoursOnly: z.boolean().optional() }),
  z.object({ type: z.literal('inventory_update'), change: z.enum(['price_drop', 'back_available', 'any']).default('any') }),
  z.object({ type: z.literal('appointment_event'), event: z.string().max(40) }), z.object({ type: z.literal('service_event'), event: z.string().max(40) }),
  z.object({ type: z.literal('storage_event'), event: z.string().max(40) }), z.object({ type: z.literal('invoice_state'), event: z.string().max(40) }),
]);
export const definitionSchema = z.object({
  trigger, conditions: z.array(cond).max(10).default([]), steps: z.array(step).min(1).max(30),
  limits: z.object({ maxSendsPerContactPerDay: z.number().int().min(1).max(10).default(2), respectQuietHours: z.boolean().default(true), staffWaitReminderHours: z.number().min(0.01).max(168).default(4), staffWaitEscalateHours: z.number().min(0.01).max(720).default(24) }).default({ maxSendsPerContactPerDay: 2, respectQuietHours: true, staffWaitReminderHours: 4, staffWaitEscalateHours: 24 }),
});
export type Definition = z.infer<typeof definitionSchema>;

/** Which trigger sources are backed by a VERIFIED adapter. External business events (appointments, service, storage, invoices) are not connected yet. */
export const TRIGGER_ADAPTERS: Record<string, { verified: boolean; note: string }> = {
  inbound_message: { verified: true, note: 'Internal: customer text received.' },
  no_response: { verified: true, note: 'Internal: scanned from conversation state every few minutes.' },
  inventory_update: { verified: true, note: 'Internal: inventory import/edit (price drops, back available) for customers who marked interest.' },
  appointment_event: { verified: false, note: 'Needs a verified calendar/appointment adapter (not connected).' },
  service_event: { verified: false, note: 'Needs a verified service-system adapter (not connected).' },
  storage_event: { verified: false, note: 'Needs the storage-tool adapter (not connected).' },
  invoice_state: { verified: false, note: 'Needs a verified accounting/payment adapter (not connected).' },
};

// ---------- compile to a flat program (branches become jumps) ----------
export type Instr = { op: 'wait'; minutes: number; bho: boolean } | { op: 'send'; s: Extract<Step, { type: 'send_message' }> } | { op: 'tag'; tag: string } | { op: 'assign'; userId: string }
  | { op: 'task'; s: Extract<Step, { type: 'create_task' }> } | { op: 'resp'; state: string } | { op: 'notify'; s: Extract<Step, { type: 'notify_staff' }> } | { op: 'ifnot'; cond: Cond; to: number } | { op: 'jump'; to: number } | { op: 'end' };
export function compile(steps: Step[], out: Instr[] = []): Instr[] {
  for (const s of steps) {
    switch (s.type) {
      case 'wait': out.push({ op: 'wait', minutes: s.minutes, bho: !!s.businessHoursOnly }); break;
      case 'send_message': out.push({ op: 'send', s }); break;
      case 'add_tag': out.push({ op: 'tag', tag: s.tag }); break;
      case 'assign': out.push({ op: 'assign', userId: s.userId }); break;
      case 'create_task': out.push({ op: 'task', s }); break;
      case 'set_responsibility': out.push({ op: 'resp', state: s.state }); break;
      case 'notify_staff': out.push({ op: 'notify', s }); break;
      case 'end': out.push({ op: 'end' }); break;
      case 'branch': {
        const i = out.push({ op: 'ifnot', cond: s.if, to: -1 }) - 1; compile(s.then, out);
        const j = s.else.length ? out.push({ op: 'jump', to: -1 }) - 1 : -1;
        (out[i] as { to: number }).to = out.length; if (j >= 0) { compile(s.else, out); (out[j] as { to: number }).to = out.length; }
      }
    }
  }
  return out;
}
export function programOf(def: Definition): Instr[] { const p = compile(def.steps as Step[]); p.push({ op: 'end' }); return p; }

// ---------- context + conditions ----------
interface Ctx { conv: any; contact: any; deptKey: string | null; lastInbound: string; hours: Hours; open: ReturnType<typeof openState>['state'] }
async function loadCtx(c: PoolClient, conversationId: string, lock: boolean): Promise<Ctx> {
  const conv = (await c.query(`SELECT cv.*, ws.global_automation_pause, ws.timezone FROM conversations cv JOIN workspaces ws ON ws.id=cv.workspace_id WHERE cv.id=$1 ${lock ? 'FOR UPDATE OF cv' : ''}`, [conversationId])).rows[0];
  const contact = (await c.query('SELECT * FROM contacts WHERE id=$1', [conv.contact_id])).rows[0];
  const deptKey = conv.department_id ? (await c.query('SELECT key FROM departments WHERE id=$1', [conv.department_id])).rows[0]?.key ?? null : null;
  const lastInbound = (await c.query(`SELECT body FROM messages WHERE conversation_id=$1 AND direction='inbound' ORDER BY seq DESC LIMIT 1`, [conversationId])).rows[0]?.body ?? '';
  const hours = await loadHours(c, conv.workspace_id);
  return { conv, contact, deptKey, lastInbound, hours, open: openState(hours, new Date()).state };
}
export function evalCond(k: Cond, x: Ctx): { pass: boolean; why: string } {
  const v = (k.value ?? '').toLowerCase(); const tags = [...(x.conv.tags ?? []), ...(x.contact.tags ?? [])].map((t: string) => t.toLowerCase());
  const neg = k.op === 'is_not'; let actual = ''; let pass = false;
  switch (k.field) {
    case 'department': actual = x.deptKey ?? 'none'; pass = actual === v; break;
    case 'tag': actual = tags.join(',') || 'none'; pass = tags.includes(v); break;
    case 'handling_mode': actual = x.conv.handling_mode; pass = actual === v; break;
    case 'responsibility': actual = x.conv.responsibility; pass = actual === v; break;
    case 'business_hours': actual = x.open; pass = x.open === v; break;
    case 'message_contains': actual = 'last customer message'; pass = x.lastInbound.toLowerCase().includes(v); break;
    case 'assigned': actual = x.conv.assignee_user_id ? 'set' : 'empty'; pass = k.op === 'is_set' ? !!x.conv.assignee_user_id : !x.conv.assignee_user_id; return { pass, why: `assigned is ${actual}` };
  }
  if (neg) pass = !pass;
  if (k.field === 'business_hours' && x.open === 'unknown') return { pass: false, why: 'business hours are not configured, so this cannot be evaluated' };
  return { pass, why: `${k.field} ${neg ? 'is not' : k.op === 'contains' ? 'contains' : 'is'} "${k.value}" (actual: ${actual})` };
}
const evalAll = (conds: Cond[], x: Ctx) => { const r = conds.map((k) => evalCond(k, x)); return { pass: r.every((y) => y.pass), details: r }; };

// ---------- CRUD ----------
async function validateRefs(a: Actor, def: Definition) {
  const ids = new Set<string>(); const walk = (ss: Step[]) => ss.forEach((s) => { if (s.type === 'assign') ids.add(s.userId); if (s.type === 'create_task' && s.assigneeId) ids.add(s.assigneeId); if (s.type === 'notify_staff' && s.userId) ids.add(s.userId); if (s.type === 'branch') { walk(s.then); walk(s.else); } });
  walk(def.steps as Step[]);
  if (ids.size) { const r = await pool.query('SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id = ANY($2::uuid[])', [a.workspaceId, [...ids]]); if (r.rowCount !== ids.size) throw new HttpError(400, 'a referenced staff member is not in this workspace'); }
}
export async function createWorkflow(a: Actor, i: { name: string; description?: string; definition: unknown }) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to manage automations');
  const def = definitionSchema.parse(i.definition); await validateRefs(a, def);
  return tx(async (c) => {
    const w = (await c.query('INSERT INTO workflows (workspace_id, name, description, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [a.workspaceId, i.name, i.description ?? null, a.userId]).catch((e) => { if (e.code === '23505') throw new HttpError(409, 'an automation with that name exists'); throw e; })).rows[0];
    await c.query('INSERT INTO workflow_versions (workflow_id, version, definition, created_by) VALUES ($1,1,$2,$3)', [w.id, JSON.stringify(def), a.userId]);
    return w.id as string;
  });
}
export async function updateWorkflow(a: Actor, id: string, definition: unknown) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to manage automations');
  const def = definitionSchema.parse(definition); await validateRefs(a, def);
  return tx(async (c) => {
    const w = (await c.query('SELECT current_version FROM workflows WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [id, a.workspaceId])).rows[0];
    if (!w) throw new HttpError(404, 'automation not found');
    const v = w.current_version + 1;
    await c.query('INSERT INTO workflow_versions (workflow_id, version, definition, created_by) VALUES ($1,$2,$3,$4)', [id, v, JSON.stringify(def), a.userId]);
    await c.query('UPDATE workflows SET current_version=$2 WHERE id=$1', [id, v]);   // running runs keep the version they started with
    return v;
  });
}
export async function setWorkflowStatus(a: Actor, id: string, status: 'active' | 'paused') {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to manage automations');
  const w = (await pool.query(`SELECT w.*, v.definition FROM workflows w JOIN workflow_versions v ON v.workflow_id=w.id AND v.version=w.current_version WHERE w.id=$1 AND w.workspace_id=$2`, [id, a.workspaceId])).rows[0];
  if (!w) throw new HttpError(404, 'automation not found');
  if (status === 'active') {
    const def = definitionSchema.parse(w.definition); const t = TRIGGER_ADAPTERS[def.trigger.type];
    if (!t.verified) throw new HttpError(409, `cannot activate: trigger "${def.trigger.type}" requires a verified adapter that is not connected (${t.note})`);
    const usesBho = def.trigger.type === 'no_response' && def.trigger.businessHoursOnly || JSON.stringify(def.steps).includes('"businessHoursOnly":true') || JSON.stringify(def.conditions).includes('business_hours');
    if (usesBho && !(await loadHours(pool, a.workspaceId)).configured) throw new HttpError(409, 'cannot activate: this automation depends on business hours, which are not configured (Settings → Business hours)');
    const hasSend = JSON.stringify(def.steps).includes('"send_message"');
    if (hasSend) for (const sendStep of flatten(def.steps as Step[])) if (sendStep.type === 'send_message' && !sendStep.body && !sendStep.templateId) throw new HttpError(409, 'cannot activate: a send step has no message');
  }
  await tx(async (c) => {
    await c.query('UPDATE workflows SET status=$2 WHERE id=$1', [id, status]);
    if (status === 'active') for (const r of (await c.query(`SELECT id, pc FROM workflow_runs WHERE workflow_id=$1 AND status='waiting'`, [id])).rows) await enqueue(c, 'workflow_step', { runId: r.id }, { workspaceId: a.workspaceId, dedupeKey: `${r.id}:resume:${Date.now()}` });
  });
}
function flatten(ss: Step[]): Step[] { return ss.flatMap((s) => (s.type === 'branch' ? [s, ...flatten(s.then), ...flatten(s.else)] : [s])); }

export async function listWorkflows(a: Actor) {
  return (await pool.query(`SELECT w.id, w.name, w.description, w.status, w.current_version, v.definition,
      (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id=w.id AND r.status IN ('waiting','running')) AS active_runs,
      (SELECT count(*)::int FROM workflow_runs r WHERE r.workflow_id=w.id) AS total_runs
    FROM workflows w JOIN workflow_versions v ON v.workflow_id=w.id AND v.version=w.current_version WHERE w.workspace_id=$1 ORDER BY w.created_at DESC`, [a.workspaceId])).rows;
}
export async function listRuns(a: Actor, workflowId: string) {
  const r = await pool.query(`SELECT r.id, r.version, r.status, r.stop_reason, r.next_run_at, r.pc, r.created_at, r.conversation_id, ct.first_name, ct.last_name FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id JOIN contacts ct ON ct.id=r.contact_id WHERE r.workflow_id=$1 AND w.workspace_id=$2 ORDER BY r.created_at DESC LIMIT 100`, [workflowId, a.workspaceId]);
  const out = []; for (const row of r.rows) { try { await requireConversation(pool, a, row.conversation_id); out.push(row); } catch { /* not visible to this viewer */ } } return out;
}
export async function runLog(a: Actor, runId: string) {
  const r = (await pool.query('SELECT r.*, w.name FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.id=$1 AND r.workspace_id=$2', [runId, a.workspaceId])).rows[0];
  if (!r) throw new HttpError(404, 'run not found'); await requireConversation(pool, a, r.conversation_id);
  const log = (await pool.query('SELECT step, outcome, detail, at FROM workflow_run_log WHERE run_id=$1 ORDER BY id', [runId])).rows;
  const def = definitionSchema.parse((await pool.query('SELECT definition FROM workflow_versions WHERE workflow_id=$1 AND version=$2', [r.workflow_id, r.version])).rows[0].definition);
  const prog = programOf(def); const next = r.status === 'waiting' || r.status === 'running' ? describe(prog[r.pc]) : null;
  return { run: { id: r.id, workflow: r.name, version: r.version, status: r.status, stopReason: r.stop_reason, nextRunAt: r.next_run_at, next }, log };
}
export async function activityForConversation(a: Actor, conversationId: string) {
  await requireConversation(pool, a, conversationId);
  const rows = (await pool.query(`SELECT r.id, r.status, r.stop_reason, r.next_run_at, r.pc, r.version, w.name, v.definition FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id JOIN workflow_versions v ON v.workflow_id=r.workflow_id AND v.version=r.version WHERE r.conversation_id=$1 ORDER BY r.created_at DESC LIMIT 10`, [conversationId])).rows;
  return rows.map((r) => ({ id: r.id, workflow: r.name, status: r.status, stopReason: r.stop_reason, nextRunAt: r.next_run_at, next: ['waiting', 'running'].includes(r.status) ? describe(programOf(definitionSchema.parse(r.definition))[r.pc]) : null }));
}
export async function stopRunByStaff(a: Actor, runId: string) {
  const r = (await pool.query('SELECT conversation_id FROM workflow_runs WHERE id=$1 AND workspace_id=$2', [runId, a.workspaceId])).rows[0];
  if (!r) throw new HttpError(404, 'run not found'); await requireConversation(pool, a, r.conversation_id);
  await tx(async (c) => {
    const u = await c.query(`UPDATE workflow_runs SET status='stopped', stop_reason='stopped_by_staff', next_run_at=NULL, updated_at=now() WHERE id=$1 AND status IN ('waiting','running') RETURNING id`, [runId]);
    if (u.rowCount) await c.query(`INSERT INTO workflow_run_log (run_id, step, outcome, detail) VALUES ($1,'stop','stopped',$2)`, [runId, `Stopped by ${a.name ?? 'a staff member'}`]);
  });
}
export async function setGlobalPause(a: Actor, paused: boolean) {
  if (!isAdmin(a)) throw new HttpError(403, 'admin required');
  await pool.query('UPDATE workspaces SET global_automation_pause=$2 WHERE id=$1', [a.workspaceId, paused]);
  if (!paused) for (const r of (await pool.query(`SELECT id FROM workflow_runs WHERE workspace_id=$1 AND status='waiting'`, [a.workspaceId])).rows) await enqueue(pool, 'workflow_step', { runId: r.id }, { workspaceId: a.workspaceId, dedupeKey: `${r.id}:unpause:${Date.now()}` });
  await pool.query(`INSERT INTO audit_events (workspace_id, actor_user_id, action, meta) VALUES ($1,$2,'automation.global_pause',$3)`, [a.workspaceId, a.userId, JSON.stringify({ paused })]);
}

function describe(i?: Instr): string {
  if (!i) return 'finish';
  switch (i.op) {
    case 'wait': return `wait ${i.minutes >= 60 ? `${+(i.minutes / 60).toFixed(1)} h` : `${i.minutes} min`}${i.bho ? ' (business hours only)' : ''}`;
    case 'send': return `${i.s.kind === 'follow_up' ? 'send customer follow-up' : 'send message'}: “${(i.s.body ?? '(template)').slice(0, 60)}”`;
    case 'tag': return `add tag “${i.tag}”`; case 'assign': return 'assign conversation'; case 'task': return `create task “${i.s.title}”`;
    case 'resp': return `mark ${i.state.replaceAll('_', ' ')}`; case 'notify': return `notify staff: ${i.s.message}`; case 'ifnot': return `check ${i.cond.field}`; case 'jump': return 'continue'; case 'end': return 'finish';
  }
}

// ---------- events → runs ----------
async function startRun(c: PoolClient, wf: { id: string; workspace_id: string; name: string; current_version: number }, x: Ctx, triggerType: string, triggerRef: string, baselineInbound: Date | null) {
  const active = await c.query(`SELECT 1 FROM workflow_runs WHERE workflow_id=$1 AND conversation_id=$2 AND status IN ('waiting','running')`, [wf.id, x.conv.id]);
  const note = (summary: string) => c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'automation',$4)`, [wf.workspace_id, x.conv.contact_id, x.conv.id, summary]);
  if (active.rowCount) { await note(`Automation “${wf.name}” not started: already running for this conversation`); return null; }
  const recent = (await c.query(`SELECT count(*)::int n FROM workflow_runs WHERE workflow_id=$1 AND contact_id=$2 AND created_at > now() - interval '24 hours'`, [wf.id, x.conv.contact_id])).rows[0].n;
  if (recent >= 5) { await note(`Automation “${wf.name}” not started: run limit (5 per customer per day) reached — loop protection`); return null; }
  const r = await c.query(
    `INSERT INTO workflow_runs (workspace_id, workflow_id, version, conversation_id, contact_id, trigger_type, trigger_ref, baseline_inbound_at, baseline_takeover_at, next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()) ON CONFLICT (workflow_id, conversation_id, trigger_ref) DO NOTHING RETURNING id`,
    [wf.workspace_id, wf.id, wf.current_version, x.conv.id, x.conv.contact_id, triggerType, triggerRef, baselineInbound, x.conv.last_takeover_at]);
  if (!r.rowCount) return null;                                   // same trigger seen twice → exactly one run
  await c.query(`INSERT INTO workflow_run_log (run_id, step, outcome, detail) VALUES ($1,'start','started',$2)`, [r.rows[0].id, `Started by ${triggerType.replaceAll('_', ' ')} (${triggerRef.slice(0, 8)}…)`]);
  await enqueue(c, 'workflow_step', { runId: r.rows[0].id }, { workspaceId: wf.workspace_id, dedupeKey: `${r.rows[0].id}:0` });
  return r.rows[0].id as string;
}
async function activeWorkflows(c: PoolClient, workspaceId: string, type: string) {
  return (await c.query(`SELECT w.id, w.workspace_id, w.name, w.current_version, v.definition FROM workflows w JOIN workflow_versions v ON v.workflow_id=w.id AND v.version=w.current_version WHERE w.workspace_id=$1 AND w.status='active' AND v.definition->'trigger'->>'type'=$2`, [workspaceId, type])).rows;
}

export async function handleWorkflowEvent(ev: { type: 'inbound_message'; conversationId: string; messageId: string } | { type: 'inventory_update'; boatId: string; change: 'price_drop' | 'back_available' | 'new'; stamp: string; workspaceId: string }) {
  await tx(async (c) => {
    if (ev.type === 'inbound_message') {
      const x = await loadCtx(c, ev.conversationId, false);
      const msg = (await c.query('SELECT created_at FROM messages WHERE id=$1', [ev.messageId])).rows[0];
      for (const wf of await activeWorkflows(c, x.conv.workspace_id, 'inbound_message')) {
        const def = definitionSchema.parse(wf.definition);
        if (evalAll(def.conditions, x).pass) await startRun(c, wf, x, 'inbound_message', ev.messageId, msg.created_at);
      }
    } else {
      // Only customers who explicitly marked interest in this boat are contacted-by-automation about it.
      const who = (await c.query(`SELECT cv.id FROM match_results m JOIN conversations cv ON cv.contact_id=m.contact_id WHERE m.boat_id=$1 AND m.user_status='interested' AND cv.workspace_id=$2`, [ev.boatId, ev.workspaceId])).rows;
      for (const wf of await activeWorkflows(c, ev.workspaceId, 'inventory_update')) {
        const def = definitionSchema.parse(wf.definition);
        const want = def.trigger.type === 'inventory_update' ? def.trigger.change : 'any';
        if (want !== 'any' && want !== ev.change) continue;
        for (const row of who) { const x = await loadCtx(c, row.id, false); if (evalAll(def.conditions, x).pass) await startRun(c, wf, x, 'inventory_update', `${ev.boatId}:${ev.stamp}`, x.conv.last_inbound_at); }
      }
    }
  });
}

/** Periodic scan for the no_response trigger: we sent something that needs an answer and nothing came back. */
export async function scanNoResponse(): Promise<number> {
  let started = 0;
  const wfs = (await pool.query(`SELECT w.id, w.workspace_id, w.name, w.current_version, v.definition FROM workflows w JOIN workflow_versions v ON v.workflow_id=w.id AND v.version=w.current_version WHERE w.status='active' AND v.definition->'trigger'->>'type'='no_response'`)).rows;
  for (const wf of wfs) {
    const def = definitionSchema.parse(wf.definition); if (def.trigger.type !== 'no_response') continue;
    const t = def.trigger; const hours = await loadHours(pool, wf.workspace_id);
    if (t.businessHoursOnly && openState(hours, new Date()).state !== 'open') continue;
    const rows = (await pool.query(
      `SELECT cv.id, (SELECT m.id FROM messages m WHERE m.conversation_id=cv.id AND m.direction='outbound' AND m.sender_type IN ('staff','sandra') AND m.status NOT IN ('suppressed','failed') ORDER BY m.seq DESC LIMIT 1) AS last_out_id
       FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id
       WHERE cv.workspace_id=$1 AND cv.status='open' AND cv.responsibility='waiting_on_customer' AND cv.handling_mode='human' AND cv.last_outbound_at <= now() - ($2 || ' hours')::interval
         AND NOT ct.sms_opted_out AND NOT ct.do_not_text AND NOT ct.outbound_blocked`, [wf.workspace_id, String(t.afterHours)])).rows;
    for (const row of rows) {
      if (!row.last_out_id) continue;
      await tx(async (c) => {
        const x = await loadCtx(c, row.id, false);
        const last = (await c.query('SELECT body FROM messages WHERE id=$1', [row.last_out_id])).rows[0];
        if (t.requireQuestion && !last.body.includes('?')) return;
        if (!evalAll(def.conditions, x).pass) return;
        if (await startRun(c, wf, x, 'no_response', row.last_out_id, x.conv.last_inbound_at)) started++;
      });
    }
  }
  return started;
}

// ---------- the executor ----------
const FOLLOWUP_POLL_MIN = 60;
export async function advanceRun(runId: string): Promise<void> {
  await tx(async (c) => {
    const run = (await c.query('SELECT * FROM workflow_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    if (!run || !['waiting', 'running'].includes(run.status)) return;
    const wf = (await c.query('SELECT * FROM workflows WHERE id=$1', [run.workflow_id])).rows[0];
    const def = definitionSchema.parse((await c.query('SELECT definition FROM workflow_versions WHERE workflow_id=$1 AND version=$2', [run.workflow_id, run.version])).rows[0].definition);
    const prog = programOf(def);
    const log = (stepName: string, outcome: string, detail: string) => c.query('INSERT INTO workflow_run_log (run_id, step, outcome, detail) VALUES ($1,$2,$3,$4)', [runId, stepName, outcome, detail]);
    const timeline = (s: string) => c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'automation',$4)`, [run.workspace_id, run.contact_id, run.conversation_id, s]);
    const finish = async (status: 'completed' | 'stopped' | 'failed', reason: string | null, detail: string) => {
      await c.query(`UPDATE workflow_runs SET status=$2, stop_reason=$3, next_run_at=NULL, updated_at=now() WHERE id=$1`, [runId, status, reason]);
      await log('end', status, detail); if (status !== 'completed') await timeline(`Automation “${wf.name}” stopped: ${detail}`);
      await publish(c, run.workspace_id, 'conversation.updated', { conversationId: run.conversation_id });
    };
    /** Exactly ONE pending step-job per run: an existing one is re-timed (never duplicated, never dropped while a same-key job is running). */
    const schedule = async (at: Date, _why: string) => {
      await c.query(`UPDATE workflow_runs SET status='waiting', next_run_at=$2, pc=$3, updated_at=now() WHERE id=$1`, [runId, at, pc]);
      const pending = (await c.query(`SELECT id FROM jobs WHERE kind='workflow_step' AND status='pending' AND payload->>'runId'=$1 ORDER BY id FOR UPDATE`, [runId])).rows;
      if (pending.length) {
        await c.query(`UPDATE jobs SET run_at=$2 WHERE id=$1`, [pending[0].id, at]);
        if (pending.length > 1) await c.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE id = ANY($1::bigint[])`, [pending.slice(1).map((p: { id: number }) => p.id)]);
      } else await enqueue(c, 'workflow_step', { runId }, { runAt: at, workspaceId: run.workspace_id, dedupeKey: `${runId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` });
    };
    let pc = run.pc;

    if (wf.status !== 'active') { await c.query(`UPDATE workflow_runs SET status='waiting', next_run_at=NULL, updated_at=now() WHERE id=$1`, [runId]); await log('hold', 'paused', 'Automation is paused; this run is on hold and will continue when it is re-activated'); return; }

    for (let guard = 0; guard < 60; guard++) {
      const x = await loadCtx(c, run.conversation_id, true);
      const settings = await loadAutomationSettings(c, run.workspace_id);
      // ---- universal stop conditions, re-checked before EVERY step ----
      if (x.conv.global_automation_pause) { await schedule(new Date(Date.now() + 15 * 60_000), 'global pause'); await log('hold', 'paused', 'Global automation pause is on; will re-check in 15 minutes'); return; }
      if (x.contact.sms_opted_out || x.contact.do_not_text || x.contact.outbound_blocked) return finish('stopped', 'opted_out', 'the customer opted out or texting is blocked');
      if (x.conv.status === 'closed') return finish('stopped', 'conversation_closed', 'the conversation was closed');
      const baseIn = run.baseline_inbound_at ? new Date(run.baseline_inbound_at).getTime() : 0;
      if (x.conv.last_inbound_at && new Date(x.conv.last_inbound_at).getTime() > baseIn) return finish('stopped', 'customer_replied', `the customer wrote at ${new Date(x.conv.last_inbound_at).toISOString()} — pending steps cancelled`);
      const baseTk = run.baseline_takeover_at ? new Date(run.baseline_takeover_at).getTime() : 0;
      if (x.conv.last_takeover_at && new Date(x.conv.last_takeover_at).getTime() > baseTk) return finish('stopped', 'employee_takeover', 'an employee took over the conversation');
      if (x.contact.merged_into) return finish('stopped', 'contact_merged', 'the contact was merged into another record');

      const ins = prog[pc];
      switch (ins.op) {
        case 'end': return finish('completed', null, 'all steps finished');
        case 'jump': pc = ins.to; continue;
        case 'ifnot': { const r = evalCond(ins.cond, x); await log('branch', r.pass ? 'then' : 'else', `Checked ${r.why}: ${r.pass ? 'condition met → "then" path' : 'not met → "else" path'}`); pc = r.pass ? pc + 1 : ins.to; continue; }
        case 'wait': {
          let at = new Date(Date.now() + ins.minutes * 60_000);
          if (ins.bho) { const n = nextOpenAt(x.hours, at); if (!n) return finish('failed', 'no_business_hours', 'business hours are not configured, cannot wait for business hours'); at = n; }
          pc += 1; await schedule(at, 'wait'); await log('wait', 'scheduled', `Waiting ${describe(ins).replace('wait ', '')} — next step at ${at.toISOString()}`); return;
        }
        case 'tag': { await c.query(`UPDATE conversations SET tags = CASE WHEN $2 = ANY(tags) THEN tags ELSE array_append(tags,$2) END WHERE id=$1`, [run.conversation_id, ins.tag]); await log('add_tag', 'done', `Added tag “${ins.tag}”`); pc += 1; continue; }
        case 'resp': { await c.query('UPDATE conversations SET responsibility=$2 WHERE id=$1', [run.conversation_id, ins.state]); await log('set_responsibility', 'done', `Marked ${ins.state.replaceAll('_', ' ')}`); pc += 1; continue; }
        case 'assign': { await c.query('UPDATE conversations SET assignee_user_id=$2 WHERE id=$1', [run.conversation_id, ins.userId]); await log('assign', 'done', 'Assigned the conversation'); pc += 1; continue; }
        case 'notify': { const to = ins.s.userId ? [ins.s.userId] : await recipientsForConversation(c, run.conversation_id); await notify(c, { workspaceId: run.workspace_id, userIds: to, type: 'automation', title: ins.s.message, conversationId: run.conversation_id }); await log('notify_staff', 'done', `Notified ${to.length} staff member(s): ${ins.s.message}`); pc += 1; continue; }
        case 'task': {
          const assignee = ins.s.assigneeId ?? x.conv.assignee_user_id;
          if (!assignee) { await log('create_task', 'skipped', 'No assignee on the step or conversation; task not created'); pc += 1; continue; }
          const created = (await c.query(`INSERT INTO tasks (workspace_id, title, assignee_user_id, created_by, due_at, contact_id, conversation_id) VALUES ($1,$2,$3,$3,$4,$5,$6) RETURNING id`, [run.workspace_id, ins.s.title, assignee, ins.s.dueInHours ? new Date(Date.now() + ins.s.dueInHours * 3600_000) : null, run.contact_id, run.conversation_id])).rows[0];
          await notify(c, { workspaceId: run.workspace_id, userIds: [assignee], type: 'task_assigned', title: `New task: ${ins.s.title}`, conversationId: run.conversation_id, refId: created.id });
          await log('create_task', 'done', `Created task “${ins.s.title}”`); pc += 1; continue;
        }
        case 'send': {
          const s = ins.s; const isFollowUp = s.kind === 'follow_up';
          if (x.conv.handling_mode !== 'human') return finish('stopped', `handling_mode_${x.conv.handling_mode}`, `handling mode is “${x.conv.handling_mode}”, automation does not send`);
          // ---- THE FOLLOW-UP RULE ----
          if (isFollowUp) {
            if (x.conv.responsibility === 'waiting_on_staff' || x.conv.responsibility === 'needs_our_reply') {
              // We owe the customer something. Customer follow-ups are paused; remind, then escalate, the assigned employee.
              const since = run.staff_wait_since ? new Date(run.staff_wait_since) : new Date();
              const remindMs = def.limits.staffWaitReminderHours * 3600_000, escMs = def.limits.staffWaitEscalateHours * 3600_000;
              const detail = 'Customer follow-up is ON HOLD: Sun Sport Marine owes the customer a response or information';
              if (!run.staff_wait_since) { await c.query('UPDATE workflow_runs SET staff_wait_since=now() WHERE id=$1', [runId]); run.staff_wait_since = new Date(); await log('follow_up', 'held', detail); }
              if (!run.staff_wait_reminded_at && Date.now() - since.getTime() >= remindMs) {
                const to = await recipientsForConversation(c, run.conversation_id);
                await notify(c, { workspaceId: run.workspace_id, userIds: to, type: 'staff_wait_reminder', title: 'Customer follow-up is paused because we owe them a reply', conversationId: run.conversation_id });
                await c.query('UPDATE workflow_runs SET staff_wait_reminded_at=now() WHERE id=$1', [runId]); run.staff_wait_reminded_at = new Date(); await log('follow_up', 'reminded', `Reminded ${to.length} assigned staff member(s) that the customer is waiting on us`);
              }
              if (!run.staff_wait_escalated_at && Date.now() - since.getTime() >= escMs) {
                const mgrs = (await c.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','admin','manager')`, [run.workspace_id])).rows.map((r) => r.user_id);
                await notify(c, { workspaceId: run.workspace_id, userIds: mgrs, type: 'staff_wait_escalation', title: `Escalation: a customer has been waiting on staff for ${def.limits.staffWaitEscalateHours}h`, conversationId: run.conversation_id });
                await c.query('UPDATE workflow_runs SET staff_wait_escalated_at=now() WHERE id=$1', [runId]); await log('follow_up', 'escalated', 'Escalated to managers: still waiting on staff'); await timeline('Customer follow-up on hold; escalated to managers');
              }
              const poll = Math.min(FOLLOWUP_POLL_MIN, Math.max(1, def.limits.staffWaitReminderHours * 60 / 2));
              await schedule(new Date(Date.now() + poll * 60_000), 'staff wait'); return;
            }
            if (x.conv.responsibility === 'scheduled') { await schedule(new Date(Date.now() + FOLLOWUP_POLL_MIN * 60_000), 'scheduled'); await log('follow_up', 'held', 'A staff message is scheduled; holding the follow-up'); return; }
            if (run.staff_wait_since) { await c.query('UPDATE workflow_runs SET staff_wait_since=NULL, staff_wait_reminded_at=NULL, staff_wait_escalated_at=NULL WHERE id=$1', [runId]); run.staff_wait_since = null; await log('follow_up', 'resumed', 'Staff responded; follow-up is eligible again'); }
            if (s.requireQuestion) {
              const lastOut = (await c.query(`SELECT body FROM messages WHERE conversation_id=$1 AND direction='outbound' AND sender_type='staff' AND status NOT IN ('suppressed','failed') ORDER BY seq DESC LIMIT 1`, [run.conversation_id])).rows[0];
              if (!lastOut?.body.includes('?')) { await log('send_message', 'skipped', 'Our last message did not ask the customer anything, so no follow-up is needed'); pc += 1; continue; }
            }
          }
          // ---- quiet hours (wall-clock, DST-safe) ----
          if (def.limits.respectQuietHours) {
            const end = quietHoursEnd(new Date(), x.hours.tz, settings.quiet_start_hour, settings.quiet_end_hour);
            if (end) { await schedule(end, 'quiet hours'); await log('send_message', 'deferred', `Quiet hours (${settings.quiet_start_hour}:00–${settings.quiet_end_hour}:00 ${x.hours.tz}): deferred to ${end.toISOString()}`); return; }
          }
          // ---- frequency limit ----
          const sent24 = (await c.query(`SELECT count(*)::int n FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.contact_id=$1 AND m.auto_kind IN ('follow_up','workflow') AND m.status<>'suppressed' AND m.created_at > now() - interval '24 hours'`, [run.contact_id])).rows[0].n;
          if (sent24 >= def.limits.maxSendsPerContactPerDay) return finish('stopped', 'frequency_limit', `frequency limit reached (${def.limits.maxSendsPerContactPerDay} automated texts per customer per 24h)`);
          let bodyTpl = s.body;
          if (!bodyTpl && s.templateId) bodyTpl = (await c.query(`SELECT tv.body FROM templates t JOIN template_versions tv ON tv.template_id=t.id AND tv.version=t.current_version WHERE t.id=$1 AND t.workspace_id=$2 AND t.is_active`, [s.templateId, run.workspace_id])).rows[0]?.body;
          if (!bodyTpl) return finish('failed', 'no_message', 'the send step has no message (template missing or inactive)');
          const { text, missing } = render(bodyTpl, await automationVars(run.workspace_id, run.contact_id));
          if (missing.length) return finish('stopped', 'missing_details', `message needs details we don't have: ${missing.join(', ')}`);
          const r = await queueOutboundTx(c, { workspaceId: run.workspace_id, conversationId: run.conversation_id, body: text, senderType: 'automation', purpose: 'conversational', idempotencyKey: `wf:${runId}:${pc}`, expectedRevision: x.conv.revision, autoKind: isFollowUp ? 'follow_up' : 'workflow', passive: isFollowUp ? false : !s.expectsReply });
          if (!r.ok) return finish('stopped', r.reason, `send refused by the delivery pipeline: ${r.reason.replaceAll('_', ' ')}`);
          await log('send_message', 'sent', `${isFollowUp ? 'Customer follow-up' : 'Message'} queued for delivery: “${text.slice(0, 80)}”`); await timeline(`Automation “${wf.name}” sent a ${isFollowUp ? 'follow-up' : 'message'}`);
          pc += 1; continue;
        }
      }
    }
    await finish('failed', 'step_limit', 'too many steps executed in one pass (loop protection)');
  });
}

// ---------- dry-run: what WOULD happen, without doing anything ----------
export async function dryRun(a: Actor, definition: unknown, conversationId?: string) {
  const def = definitionSchema.parse(definition); const prog = programOf(def);
  const plan: { at: string; step: string; result: string; blocked?: boolean }[] = []; const notes: string[] = [];
  const adapter = TRIGGER_ADAPTERS[def.trigger.type];
  if (!adapter.verified) notes.push(`Trigger "${def.trigger.type}" cannot be activated yet: ${adapter.note}`);
  let x: Ctx | null = null; let virtual = new Date();
  if (conversationId) {
    await requireConversation(pool, a, conversationId);
    const c = await pool.connect(); try { x = await loadCtx(c, conversationId, false); } finally { c.release(); }
    const ev = evalAll(def.conditions, x);
    notes.push(...(def.conditions.length ? ev.details.map((d) => `Condition ${d.pass ? 'met' : 'NOT met'}: ${d.why}`) : ['No conditions: applies to every matching trigger']));
    if (!ev.pass) { return { plan, notes: [...notes, 'The conditions are not met for this conversation, so the automation would not start.'], conditionsMet: false }; }
    notes.push('Simulation assumes the conversation stays in its current state; real runs re-check every step and stop if the customer replies, an employee takes over, or the thread closes.');
  } else notes.push('No conversation selected: conditions and live state are not evaluated.');
  const settings = conversationId ? await loadAutomationSettings(pool, a.workspaceId) : null; const hours = await loadHours(pool, a.workspaceId);
  let pc = 0; let sends = 0;
  for (let guard = 0; guard < 80 && pc < prog.length; guard++) {
    const i = prog[pc]; const at = virtual.toISOString();
    switch (i.op) {
      case 'end': plan.push({ at, step: 'finish', result: 'Run completes' }); return { plan, notes, conditionsMet: true };
      case 'jump': pc = i.to; continue;
      case 'ifnot': if (x) { const r = evalCond(i.cond, x); plan.push({ at, step: 'branch', result: `${r.why} → ${r.pass ? '"then" path' : '"else" path'}` }); pc = r.pass ? pc + 1 : i.to; } else { plan.push({ at, step: 'branch', result: `would check ${i.cond.field}; evaluating the "then" path in this preview` }); pc += 1; } continue;
      case 'wait': { virtual = new Date(virtual.getTime() + i.minutes * 60_000); if (i.bho) { const n = nextOpenAt(hours, virtual); if (!n) { plan.push({ at, step: 'wait', result: 'BLOCKED: business hours are not configured', blocked: true }); return { plan, notes, conditionsMet: true }; } virtual = n; } plan.push({ at, step: 'wait', result: `${describe(i)} → resumes ${virtual.toISOString()}` }); pc += 1; continue; }
      case 'send': {
        let blocked: string | null = null;
        if (x && x.conv.handling_mode !== 'human') blocked = `handling mode is “${x.conv.handling_mode}”`;
        else if (x && i.s.kind === 'follow_up' && ['waiting_on_staff', 'needs_our_reply'].includes(x.conv.responsibility)) blocked = `we currently owe the customer a reply (“${x.conv.responsibility.replaceAll('_', ' ')}”): follow-up would be HELD and the assigned employee reminded after ${def.limits.staffWaitReminderHours}h, escalated after ${def.limits.staffWaitEscalateHours}h`;
        else if (x && (x.contact.sms_opted_out || x.contact.do_not_text || x.contact.outbound_blocked)) blocked = 'the customer cannot be texted';
        const q = def.limits.respectQuietHours && settings ? quietHoursEnd(virtual, hours.tz, settings.quiet_start_hour, settings.quiet_end_hour) : null;
        if (!blocked && q) { plan.push({ at, step: 'send', result: `Quiet hours: would be deferred to ${q.toISOString()}` }); virtual = q; }
        if (!blocked && ++sends > def.limits.maxSendsPerContactPerDay) blocked = `frequency limit (${def.limits.maxSendsPerContactPerDay}/day) would stop the run`;
        plan.push({ at: virtual.toISOString(), step: 'send_message', result: blocked ? `Would NOT send — ${blocked}` : `Would send ${i.s.kind === 'follow_up' ? 'follow-up' : 'message'}: “${(i.s.body ?? '(template)').slice(0, 100)}”`, blocked: !!blocked });
        if (blocked) return { plan, notes, conditionsMet: true }; pc += 1; continue;
      }
      default: plan.push({ at, step: i.op, result: `Would ${describe(i)}` }); pc += 1;
    }
  }
  return { plan, notes, conditionsMet: true };
}

/** Called by inventory imports: emit events only for real price drops / returns to available. */
export async function emitInventoryChanges(workspaceId: string, changes: { boatId: string; change: 'price_drop' | 'back_available' | 'new' }[]) {
  for (const ch of changes) await enqueue(pool, 'workflow_event', { type: 'inventory_update', boatId: ch.boatId, change: ch.change, stamp: String(Date.now()), workspaceId }, { workspaceId, dedupeKey: `inv:${ch.boatId}:${Date.now()}` });
}
export async function scheduleWorkflowScan() { await enqueue(pool, 'workflow_scan', {}, { runAt: new Date(Date.now() + 300_000), dedupeKey: 'scan' }); }
