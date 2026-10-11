import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as ms from '../milestones.ts';
import { createTask, completeTask, cancelTask } from '../tasks.ts';
import { buildBriefing } from '../today.ts';
import { seedDemo, removeDemo } from '../seed.ts';

const DAY = 86400_000, T0 = Date.UTC(2026, 9, 12, 15);
const proj = (db: any, id = 'p1', demo = 0) => { db.prepare("INSERT INTO projects(id,title,scope,is_demo,created_at) VALUES(?,?,?,?,?)").run(id, `Project ${id}`, 'personal', demo, 'x'); return id; };

test('progress is evidence-based and never a percentage; no milestones means "cannot be measured"', () => {
  const db = makeDb(); const p = proj(db);
  let d = ms.projectDetail(db, p, T0)!;
  assert.equal(d.progress.health, 'no_plan'); assert.match(d.progress.label, /cannot be measured/);
  const a = ms.createMilestone(db, { projectId: p, title: 'A' }), b = ms.createMilestone(db, { projectId: p, title: 'B' }); ms.createMilestone(db, { projectId: p, title: 'C' });
  ms.completeMilestone(db, a, { evidence: 'Signed contract on file, PDF in Drive' }); ms.cancelMilestone(db, b);
  d = ms.projectDetail(db, p, T0)!;
  assert.equal(d.progress.label, '1 of 2 milestones complete');            // canceled work is not counted
  assert.ok(!/%/.test(JSON.stringify(d.progress)), 'no percentage anywhere'); assert.equal(d.progress.withEvidence, 1);
});

test('completing a milestone requires evidence: finished linked tasks, or Luke\'s written proof', () => {
  const db = makeDb(); const p = proj(db); const m = ms.createMilestone(db, { projectId: p, title: 'Ship v1' });
  assert.throws(() => ms.completeMilestone(db, m, {}), /Evidence required/);
  assert.throws(() => ms.completeMilestone(db, m, { evidence: 'done' }), /Evidence required/);       // too thin to count
  const t1 = createTask(db, { title: 'Build', projectId: p, milestoneId: m }), t2 = createTask(db, { title: 'Test', projectId: p, milestoneId: m });
  completeTask(db, t1, 'luke', 'ok');
  assert.equal(ms.projectDetail(db, p, T0)!.milestones[0].status, 'in_progress');
  assert.throws(() => ms.completeMilestone(db, m, {}), /Evidence required/);                          // one task still open
  completeTask(db, t2, 'luke', 'ok');
  assert.equal(ms.projectDetail(db, p, T0)!.milestones[0].status, 'ready_to_confirm');               // proposed, NOT auto-completed
  assert.equal(ms.projectDetail(db, p, T0)!.milestones[0].state, 'open');
  ms.completeMilestone(db, m, {});
  const done = ms.projectDetail(db, p, T0)!.milestones[0]; assert.equal(done.state, 'done'); assert.match(done.evidence!, /All 2 linked task\(s\) completed: Build; Test/);
  assert.throws(() => ms.completeMilestone(db, m, { evidence: 'again, for good measure' }), /already done/);
});

test('status is derived from facts: overdue, at risk (soon + open work or no tasks), blocked by dependency', () => {
  const db = makeDb(); const p = proj(db);
  const a = ms.createMilestone(db, { projectId: p, title: 'A', due: T0 - DAY });
  const b = ms.createMilestone(db, { projectId: p, title: 'B', due: T0 + DAY, dependsOn: a });
  const c = ms.createMilestone(db, { projectId: p, title: 'C', due: T0 + 30 * DAY });
  const d = ms.createMilestone(db, { projectId: p, title: 'D', due: T0 + 2 * DAY });
  createTask(db, { title: 'x', projectId: p, milestoneId: d });
  const by = Object.fromEntries(ms.projectDetail(db, p, T0)!.milestones.map((m) => [m.title, m.status]));
  assert.deepEqual(by, { A: 'overdue', B: 'blocked', C: 'not_started', D: 'at_risk' });
  assert.equal(ms.projectDetail(db, p, T0)!.progress.health, 'overdue');
  assert.throws(() => ms.completeMilestone(db, b, { evidence: 'trying to skip ahead of A' }), /blocked by "A"/);
  void c;
});

