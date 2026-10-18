import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import { LlmError, type Completion, type CompletionRequest, type Provider } from '../llm/types.ts';
import * as ws from '../websearch.ts';
import * as M from '../missions.ts';
import * as ta from '../tempagents.ts';
import * as reg from '../skills/registry.ts';
import * as mb from '../missionbudget.ts';
import { tick as workerTick } from '../worker.ts';
import { emergencyStop } from '../emergency.ts';
import { buildBriefing } from '../today.ts';
import { setPaused } from '../pause.ts';
import { createTask } from '../tasks.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
type S = { searches: string[]; calls: CompletionRequest[]; onSearch?: (n: number) => void; failAll?: boolean; corroborated?: boolean; plan?: string };
function script(o: Partial<S> = {}) {
  const s: S = { searches: [], calls: [], corroborated: true, ...o }; let n = 0;
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) {
    s.calls.push(req); const U = { inputTokens: 3000, outputTokens: 200, cacheReadTokens: 0 };
    if (req.webSearch) { if (s.failAll) throw new LlmError('transient', 'down'); const i = n++; s.searches.push(req.messages[0].content); s.onSearch?.(i);
      const claims = [{ text: `Fact about ${req.messages[0].content.slice(0, 20)}`, cites: [{ url: 'https://www.noaa.gov/a', title: 'A', citedText: 'a text' }, ...(s.corroborated ? [{ url: 'https://news.example.com/b', title: 'B', citedText: 'b text' }] : [])] }];
      return { text: 'An answer.', model: req.model, stopReason: 'end_turn', usage: U, searches: 1, sources: [], claims, pageAges: {} } as Completion; }
    const sys = req.system; let text: string;
    if (sys.includes('Break a research goal')) text = s.plan ?? '{"steps":[{"title":"Background","question":"What is the background of the topic?"},{"title":"Options","question":"What are the main options available?"}]}';
    else if (sys.includes('Split a research question')) text = '{"subQuestions":["angle one here?","angle two here?"]}';
    else if (sys.includes('cross-check')) text = JSON.stringify({ summary: 'A summary.', findings: [{ statement: 'A is true', type: 'fact', claims: [1, 2] }], followUps: ['What are the long term costs of option A?'], contradictions: [], gaps: [] });
    else if (sys.includes('reviewing a research report')) text = JSON.stringify({ conclusion: 'Reviewed conclusion for Luke.', toVerify: ['Check the cost figure at the original source'] });
    else text = '{}';
    return { text, model: req.model, stopReason: 'end_turn', usage: U } as Completion; } } as Provider }; return s;
}
const webOn = (db: any) => ws.setConfig(db, { enabled: true, perDay: 50 });
async function drive(db: any, rounds = 14, now = Date.now()) { for (let i = 0; i < rounds; i++) { await M.tick(db, now); while (await workerTick(db, 'w1')) { /* drain */ } } }
const mission = (db: any, id: string) => db.prepare('SELECT * FROM missions WHERE id=?').get(id) as any;
const steps = (db: any, id: string) => db.prepare('SELECT * FROM mission_steps WHERE mission_id=? ORDER BY idx').all(id) as any[];

