import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as reg from '../skills/registry.ts';
import * as wf from '../skills/workflow.ts';
import * as T from '../triggers.ts';
import { chicagoInstant as ci } from '../tz.ts';
import { setPaused } from '../pause.ts';
import { emergencyStop } from '../emergency.ts';
import { createTask, completeTask } from '../tasks.ts';
import * as memory from '../memory.ts';

const H = 3_600_000;
function live(db: any, name = 'Morning look') { reg.grant(db, 'jarvis', 'tasks.list_open', 'luke'); const id = wf.save(db, name, [{ skill: 'tasks.list_open', input: {} }], 'luke'); wf.setStatus(db, id, 'active', 'luke'); return id; }
const rows = (db: any, sql: string) => db.prepare(sql).all() as any[];

test('next run: daily at a Central time stays at that wall-clock time across daylight saving; weekdays are respected; intervals; events have none', () => {
  const eight = { kind: 'daily' as const, time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] };
  assert.equal(T.nextRun(eight, ci(2026, 10, 31, 7, 0)), ci(2026, 10, 31, 8, 0)); assert.equal(T.nextRun(eight, ci(2026, 10, 31, 8, 0)), ci(2026, 11, 1, 8, 0), 'strictly after');
  assert.equal(T.nextRun(eight, ci(2026, 11, 1, 9, 0)), ci(2026, 11, 2, 8, 0), 'clocks went back on Nov 1; still 8 am');
  const mon = { kind: 'daily' as const, time: '09:30', days: [1] }; assert.equal(new Date(T.nextRun(mon, ci(2026, 10, 20, 12, 0))!).getUTCDay() === 1, true);
  assert.equal(T.nextRun({ kind: 'interval', everyMinutes: 30 }, 1000), 1000 + 30 * 60_000); assert.equal(T.nextRun({ kind: 'event', event: 'memory_added' }, 1000), null);
  assert.equal(T.describe(eight), 'Every day at 08:00 Central'); assert.equal(T.describe(mon), 'Mon at 09:30 Central'); assert.match(T.describe({ kind: 'event', event: 'task_completed' }), /one of your tasks is completed/);
});

test('creating a schedule: only for a workflow you switched on that Jarvis can really run; bad times and too-frequent runs refused; at most ten', () => {
  const db = makeDb(); const w = live(db); const spec = { kind: 'daily', time: '08:00' };
  assert.ok(T.create(db, { workflowId: w, spec }, ci(2026, 10, 19, 12, 0)));
  for (const bad of [{ workflowId: w, spec: { kind: 'daily', time: '25:00' } }, { workflowId: w, spec: { kind: 'interval', everyMinutes: 5 } }, { workflowId: w, spec: { kind: 'interval', everyMinutes: 99999 } }, { workflowId: w, spec: { kind: 'event', event: 'made_up' } }, { workflowId: w, spec, extra: 1 }, { workflowId: w, spec: { kind: 'daily', time: '08:00', days: [] } }]) assert.throws(() => T.create(db, bad as any), (e: Error) => !!e.message, JSON.stringify(bad));
  assert.throws(() => T.create(db, { workflowId: 'nope', spec }), /No such workflow/);
  const staged = wf.save(db, 'Staged one', [{ skill: 'tasks.list_open', input: {} }], 'luke'); assert.throws(() => T.create(db, { workflowId: staged, spec }), /switch the workflow on first/i);
  const web = wf.save(db, 'Web one', [{ skill: 'research.fetch_pages', input: {} }], 'luke'); wf.setStatus(db, web, 'active', 'luke'); assert.throws(() => T.create(db, { workflowId: web, spec }), /could not run this workflow on its own/, 'a chain the runner will not execute can never be scheduled');
  for (let i = 0; i < 9; i++) T.create(db, { workflowId: w, spec: { kind: 'interval', everyMinutes: 60 } }); assert.throws(() => T.create(db, { workflowId: w, spec }), /up to 10/);
});

