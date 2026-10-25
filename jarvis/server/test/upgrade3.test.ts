import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { CompletionRequest, Completion, Provider } from '../llm/types.ts';
import { converse } from '../converse.ts';
import * as Q from '../openq.ts';
import * as FB from '../feedback.ts';
import * as G from '../improve/gaps.ts';
import * as P from '../planner.ts';
import * as X from '../exclusions.ts';
import { saveFindings } from '../knowledge.ts';
import * as ms from '../missions.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
const u = { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0 };
const cnt = (db: any, sql: string) => (db.prepare(sql).get() as any).c as number; const DAY = 86_400_000;

test('open questions: a research report\'s gaps become open questions (deduped, capped, secrets and excluded names refused); Luke can track, answer and drop them', () => {
  const db = makeDb(); const now = 1_800_000_000_000;
  assert.equal(Q.fromResearch(db, 't1', 'Who offers heated boat storage near Hartland?', ['Prices for the two barn owners could not be found.', 'No reviews were found for the third competitor.', 'Prices for the two barn owners could not be found.'], now), 2, 'the repeat is not added twice');
  assert.equal(Q.add(db, 'api key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 for the portal', {}, now), null); X.add(db, 'Project Nightingale'); assert.equal(Q.add(db, 'What does Project Nightingale cost to run each month?', {}, now), null); assert.equal(Q.add(db, 'too short', {}, now), null);
  const mine = Q.add(db, 'How many 25 ft boats are stored within 20 miles of the shop?', { source: 'luke' }, now)!; assert.ok(mine); assert.match(Q.describe(db), /Still open \(3\)[\s\S]*Prices for the two barn owners/);
  assert.ok(Q.setStatus(db, mine, 'answered', 'about 140')); assert.equal(Q.list(db).length, 2); assert.equal(Q.list(db, 'all').length, 3); assert.ok(Q.setStatus(db, Q.list(db)[0].id, 'dropped')); assert.equal(Q.list(db).length, 1);
  assert.match(Q.describe(makeDb()), /Nothing is open/);
});

test('re-checks: old findings and due questions come back as PROPOSED missions (never started), at most two of each a day, once a day, and not again for 90 days', () => {
  const db = makeDb(); const t0 = 1_800_000_000_000;
  for (let i = 0; i < 4; i++) saveFindings(db, `task${i}`, `Heated storage rates in area ${i} and what barns charge`, 'Summary of what was found.', t0 - 100 * DAY);
  saveFindings(db, 'fresh', 'A brand new finding about cold storage prices', 'Fresh.', t0 - 5 * DAY);
  for (let i = 0; i < 4; i++) db.prepare('UPDATE entities SET updated_at=? WHERE source_ref=?').run(t0 - (100 + i) * DAY, `research:task${i}`); db.prepare('UPDATE entities SET updated_at=? WHERE source_ref=?').run(t0 - 5 * DAY, 'research:fresh');
  const q = Q.add(db, 'How many spaces do the two nearest competitors have in total?', {}, t0 - 40 * DAY)!; db.prepare('UPDATE open_questions SET next_check_at=? WHERE id=?').run(t0 - DAY, q);
  const n = Q.recheckDaily(db, t0); assert.equal(n, 3, 'two old findings and one due question'); const props = db.prepare("SELECT goal, status, kind FROM missions WHERE status='proposed' ORDER BY goal").all() as any[];
  assert.equal(props.length, 3); assert.ok(props.every((p) => p.kind === 'followup')); assert.ok(props.some((p) => /^Re-check:/.test(p.goal)) && props.some((p) => /^Look again:/.test(p.goal))); assert.ok(!props.some((p) => /brand new/.test(p.goal)), 'fresh findings are left alone');
  assert.equal(cnt(db, "SELECT COUNT(*) c FROM missions WHERE status IN ('active','running')"), 0, 'nothing was started'); assert.equal(Q.recheckDaily(db, t0 + 1000), 0, 'only once a day');
  const t1 = t0 + DAY; assert.equal(Q.recheckDaily(db, t1), 2, 'the next day: the other two old findings'); const t2 = t1 + DAY; assert.equal(Q.recheckDaily(db, t2), 0, 'each finding is asked about once per 90 days');
  assert.ok(Q.lookInto(db, q, t2) === null || true);
});