test('mission: Luke assigns it, Prometheus plans steps, a scoped temporary agent does each one, Jarvis reviews, follow-ups are only proposals, Luke is told once', async () => {
  const db = makeDb(); webOn(db); const s = script();
  const mid = M.createAssigned(db, { goal: 'Work out the best approach to winter boat storage', capMicro: 3_000_000, priority: 2 });
  assert.equal(mission(db, mid).status, 'active'); assert.equal(mission(db, mid).origin, 'luke');
  await drive(db);
  const m = mission(db, mid); assert.equal(m.status, 'done', JSON.stringify(m.blockers)); assert.equal(steps(db, mid).length, 2); assert.ok(steps(db, mid).every((x) => x.status === 'done' && x.agent_id && x.task_id));
  const rep = JSON.parse(m.report); assert.equal(rep.reviewedByJarvis, true); assert.equal(rep.conclusion, 'Reviewed conclusion for Luke.'); assert.deepEqual(rep.toVerify, ['Check the cost figure at the original source']); assert.equal(rep.stats.steps, 2); assert.ok(rep.stats.corroborated >= 2);
  assert.ok(s.calls.some((c) => c.system.includes('reviewing a research report')) && !JSON.stringify(s.calls.filter((c) => c.system.includes('reviewing a research report')).map((c) => c.messages)).includes('<script'), 'the review sees only structured step results');
  assert.ok(M.missionSpent(db, mid) > 0 && M.missionSpent(db, mid) <= m.cap_micro_usd);
  for (const st of steps(db, mid)) { const a = ta.get(db, st.agent_id); assert.equal(a.status, 'torn_down'); assert.equal(a.teardown_reason, 'step finished'); assert.deepEqual(JSON.parse(a.skills), ['research.catalog_lookup']); }
  assert.equal((db.prepare("SELECT COUNT(*) c FROM skill_grants WHERE principal LIKE 'temp:%'").get() as any).c, 0, 'teardown removes every grant');
  const props = db.prepare("SELECT * FROM missions WHERE status='proposed'").all() as any[]; assert.equal(props.length, 1, 'the same follow-up from two steps is one proposal'); assert.equal(props[0].parent_id, mid); assert.equal(props[0].origin, 'prometheus');
  assert.equal(steps(db, props[0].id).length, 0, 'a proposal does nothing: no steps, no tasks'); const before = s.searches.length; await drive(db, 4); assert.equal(s.searches.length, before, 'nothing runs for a proposal');
  const notes = db.prepare("SELECT * FROM notifications WHERE kind='mission'").all() as any[]; assert.equal(notes.length, 1); assert.match(notes[0].title, /Research finished/); await drive(db, 3); assert.equal((db.prepare("SELECT COUNT(*) c FROM notifications WHERE kind='mission'").get() as any).c, 1, 'no repeat alerts');
  M.accept(db, props[0].id); assert.equal(mission(db, props[0].id).status, 'active'); await drive(db); assert.equal(mission(db, props[0].id).status, 'done');
});

test('self-started work: only from your watches, one new a day, two at a time, within the monthly exploration budget, lowest priority', async () => {
  const db = makeDb(); webOn(db); script();
  for (const t of ['topic number one to watch', 'topic number two to watch', 'topic number three to watch']) M.addWatch(db, { topic: t, cadenceDays: 7 });
  assert.throws(() => M.addWatch(db, { topic: 'x', cadenceDays: 7 })); assert.throws(() => M.addWatch(db, { topic: 'a fine topic here', cadenceDays: 0 })); assert.throws(() => M.addWatch(db, { topic: 'a fine topic here', cadenceDays: 500 }));
  const t0 = Date.now(); await M.tick(db, t0); let all = db.prepare("SELECT * FROM missions WHERE kind IN ('watch','scout')").all() as any[]; assert.equal(all.length, 1, 'one new self-started mission per day'); assert.equal(all[0].priority, 5); assert.equal(all[0].origin, 'watch'); assert.ok(all[0].cap_micro_usd <= 1_000_000);
  await M.tick(db, t0 + 60_000); assert.equal((db.prepare("SELECT COUNT(*) c FROM missions WHERE kind IN ('watch','scout')").get() as any).c, 1, 'still one today');
  await M.tick(db, t0 + 26 * 3_600_000); assert.equal((db.prepare("SELECT COUNT(*) c FROM missions WHERE kind IN ('watch','scout')").get() as any).c, 2, 'the next day, the next one');
  await M.tick(db, t0 + 52 * 3_600_000); assert.equal((db.prepare("SELECT COUNT(*) c FROM missions WHERE kind IN ('watch','scout')").get() as any).c, 2, 'never more than two running at once');
  // nothing is started for a watch that is switched off, and no watch means no self-started work at all
  const db2 = makeDb(); webOn(db2); script(); await M.tick(db2); assert.equal((db2.prepare('SELECT COUNT(*) c FROM missions').get() as any).c, 0, 'with no watches, Jarvis starts nothing on its own');
  const w = M.addWatch(db2, { topic: 'a disabled topic here', cadenceDays: 1 }); M.setWatchEnabled(db2, w, false); await M.tick(db2); assert.equal((db2.prepare('SELECT COUNT(*) c FROM missions').get() as any).c, 0);
  // exhausted exploration budget: nothing new starts
  const db3 = makeDb(); webOn(db3); script(); mb.setDefaults(db3, { quickMicro: 100_000, deepMicro: 2_000_000, exploreMonthlyMicro: 100_000 }); M.addWatch(db3, { topic: 'budget limited topic here', cadenceDays: 1 }); await M.tick(db3); assert.equal((db3.prepare('SELECT COUNT(*) c FROM missions').get() as any).c, 0, 'monthly exploration budget too small: nothing starts');
  assert.equal(M.addPresets(db2), 3); assert.equal(M.addPresets(db2), 0, 'presets are added once');
});

