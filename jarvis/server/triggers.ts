import { z } from 'zod';
import { type DB, id } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { isPaused } from './pause.ts';
import { chicagoParts, chicagoInstant, addDays } from './tz.ts';
import * as workflow from './skills/workflow.ts';
import { render } from './skills/router.ts';
import { enqueue } from './notify.ts';

/**
 * Triggers and schedules for workflows. A trigger only ever runs a workflow Luke has already switched on, as Jarvis, through the same
 * runner and the same checks as a manual run (re-validated every time). Creating or enabling one needs a fresh step-up because it makes
 * something run unattended; switching one off never does. Built-in limits: at most 10 triggers, nothing more often than every 15 minutes,
 * 24 runs a day each and 100 a day in total, three failures in a row switches it off, a missed time is skipped (or caught up only if
 * Jarvis was off for under two hours), and Pause and "Stop everything" stop all of them.
 */
export const MAX_TRIGGERS = 10, MIN_EVERY = 15, PER_DAY = 24, TOTAL_PER_DAY = 100, CATCH_UP_MS = 2 * 3_600_000, EVENT_COOLDOWN_MS = 5 * 60_000, MAX_FAILS = 3;
export const EVENTS = { task_completed: 'one of your tasks is completed', mission_done: 'a research mission finishes', memory_added: 'a new memory is saved' } as const;
const spec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]) }).strict(),
  z.object({ kind: z.literal('interval'), everyMinutes: z.number().int().min(MIN_EVERY).max(1440) }).strict(),
  z.object({ kind: z.literal('event'), event: z.enum(Object.keys(EVENTS) as [keyof typeof EVENTS, ...(keyof typeof EVENTS)[]]) }).strict(),
]);
export type Spec = z.infer<typeof spec>;
const createIn = z.object({ workflowId: z.string().min(1).max(60), spec, notify: z.boolean().default(false) }).strict();
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const describe = (s: Spec) => s.kind === 'daily' ? `${s.days.length === 7 ? 'Every day' : s.days.map((d) => DAYS[d]).join(', ')} at ${s.time} Central` : s.kind === 'interval' ? `Every ${s.everyMinutes % 60 === 0 ? `${s.everyMinutes / 60} hour${s.everyMinutes === 60 ? '' : 's'}` : `${s.everyMinutes} minutes`}` : `When ${EVENTS[s.event]}`;

/** The next scheduled instant strictly after `after`, in Chicago wall-clock time (correct across daylight saving). */
export function nextRun(s: Spec, after: number): number | null {
  if (s.kind === 'interval') return after + s.everyMinutes * 60_000;
  if (s.kind === 'event') return null;
  const [hh, mm] = s.time.split(':').map(Number), p = chicagoParts(after);
  for (let n = 0; n <= 8; n++) { const d = addDays(p.y, p.m, p.d, n); if (!s.days.includes(d.dow)) continue; const t = chicagoInstant(d.y, d.m, d.d, hh, mm); if (t > after) return t; }
  return null;
}
const hydrate = (r: any) => ({ id: r.id, workflowId: r.workflow_id, workflowName: r.name ?? null, spec: JSON.parse(r.spec) as Spec, when: describe(JSON.parse(r.spec)), notify: !!r.notify, enabled: !!r.enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastOk: r.last_ok == null ? null : !!r.last_ok, failStreak: r.fail_streak, disabledReason: r.disabled_reason, createdAt: r.created_at });
export const list = (db: DB) => (db.prepare('SELECT t.*, w.name FROM workflow_triggers t LEFT JOIN skill_workflows w ON w.id=t.workflow_id ORDER BY t.created_at DESC').all() as any[]).map(hydrate);
export const log = (db: DB, tid: string) => db.prepare('SELECT at,kind,ok,summary FROM trigger_log WHERE trigger_id=? ORDER BY id DESC LIMIT 15').all(tid);
const note = (db: DB, tid: string, kind: string, ok: boolean, summary = '', now = Date.now()) => db.prepare('INSERT INTO trigger_log(trigger_id,at,kind,ok,summary) VALUES(?,?,?,?,?)').run(tid, now, kind, ok ? 1 : 0, summary.slice(0, 300));