test('dependencies cannot loop or cross projects; tasks cannot be linked across projects or to closed milestones', () => {
  const db = makeDb(); const p = proj(db), q = proj(db, 'p2');
  const a = ms.createMilestone(db, { projectId: p, title: 'A' }), b = ms.createMilestone(db, { projectId: p, title: 'B', dependsOn: a }), x = ms.createMilestone(db, { projectId: q, title: 'X' });
  assert.throws(() => ms.updateMilestone(db, a, { dependsOn: b }), /loop/); assert.throws(() => ms.updateMilestone(db, a, { dependsOn: a }), /loop/);
  assert.throws(() => ms.createMilestone(db, { projectId: p, title: 'Z', dependsOn: x }), /same project/);
  const t = createTask(db, { title: 't', projectId: q }); assert.throws(() => ms.linkTask(db, t, a), /different project/);
  ms.completeMilestone(db, a, { evidence: 'finished and verified by hand' }); const t2 = createTask(db, { title: 't2', projectId: p }); assert.throws(() => ms.linkTask(db, t2, a), /not open/);
});

test('cancel unlinks tasks; reopen clears the evidence', () => {
  const db = makeDb(); const p = proj(db); const m = ms.createMilestone(db, { projectId: p, title: 'M' }); const t = createTask(db, { title: 't', projectId: p, milestoneId: m });
  ms.cancelMilestone(db, m); assert.equal((db.prepare('SELECT milestone_id FROM tasks WHERE id=?').get(t) as any).milestone_id, null);
  assert.equal(ms.reopenMilestone(db, m), true);
  ms.completeMilestone(db, m, { evidence: 'checked by Luke on site' }); ms.reopenMilestone(db, m);
  const r = db.prepare('SELECT state,evidence,completed_at FROM milestones WHERE id=?').get(m) as any; assert.deepEqual([r.state, r.evidence, r.completed_at], ['open', null, null]);
  void cancelTask;
});

test('briefing: overdue milestones are urgent, ready-to-confirm is an update, at-risk is a recommendation; demo projects are ignored', () => {
  const db = makeDb(); const p = proj(db); const NOW = Date.now();
  ms.createMilestone(db, { projectId: p, title: 'Late one', due: NOW - 3 * DAY });
  const r = ms.createMilestone(db, { projectId: p, title: 'All done', due: NOW + 10 * DAY }); const t = createTask(db, { title: 'w', projectId: p, milestoneId: r }); completeTask(db, t, 'luke', 'ok');
  ms.createMilestone(db, { projectId: p, title: 'Soon and empty', due: NOW + DAY });
  const dp = proj(db, 'demo', 1); ms.createMilestone(db, { projectId: dp, title: 'Demo overdue', due: NOW - DAY, isDemo: true });
  const b = buildBriefing(db, NOW);
  assert.ok(b.sections[0].items.some((i) => /Overdue milestone.*Late one/.test(i.text)));
  assert.ok(b.sections[1].items.some((i) => /Ready to confirm: "All done"/.test(i.text)));
  assert.ok(b.sections[2].items.some((i) => /At risk: "Soon and empty".*no tasks linked/.test(i.text)));
  assert.ok(![...b.sections.flatMap((s) => s.items)].some((i) => /Demo overdue/.test(i.text)));
});

test('demo milestones seed and remove cleanly (foreign keys), isolated from real data', () => {
  const db = makeDb(); proj(db, 'real'); ms.createMilestone(db, { projectId: 'real', title: 'Real' });
  assert.equal(seedDemo(db), true); assert.equal((db.prepare('SELECT COUNT(*) c FROM milestones WHERE is_demo=1').get() as any).c, 3);
  removeDemo(db); assert.equal((db.prepare('SELECT COUNT(*) c FROM milestones').get() as any).c, 1);
});

test('a late milestone whose linked work is all finished is "ready to confirm", not "overdue"', () => {
  const db = makeDb(); const p = proj(db); const m = ms.createMilestone(db, { projectId: p, title: 'Late but finished', due: T0 - 5 * DAY });
  assert.equal(ms.projectDetail(db, p, T0)!.milestones[0].status, 'overdue');
  const t = createTask(db, { title: 'work', projectId: p, milestoneId: m }); assert.equal(ms.projectDetail(db, p, T0)!.milestones[0].status, 'overdue');
  completeTask(db, t, 'luke', 'ok'); assert.equal(ms.projectDetail(db, p, T0)!.milestones[0].status, 'ready_to_confirm');
});