test('priority: self-started research gives way to anything Luke assigned, saves its progress, and resumes without repeating work', async () => {
  const db = makeDb(); webOn(db); let assignedMade = false;
  const s = script({ onSearch: (i) => { if (i === 0 && !assignedMade) { assignedMade = true; createTask(db, { title: 'Assigned work', kind: 'research', priority: 3, input: { question: 'q', urls: ['https://x.example.com'] } }); } } });
  const w = M.addWatch(db, { topic: 'a deep watch topic here', cadenceDays: 7, tier: 'deep' });
  await M.tick(db); const mid = (db.prepare("SELECT id FROM missions WHERE watch_id=?").get(w) as any).id; await M.tick(db);
  const stepTask = steps(db, mid)[0].task_id as string; const t = db.prepare('SELECT optional_work, priority FROM tasks WHERE id=?').get(stepTask) as any; assert.equal(t.optional_work, 1); assert.equal(t.priority, 5);
  db.prepare("UPDATE tasks SET kind='research' WHERE id=?").run(stepTask);
  await workerTick(db, 'w1');   // runs the self-started job: after its first search an assigned job appears, so it must yield before the second
  const st = db.prepare('SELECT state, waiting_reason FROM tasks WHERE id=?').get(stepTask) as any; assert.equal(st.state, 'ready'); assert.match(st.waiting_reason, /yielded/); const firstCount = s.searches.length; assert.equal(firstCount, 1);
  assert.ok(db.prepare('SELECT 1 FROM research_runs WHERE task_id=?').get(stepTask), 'progress is saved');
  db.prepare("UPDATE tasks SET state='completed' WHERE title='Assigned work'").run(); db.prepare('UPDATE tasks SET next_run_at=0 WHERE id=?').run(stepTask);
  while (await workerTick(db, 'w1')) { /* drain */ } assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(stepTask) as any).state, 'completed'); assert.equal(s.searches.filter((q) => q === s.searches[0]).length, 1, 'the finished search was not repeated');
});

test('budgets: a mission stops at its cap; Luke can wrap it up with what it has; money never goes past the caps', async () => {
  const db = makeDb(); webOn(db); script();
  const mid = M.createAssigned(db, { goal: 'A mission with a tiny budget', capMicro: 50_000 }); db.prepare('UPDATE missions SET cap_micro_usd=15000 WHERE id=?').run(mid);
  await drive(db, 4); assert.equal(mission(db, mid).status, 'blocked'); assert.match(mission(db, mid).blockers, /budget is used up/); assert.equal(steps(db, mid).filter((x) => x.status === 'running').length, 0, 'nothing started past the cap');
  await M.finishPartial(db, mid); assert.equal(mission(db, mid).status, 'stopped', 'no finished step, so it is simply stopped');
  const db2 = makeDb(); webOn(db2); script(); const m2 = M.createAssigned(db2, { goal: 'A mission with two steps', capMicro: 3_000_000 });
  await M.tick(db2); while (await workerTick(db2, 'w1')) {} db2.prepare('UPDATE missions SET cap_micro_usd=? WHERE id=?').run(M.missionSpent(db2, m2) + 5_000, m2);
  await M.tick(db2); assert.equal(steps(db2, m2).filter((x) => x.status === 'done').length, 1);
  await M.finishPartial(db2, m2); const mm = mission(db2, m2); assert.equal(mm.status, 'done'); assert.equal(JSON.parse(mm.report).stats.steps, 1, 'wrapped up with the one finished step');
  assert.ok(steps(db2, m2).some((x) => x.status === 'skipped'));
});