export function create(db: DB, raw: unknown, now = Date.now()) {
  const v = createIn.parse(raw); const w = db.prepare('SELECT id,status FROM skill_workflows WHERE id=?').get(v.workflowId) as { id: string; status: string } | undefined;
  if (!w) throw new Error('No such workflow.'); if (w.status !== 'active') throw new Error('Switch the workflow on first; a schedule only ever runs a workflow you have already activated.');
  const chk = workflow.validate(db, JSON.parse((db.prepare('SELECT steps FROM skill_workflows WHERE id=?').get(v.workflowId) as any).steps), 'jarvis'); if (!chk.ok || !chk.effective?.runnable) throw new Error(`Jarvis could not run this workflow on its own: ${chk.violations[0] ?? 'it includes steps the runner will not execute'}.`);
  if (chk.effective.sideEffects !== 'none' && chk.effective.sideEffects !== 'internal_write') throw new Error('Only workflows that read or make small internal changes can run on a schedule.');
  if ((db.prepare('SELECT COUNT(*) c FROM workflow_triggers').get() as any).c >= MAX_TRIGGERS) throw new Error(`You can have up to ${MAX_TRIGGERS} schedules.`);
  const tid = id(); db.prepare('INSERT INTO workflow_triggers(id,workflow_id,spec,notify,next_run_at,cursor_ms,created_at) VALUES(?,?,?,?,?,?,?)').run(tid, v.workflowId, JSON.stringify(v.spec), v.notify ? 1 : 0, nextRun(v.spec, now), now, now);
  note(db, tid, 'created', true, describe(v.spec), now); audit(db, 'luke', 'trigger.created', tid, { workflow: v.workflowId, when: describe(v.spec) }); publish({ type: 'triggers' }); return tid;
}
export function setEnabled(db: DB, tid: string, on: boolean, now = Date.now()) {
  const r = db.prepare('SELECT spec FROM workflow_triggers WHERE id=?').get(tid) as { spec: string } | undefined; if (!r) return false;
  db.prepare('UPDATE workflow_triggers SET enabled=?, disabled_reason=NULL, fail_streak=0, next_run_at=?, cursor_ms=? WHERE id=?').run(on ? 1 : 0, on ? nextRun(JSON.parse(r.spec), now) : null, now, tid);
  note(db, tid, on ? 'enabled' : 'disabled', true, '', now); audit(db, 'luke', on ? 'trigger.enabled' : 'trigger.disabled', tid); publish({ type: 'triggers' }); return true;
}
export function remove(db: DB, tid: string) { const r = db.prepare('DELETE FROM workflow_triggers WHERE id=?').run(tid); if (r.changes) { db.prepare('DELETE FROM trigger_log WHERE trigger_id=?').run(tid); audit(db, 'luke', 'trigger.removed', tid); publish({ type: 'triggers' }); } return r.changes > 0; }
/** "Stop everything" and similar: nothing scheduled may run until Luke switches each one back on. */
export function disableAll(db: DB, reason: string, now = Date.now()) {
  const rows = db.prepare('SELECT id FROM workflow_triggers WHERE enabled=1').all() as { id: string }[];
  for (const r of rows) { db.prepare('UPDATE workflow_triggers SET enabled=0, next_run_at=NULL, disabled_reason=? WHERE id=?').run(reason, r.id); note(db, r.id, 'disabled', true, reason, now); }
  if (rows.length) { audit(db, 'system', 'trigger.disabled_all', '', { n: rows.length, reason }); publish({ type: 'triggers' }); } return rows.length;
}

const iso = (ms: number) => new Date(ms).toISOString();
function eventHappened(db: DB, ev: keyof typeof EVENTS, since: number): boolean {
  const n = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p as any[]) as any).c) > 0;
  if (ev === 'task_completed') return n("SELECT COUNT(*) c FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state='completed' AND completed_at>?", iso(since));
  if (ev === 'mission_done') return n("SELECT COUNT(*) c FROM missions WHERE status='done' AND finished_at>?", since);
  return n('SELECT COUNT(*) c FROM memories WHERE superseded_by IS NULL AND created_at>?', iso(since));
}
const firedToday = (db: DB, tid: string | null, now: number) => { const p = chicagoParts(now), start = chicagoInstant(p.y, p.m, p.d, 0, 0); return Number((db.prepare(tid ? "SELECT COUNT(*) c FROM trigger_log WHERE trigger_id=? AND kind IN ('ran','failed') AND at>=?" : "SELECT COUNT(*) c FROM trigger_log WHERE kind IN ('ran','failed') AND at>=?").get(...(tid ? [tid, start] : [start]) as any[]) as any).c); };