test('schedule firing: runs on time as Jarvis, logs it, schedules the next, notifies only if asked; nothing before its time; a long outage skips instead of catching up; paused and Stop everything stop it', async () => {
  const db = makeDb(); const w = live(db); const t0 = ci(2026, 10, 19, 7, 0);
  const tid = T.create(db, { workflowId: w, spec: { kind: 'daily', time: '08:00' }, notify: true }, t0);
  assert.equal(await T.tick(db, ci(2026, 10, 19, 7, 59)), 0); const first = await T.tick(db, ci(2026, 10, 19, 8, 1)); assert.equal(first, 1); assert.equal(await T.tick(db, ci(2026, 10, 19, 8, 2)), 0, 'once');
  const t = T.list(db)[0]; assert.equal(t.lastOk, true); assert.equal(t.nextRunAt, ci(2026, 10, 20, 8, 0)); assert.equal(rows(db, "SELECT * FROM workflow_runs WHERE ok=1").length, 1); assert.equal(rows(db, "SELECT * FROM workflow_runs")[0].principal, 'jarvis');
  assert.ok(T.log(db, tid).some((l: any) => l.kind === 'ran')); assert.equal(rows(db, "SELECT * FROM notifications WHERE kind='workflow'").length, 1);
  assert.equal(await T.tick(db, ci(2026, 10, 20, 12, 0)), 0, 'Jarvis was off at 8; four hours late is skipped, not caught up'); assert.ok(T.log(db, tid).some((l: any) => l.kind === 'skipped' && /missed/.test(l.summary))); assert.equal(T.list(db)[0].nextRunAt, ci(2026, 10, 21, 8, 0));
  assert.equal(await T.tick(db, ci(2026, 10, 21, 9, 30)), 1, 'under two hours late is caught up');
  setPaused(db, true); assert.equal(await T.tick(db, ci(2026, 10, 22, 8, 1)), 0, 'paused: nothing runs'); setPaused(db, false);
  const quiet = T.create(db, { workflowId: w, spec: { kind: 'daily', time: '10:00' } }, ci(2026, 10, 22, 7, 0)); await T.tick(db, ci(2026, 10, 22, 10, 1)); assert.equal(rows(db, "SELECT * FROM notifications WHERE kind='workflow'").length, 2, 'the two runs that asked for one; the quiet schedule adds none'); void quiet;
  const stop = emergencyStop(db, ci(2026, 10, 22, 11, 0)); assert.ok(stop.schedulesOff >= 2); assert.ok(T.list(db).every((x) => !x.enabled && /Stop everything/.test(x.disabledReason ?? '')));
});

test('safety: three failures in a row switch it off; the daily limit holds; a changed permission stops a run; enabling again resets; removing deletes the log', async () => {
  const db = makeDb(); const w = live(db); const t0 = ci(2026, 10, 19, 0, 0);
  const tid = T.create(db, { workflowId: w, spec: { kind: 'interval', everyMinutes: 15 } }, t0); let n = 0;
  for (let i = 1; i <= 95; i++) n += await T.tick(db, t0 + i * 15 * 60_000);   // a whole day of 15-minute slots
  assert.equal(n, T.PER_DAY, 'no more than the daily limit'); assert.ok(T.log(db, tid).some((l: any) => /daily limit/.test(l.summary)));
  const db2 = makeDb(); const w2 = live(db2); const id2 = T.create(db2, { workflowId: w2, spec: { kind: 'interval', everyMinutes: 15 } }, t0); reg.revoke(db2, 'jarvis', 'tasks.list_open');
  for (let i = 1; i <= 4; i++) await T.tick(db2, t0 + i * 15 * 60_000); const x = T.list(db2)[0]; assert.equal(x.enabled, false); assert.match(x.disabledReason!, /3 failures in a row/); assert.equal(x.failStreak, 3); assert.equal(rows(db2, "SELECT * FROM workflow_runs WHERE ok=0").length, 3, 'a revoked permission is respected at run time');
  assert.ok(rows(db2, "SELECT * FROM audit WHERE action='trigger.auto_disabled'").length === 1); reg.grant(db2, 'jarvis', 'tasks.list_open', 'luke'); assert.ok(T.setEnabled(db2, id2, true, t0 + 10 * H)); assert.equal(T.list(db2)[0].failStreak, 0);
  assert.ok(T.remove(db2, id2)); assert.equal(T.log(db2, id2).length, 0); assert.equal(T.list(db2).length, 0);
});

test('event triggers: fire when something happened since the last look, then wait out a cooldown; only your own completed tasks, finished missions, new memories count', async () => {
  const db = makeDb(); const w = live(db); const t0 = Date.now() - 60 * 60_000;
  const tid = T.create(db, { workflowId: w, spec: { kind: 'event', event: 'task_completed' } }, t0); assert.equal(await T.tick(db, t0 + 1000), 0, 'nothing happened yet');
  const task = createTask(db, { title: 'Do thing', owner: 'luke' }); completeTask(db, task, 'test', 'done'); assert.equal(await T.tick(db, Date.now()), 1); assert.equal(await T.tick(db, Date.now() + 2000), 0, 'the same event does not fire twice'); await new Promise((r) => setTimeout(r, 15));
  const t2 = createTask(db, { title: 'Another', owner: 'luke' }); completeTask(db, t2, 'test', 'done'); assert.equal(await T.tick(db, Date.now() + 60_000), 0, 'cooldown of five minutes'); assert.equal(await T.tick(db, Date.now() + 6 * 60_000), 1, 'after the cooldown the second completion fires');
  const mem = T.create(db, { workflowId: w, spec: { kind: 'event', event: 'memory_added' } }, Date.now() - 1000); memory.remember(db, 'A new fact', { source: 't' }); assert.ok((await T.tick(db, Date.now() + 10 * 60_000)) >= 1); void tid; void mem;
});