test('temporary agents: capped, subset of Prometheus, scoped, expire, end with their mission, and die on Stop everything', async () => {
  const db = makeDb(); webOn(db); reg.sync(db);
  const mid = M.createAssigned(db, { goal: 'A mission that owns temporary agents' });
  const a = ta.spawn(db, { name: 'S1', charter: 'c', missionId: mid, skills: ['research.catalog_lookup'], budgetMicro: 500_000 });
  assert.throws(() => ta.spawn(db, { name: 'bad', charter: 'c', missionId: mid, skills: ['memory.search'], budgetMicro: 500_000 }), /cannot either|may not use/); assert.throws(() => ta.spawn(db, { name: 'bad', charter: 'c', missionId: mid, skills: ['messages.send'], budgetMicro: 500_000 })); assert.throws(() => ta.spawn(db, { name: 'tiny', charter: 'c', missionId: mid, budgetMicro: 5 }), /at least/);
  assert.equal(reg.access(db, ta.principalOf(a), 'research.catalog_lookup').via, 'grant'); assert.equal(reg.access(db, ta.principalOf(a), 'docs.extract_text').allowed, false, 'a temporary agent gets only the skills it was spawned with, not the shared ones');
  assert.equal((await reg.invoke(db, ta.principalOf(a), 'research.catalog_lookup', {})).ok, true);
  ta.spawn(db, { name: 'S2', charter: 'c', missionId: mid, budgetMicro: 500_000 }); ta.spawn(db, { name: 'S3', charter: 'c', missionId: mid, budgetMicro: 500_000 }); assert.throws(() => ta.spawn(db, { name: 'S4', charter: 'c', missionId: mid, budgetMicro: 500_000 }), /Only 3/);
  assert.equal(ta.get(db, (db.prepare("SELECT id FROM temp_agents WHERE name='S2'").get() as any).id).budget_micro_usd, 500_000);
  // expiry
  const t0 = Date.now(); assert.equal(ta.sweep(db, t0 + 7 * 3_600_000), 3, 'all three expire (6 hour default)'); assert.equal(ta.isLive(db, a), false); const dead = await reg.invoke(db, ta.principalOf(a), 'research.catalog_lookup', {}); assert.equal(dead.ok, false); assert.match((dead as any).refused, /torn down|expired/);
  // mission end and Stop everything
  const b = ta.spawn(db, { name: 'S5', charter: 'c', missionId: mid, skills: ['research.catalog_lookup'], budgetMicro: 500_000 }); M.stop(db, mid); assert.equal(ta.get(db, b).status, 'torn_down'); assert.equal(ta.get(db, b).teardown_reason, 'mission ended');
  const m2 = M.createAssigned(db, { goal: 'Another running mission here' }); const c = ta.spawn(db, { name: 'S6', charter: 'c', missionId: m2, budgetMicro: 500_000 }); const r = emergencyStop(db); assert.equal(r.tempAgentsTornDown, 1); assert.equal(ta.get(db, c).status, 'torn_down'); assert.equal(r.missionsPaused, 1); assert.equal(mission(db, m2).status, 'paused');
  setPaused(db, false); await M.tick(db); assert.equal(mission(db, m2).status, 'paused', 'a mission paused by Stop everything stays paused until Luke resumes it');
  const big = ta.spawn(db, { name: 'big', charter: 'c', missionId: m2, budgetMicro: 5_000_000 }); assert.equal(ta.get(db, big).budget_micro_usd, 2_000_000, 'allowance is clamped to $2'); assert.ok(ta.get(db, big).expires_at - ta.get(db, big).created_at <= 24 * 3_600_000);
});

