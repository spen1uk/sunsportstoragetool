import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import { LlmError, type Completion, type CompletionRequest, type Provider } from '../llm/types.ts';
import * as ws from '../websearch.ts';
import * as M from '../missions.ts';
import * as D from '../delegation.ts';
import * as X from '../exclusions.ts';
import { tick as workerTick } from '../worker.ts';
import { converse } from '../converse.ts';
import { overview } from '../agentsview.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
/** Scripted Prometheus. `corroborated(n)` says whether the n-th search returns two independent sites (n counts from 0). */
function script(o: { corroborated?: (n: number) => boolean; failAll?: boolean } = {}) {
  let n = 0; const calls: CompletionRequest[] = [];
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) {
    calls.push(req); const U = { inputTokens: 3000, outputTokens: 200, cacheReadTokens: 0 };
    if (req.webSearch) { if (o.failAll) throw new LlmError('transient', 'down'); const i = n++; const two = o.corroborated ? o.corroborated(i) : true;
      const claims = [{ text: `Fact ${i}`, cites: [{ url: 'https://www.noaa.gov/a', title: 'A', citedText: 'a text' }, ...(two ? [{ url: 'https://news.example.com/b', title: 'B', citedText: 'b text' }] : [])] }];
      return { text: 'An answer.', model: req.model, stopReason: 'end_turn', usage: U, searches: 1, sources: [], claims, pageAges: {} } as Completion; }
    const sys = req.system; let text: string;
    if (sys.includes('Break a research goal')) text = '{"steps":[{"title":"Background","question":"What is the background of the topic?"},{"title":"Options","question":"What are the main options available?"}]}';
    else if (sys.includes('Split a research question')) text = '{"subQuestions":["angle one here?","angle two here?"]}';
    else if (sys.includes('cross-check')) text = JSON.stringify({ summary: 'A summary.', findings: [{ statement: 'A is true', type: 'fact', claims: [1, 2] }], followUps: [], contradictions: [], gaps: [] });
    else if (sys.includes('reviewing a research report')) text = JSON.stringify({ conclusion: 'Reviewed conclusion for Luke.', toVerify: [] });
    else text = '{}';
    return { text, model: req.model, stopReason: 'end_turn', usage: U } as Completion; } } as Provider }; return calls;
}
const webOn = (db: any) => ws.setConfig(db, { enabled: true, perDay: 50 });
async function drive(db: any, rounds = 16) { for (let i = 0; i < rounds; i++) { await M.tick(db); D.sync(db); while (await workerTick(db, 'w1')) { /* drain */ } db.prepare('UPDATE tasks SET next_run_at=0').run(); } }
const row = (db: any, id: string) => db.prepare('SELECT * FROM delegations WHERE id=?').get(id) as any;

test('choosing an agent: research goes to Prometheus with the reason; errands go to your list; work for agents that are not connected is named honestly and refused', () => {
  const db = makeDb();
  assert.equal(D.chooseAgent(db, 'Compare the best crypto cold storage wallets').agentId, 'prometheus'); assert.equal(D.chooseAgent(db, 'Remind me to call the dentist on Friday').agentId, 'luke');
  const t = D.chooseAgent(db, 'Backtest the strategy on last year of BTC data'); assert.deepEqual([t.agentId, t.available], ['trading', false]); assert.match(t.why, /not connected/); assert.equal(D.chooseAgent(db, 'Tidy up my thoughts').agentId, 'luke');
  assert.throws(() => D.delegate(db, { request: 'Backtest the strategy on last year of BTC data' }), /not connected/); assert.equal((db.prepare('SELECT COUNT(*) c FROM delegations').get() as any).c, 0);
});