async function fire(db: DB, t: any, why: string, now: number) {
  const w = db.prepare('SELECT name FROM skill_workflows WHERE id=?').get(t.workflow_id) as { name: string } | undefined;
  const r = w ? await workflow.run(db, 'jarvis', t.workflow_id, now) : ({ ok: false, error: 'the workflow no longer exists', outputs: [] } as const);
  const summary = r.ok ? render(r.outputs[r.outputs.length - 1]).slice(0, 280) : r.error;
  note(db, t.id, r.ok ? 'ran' : 'failed', r.ok, `${why}: ${summary}`, now);
  const streak = r.ok ? 0 : t.fail_streak + 1;
  db.prepare('UPDATE workflow_triggers SET last_run_at=?, last_ok=?, fail_streak=?, next_run_at=? WHERE id=?').run(now, r.ok ? 1 : 0, streak, nextRun(JSON.parse(t.spec), now), t.id);
  if (r.ok && t.notify && w) enqueue(db, { key: `trigger:${t.id}:${now}`, kind: 'workflow', title: `Ran: ${w.name}`, body: render(r.outputs[r.outputs.length - 1]).slice(0, 400), link: '#/skills', dueAt: now }, now);
  if (streak >= MAX_FAILS) { db.prepare('UPDATE workflow_triggers SET enabled=0, next_run_at=NULL, disabled_reason=? WHERE id=?').run(`Switched off after ${MAX_FAILS} failures in a row. Last: ${String(summary).slice(0, 120)}`, t.id); note(db, t.id, 'disabled', false, 'three failures in a row', now); audit(db, 'system', 'trigger.auto_disabled', t.id, { workflow: t.workflow_id }); }
  audit(db, 'system', 'trigger.fired', t.id, { ok: r.ok, why }); publish({ type: 'triggers' });
}

let busy = false;
/** Called from the 30-second tick. Cheap when nothing is due. Never throws. */
export async function tick(db: DB, now = Date.now()): Promise<number> {
  if (busy || isPaused(db)) return 0; busy = true; let fired = 0;
  try {
    for (const t of db.prepare('SELECT * FROM workflow_triggers WHERE enabled=1').all() as any[]) {
      const s = JSON.parse(t.spec) as Spec;
      if (s.kind === 'event') {
        if (t.last_run_at && now - t.last_run_at < EVENT_COOLDOWN_MS) continue; if (!eventHappened(db, s.event, t.cursor_ms)) continue;
        if (firedToday(db, t.id, now) >= PER_DAY || firedToday(db, null, now) >= TOTAL_PER_DAY) { db.prepare('UPDATE workflow_triggers SET cursor_ms=? WHERE id=?').run(now, t.id); note(db, t.id, 'skipped', true, 'daily limit reached', now); continue; }
        db.prepare('UPDATE workflow_triggers SET cursor_ms=? WHERE id=?').run(now, t.id); await fire(db, t, `because ${EVENTS[s.event]}`, now); fired++; continue;
      }
      if (t.next_run_at == null || t.next_run_at > now) continue;
      if (now - t.next_run_at > CATCH_UP_MS && s.kind === 'daily') { note(db, t.id, 'skipped', true, 'missed: Jarvis was not running at that time', now); db.prepare('UPDATE workflow_triggers SET next_run_at=? WHERE id=?').run(nextRun(s, now), t.id); continue; }
      if (firedToday(db, t.id, now) >= PER_DAY || firedToday(db, null, now) >= TOTAL_PER_DAY) { note(db, t.id, 'skipped', true, 'daily limit reached', now); db.prepare('UPDATE workflow_triggers SET next_run_at=? WHERE id=?').run(nextRun(s, now), t.id); continue; }
      await fire(db, t, 'on schedule', now); fired++;
    }
  } finally { busy = false; }
  return fired;
}