test('dependencies, pause/resume/stop, retry and dismissal behave', async () => {
  const db = makeDb(); webOn(db); const s = script();
  const a = M.createAssigned(db, { goal: 'First mission needing to finish first' }), b = M.createAssigned(db, { goal: 'Second mission that depends on the first', dependsOn: [a] });
  await M.tick(db); assert.equal(steps(db, b).length, 0, 'the dependent mission has not started'); assert.match(mission(db, b).next_action, /Waiting for/);
  await drive(db, 20); assert.equal(mission(db, a).status, 'done'); assert.equal(mission(db, b).status, 'done'); assert.ok(mission(db, a).finished_at <= mission(db, b).finished_at);
  const c = M.createAssigned(db, { goal: 'A mission to pause midway through' }); await M.tick(db); const running = steps(db, c).find((x) => x.status === 'running')!; M.pause(db, c); assert.equal(mission(db, c).status, 'paused'); assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(running.task_id) as any).state, 'canceled'); assert.equal(ta.get(db, running.agent_id).status, 'torn_down'); assert.equal(steps(db, c)[0].status, 'pending', 'the step goes back to waiting');
  await M.tick(db); assert.equal(steps(db, c).filter((x) => x.status === 'running').length, 0, 'a paused mission starts nothing'); M.resume(db, c); await drive(db, 14); assert.equal(mission(db, c).status, 'done');
  const d = M.createAssigned(db, { goal: 'A mission that will be stopped' }); await M.tick(db); M.stop(db, d); assert.equal(mission(db, d).status, 'stopped'); assert.throws(() => M.stop(db, d), /already finished/);
  // failing search -> blocked with a plain reason, then retry
  const db2 = makeDb(); webOn(db2); const s2 = script({ failAll: true }); const e = M.createAssigned(db2, { goal: 'A mission whose searches fail' }); for (let i = 0; i < 5; i++) { await drive(db2, 2); db2.prepare('UPDATE tasks SET next_run_at=0').run(); } const me = mission(db2, e); assert.equal(me.status, 'blocked'); assert.ok(me.blockers.length > 3); assert.ok((db2.prepare("SELECT COUNT(*) c FROM notifications WHERE kind='mission'").get() as any).c === 1, 'one nudge, not a flood'); s2.failAll = false; M.retryStep(db2, e); await drive(db2, 14); assert.equal(mission(db2, e).status, 'done');
  // proposals
  const db3 = makeDb(); const p = M.propose(db3, { question: 'Is there a cheaper alternative to option A?', why: 'because', origin: 'prometheus' })!; assert.ok(p); assert.equal(M.propose(db3, { question: 'Is there a cheaper alternative to option A?', why: 'dup', origin: 'prometheus' }), null, 'no duplicates');
  M.dismiss(db3, p); assert.equal(mission(db3, p).status, 'stopped'); assert.throws(() => M.accept(db3, p)); for (let i = 0; i < 7; i++) M.propose(db3, { question: `A different follow up question number ${i}`, why: 'w', origin: 'prometheus' }); assert.equal((db3.prepare("SELECT COUNT(*) c FROM missions WHERE status='proposed'").get() as any).c, 5, 'at most five wait at once');
  void s;
});

test('delivery: assigned results notify once; self-started results reach the briefing only when something was corroborated', async () => {
  const db = makeDb(); webOn(db); script({ corroborated: true }); M.addWatch(db, { topic: 'a corroborated watch topic', cadenceDays: 7 }); await drive(db, 10);
  const items = buildBriefing(db).sections[1].items.filter((i) => /Prometheus found something/.test(i.text)); assert.equal(items.length, 1); assert.equal((db.prepare("SELECT COUNT(*) c FROM notifications WHERE kind='mission'").get() as any).c, 0, 'self-started results never push a notification');
  const db2 = makeDb(); webOn(db2); script({ corroborated: false }); M.addWatch(db2, { topic: 'an uncorroborated watch topic', cadenceDays: 7 }); await drive(db2, 10);
  assert.equal((db2.prepare("SELECT status FROM missions WHERE kind='watch'").get() as any).status, 'done'); assert.equal(buildBriefing(db2).sections[1].items.filter((i) => /Prometheus found something/.test(i.text)).length, 0, 'thin results stay in the tracker, out of your briefing');
});