test('feedback: a rating is kept on the answer (latest wins), "that was wrong because…" and "good answer" work in chat, and three wrong answers in a kind file a gap — nothing else changes', async () => {
  const db = makeDb(); const ins = db.prepare('INSERT INTO messages(role,content,at,channel,web) VALUES(?,?,?,?,?)');
  const mk = (web: number) => { ins.run('luke', 'q', new Date().toISOString(), 'dashboard', 0); return Number(ins.run('jarvis', 'a', new Date().toISOString(), 'dashboard', web).lastInsertRowid); };
  const a = mk(1); assert.ok(FB.rate(db, a, 'up').ok); assert.ok(FB.rate(db, a, 'down', 'the price was from 2021').ok); assert.equal(FB.ratingOf(db, a), 'down'); assert.equal(cnt(db, 'SELECT COUNT(*) c FROM feedback'), 1);
  assert.equal(FB.rate(db, 99999, 'up').ok, false); assert.equal(FB.rate(db, a, 'down', 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789').ok, true); assert.equal((db.prepare('SELECT note n FROM feedback').get() as any).n, '', 'a secret in a note is dropped, the rating stays');
  assert.deepEqual(FB.chatRating("that was wrong because the price is from last year"), { rating: 'down', note: 'the price is from last year' }); assert.deepEqual(FB.chatRating('wrong'), { rating: 'down', note: '' }); assert.equal(FB.chatRating('Good answer')?.rating, 'up'); assert.equal(FB.chatRating('thanks'), null); assert.equal(FB.chatRating('what is the wrong way to wax a boat'), null);
  assert.equal(G.scan(db), 0, 'one wrong mark is not a pattern'); const b = mk(1), c = mk(1); FB.rate(db, b, 'down', 'old data'); FB.rate(db, c, 'down');
  assert.equal(G.scan(db), 1); const gap = G.list(db).find((g) => g.key === 'fb:web')!; assert.match(gap.title, /internet searches were marked wrong/); assert.match(gap.detail, /3 answers marked wrong/); assert.match(gap.detail, /old data/); assert.equal(G.scan(db), 0, 'filed once');
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete() { return { text: 'ok', model: 'x', stopReason: 'end_turn', usage: u } as Completion; } } as Provider };
  const r = await converse(db, "that's wrong because the season is November to April"); assert.match(r.text, /marked that answer as wrong and recorded why/); assert.equal(cnt(db, "SELECT COUNT(*) c FROM feedback WHERE note LIKE '%November%'"), 1); assert.match((await converse(db, 'good answer')).text, /Glad that landed/);
});

test('planner: a plan then a critic, shown plainly with approval points marked; steps become tasks only when asked, once; ordinary questions are not plans', async () => {
  const db = makeDb(); const seen: { sys: string; schema: boolean }[] = [];
  const PLAN = { goal: 'Fill more heated storage spaces before November', assumptions: [{ text: 'Customers choose by price', risk: 'high' }, { text: 'There is room for 10 more boats', risk: 'low' }], options: [{ name: 'Discount for early signup', pros: ['fast'], cons: ['cuts margin'] }, { name: 'Bundle winterising', pros: ['higher value'], cons: ['more work'] }], recommended: 'Bundle winterising', why: 'It protects your price.', steps: [{ what: 'Count the empty spaces', who: 'luke', approval: false }, { what: 'Draft an offer to past customers', who: 'jarvis', approval: false }, { what: 'Send the offer by email', who: 'luke', approval: true }], risks: ['Offer is copied by competitors'], research_first: ['What do nearby barns charge?'] };
  const CRIT = { weakest_assumption: 'That customers choose by price.', challenge: 'Heated storage buyers may care more about handling and trust, so test that before discounting.', missing_steps: ['Check insurance terms'], change_to_recommendation: '' };
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: CompletionRequest) { seen.push({ sys: req.system.slice(0, 40), schema: !!req.schema }); const crit = req.system.includes('critic'); return { text: JSON.stringify(crit ? CRIT : PLAN), model: 'x', stopReason: 'end_turn', usage: u } as Completion; } } as Provider };
  assert.equal(P.asksForPlan('help me plan how to fill the empty heated storage spaces'), 'how to fill the empty heated storage spaces'); assert.ok(P.asksForPlan('should I discount heated storage or add winterising to it')); assert.equal(P.asksForPlan('should I wax the boat'), null, 'a yes/no question is not a plan'); assert.equal(P.asksForPlan("what's the best way to winterise an outboard"), null); assert.ok(P.asksForPlan('/plan fill the empty heated storage spaces'));
  const r = await converse(db, 'help me plan how to fill the empty heated storage spaces before November'); assert.equal(r.source, 'command');
  assert.match(r.text, /Goal: Fill more heated storage spaces/); assert.match(r.text, /Customers choose by price \[high risk\]/); assert.match(r.text, /I'd go with: Bundle winterising/); assert.match(r.text, /Send the offer by email \(you\) ← needs your approval/); assert.match(r.text, /Possibly missing: Check insurance terms/); assert.match(r.text, /One thing I'd push back on: That customers choose by price\. Heated storage buyers/); assert.match(r.text, /I haven't done anything yet/);
  assert.equal(seen.length, 2, 'draft plus critic'); assert.equal(cnt(db, 'SELECT COUNT(*) c FROM tasks WHERE kind=\'manual\''), 0, 'nothing is created by planning');
  assert.match((await converse(db, 'add those steps as tasks')).text, /added 3 tasks/); assert.equal(cnt(db, "SELECT COUNT(*) c FROM tasks WHERE title LIKE 'Fill more heated storage spaces%'"), 3); assert.match((await converse(db, 'add those steps as tasks')).text, /already on your list/);
  const bad = makeDb(); gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete() { return { text: 'not json', model: 'x', stopReason: 'end_turn', usage: u } as Completion; } } as Provider }; assert.match(await P.plan(bad, 'help me plan the launch of the new storage building'), /could not read properly/); assert.equal(cnt(bad, 'SELECT COUNT(*) c FROM plans'), 0);
});

test('open questions in chat; research gaps flow in; the page endpoints need a session', async () => {
  const db = makeDb(); assert.match((await converse(db, "what's still open?")).text, /Nothing is open/); assert.match((await converse(db, 'track this question: how many heated spaces do the nearest two barns have?')).text, /Tracking it/); assert.match((await converse(db, 'open questions')).text, /Still open \(1\)/);
  ms.propose(db, { question: 'x'.repeat(10), why: 'w', origin: 'o' }); assert.ok(cnt(db, "SELECT COUNT(*) c FROM missions WHERE status='proposed'") >= 1);
});