test('delegation loop: states objective, deliverable and limit; Prometheus does it; good work goes to review; weak work is sent back (twice at most) and then handed to you with the reason; scorecards count it', async () => {
  const db = makeDb(); webOn(db); script();
  const r = D.delegate(db, { request: 'Research the best ways to cut winter boat storage costs', deadlineDays: 7, capMicro: 2_000_000 }); const d0 = row(db, r.id); assert.equal(d0.agent_id, 'prometheus'); assert.equal(d0.cap_micro, 2_000_000); assert.ok(d0.deadline_ms && d0.mission_id); assert.match(d0.deliverable, /sourced write-up/); assert.equal((M.get(db, d0.mission_id)).cap_micro_usd, 2_000_000);
  await drive(db); const d1 = row(db, r.id); assert.equal(d1.status, 'in_review'); assert.equal(d1.returns, 0); assert.match(d1.verdict, /Passed the checks/); assert.ok(d1.spent_micro > 0);
  D.accept(db, r.id); assert.equal(row(db, r.id).status, 'accepted'); assert.throws(() => D.accept(db, r.id));
  // weak work: nothing is ever corroborated → sent back twice, then handed over with the reason
  script({ corroborated: () => false }); const w = D.delegate(db, { request: 'Research the cheapest hull coatings available' }); await drive(db, 40); const dw = row(db, w.id);
  assert.equal(dw.returns, D.MAX_RETURNS); assert.equal(dw.status, 'in_review'); assert.match(dw.verdict, /Still thin/); assert.ok((D.events(db, w.id) as any[]).filter((e) => e.kind === 'returned').length === D.MAX_RETURNS);
  D.sendBack(db, w.id, 'Please compare two brands by price'); assert.equal(row(db, w.id).status, 'returned'); assert.equal(row(db, w.id).feedback, 'Please compare two brands by price'); assert.throws(() => D.sendBack(db, w.id, 'x'));
  const c = D.scorecards(db).prometheus.now; assert.ok(c.jobs >= 2 && c.accepted === 1 && c.returned >= 2); assert.equal(c.acceptRatePct, 100); assert.ok(c.avgCostMicro! > 0);
  const ov = overview(db); assert.ok(ov.agents[1].scorecard.now.jobs >= 2); assert.equal(ov.agents[0].scorecard.now.jobs, 0); assert.equal(ov.agents[0].scorecard.now.acceptRatePct, null, 'no history says so instead of showing zero as a score');
});

test('delegation safety: needs web search on, refuses secrets and excluded names, failures are reported, cancel stops the research, errands become tasks', async () => {
  const db = makeDb(); script(); assert.throws(() => D.delegate(db, { request: 'Research hull coatings for me please' }), /switched off/); webOn(db);
  assert.throws(() => D.delegate(db, { request: 'Research using the key sk-ant-abcdefghijklmnopqrstuv please' })); X.add(db, 'Project Nightingale'); assert.throws(() => D.delegate(db, { request: 'Research Project Nightingale competitors' })); assert.throws(() => D.delegate(db, { request: 'short' })); assert.throws(() => D.delegate(db, { request: 'Research hull coatings please', extra: 1 } as any));
  const errand = D.delegate(db, { request: 'Remind me to call the dentist on Friday' }); const e = row(db, errand.id); assert.ok(e.task_id && !e.mission_id && e.status === 'accepted'); assert.ok(db.prepare("SELECT 1 FROM tasks WHERE id=? AND kind='manual'").get(e.task_id));
  const a = D.delegate(db, { request: 'Research hull coatings in depth please' }); D.cancel(db, a.id); assert.equal(row(db, a.id).status, 'cancelled'); assert.equal(M.get(db, row(db, a.id).mission_id).status, 'stopped'); assert.throws(() => D.cancel(db, a.id));
  script({ failAll: true }); const f = D.delegate(db, { request: 'Research marina insurance options please' }); await drive(db, 30); const df = row(db, f.id); assert.ok(['failed', 'blocked'].includes(df.status), df.status);
});

test('chat: "delegate: …" hands a job over and says who and why; unavailable agents are explained', async () => {
  const db = makeDb(); webOn(db); script(); const r = await converse(db, 'delegate: research the best pressure washers for boat hulls'); assert.equal(r.source, 'command'); assert.match(r.text, /given that to Prometheus/); assert.match(r.text, /\$3\.00/);
  const t = await converse(db, 'delegate: run a backtest of the trading strategy on bitcoin'); assert.match(t.text, /not connected/); assert.equal((db.prepare('SELECT COUNT(*) c FROM delegations').get() as any).c, 1);
});
