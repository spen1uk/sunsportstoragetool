import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, Provider } from '../llm/types.ts';
import * as K from '../knowledge.ts';
import * as X from '../exclusions.ts';
import * as D from '../decisions.ts';
import { buildRecap } from '../today.ts';
import { requestApproval } from '../approvals.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });

test('nightly review: lists what needs your decision tonight; research findings are kept in the knowledge graph, once, and never for excluded topics', () => {
  const db = makeDb(); assert.deepEqual(buildRecap(db).decisionsNeeded, []);
  requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 150_000_000 }, requestedBy: 'luke' });
  const d = D.create(db, { title: 'Move the shop', expectedBy: '2026-01-01' }); D.decide(db, d.id, { chosen: 'move' });
  const r = buildRecap(db, Date.UTC(2026, 9, 19)); assert.ok(r.decisionsNeeded.some((x) => /approval/.test(x))); assert.ok(r.decisionsNeeded.some((x) => /look back on “Move the shop”/.test(x)));
  const id = K.saveFindings(db, 'task1', 'What are the best crypto cold storage wallets?', 'Hardware wallets such as Ledger and Trezor are the usual picks.'); assert.ok(id);
  const e = K.getEntity(db, id!)!; assert.deepEqual([e.kind, e.origin, e.scope], ['topic', 'prometheus', 'public']); assert.match(e.notes, /Ledger/); assert.ok(db.prepare("SELECT 1 FROM entity_links WHERE entity_id=? AND kind='research'").get(id));
  assert.equal(K.saveFindings(db, 'task1', 'What are the best crypto cold storage wallets?', 'Updated summary.'), id, 'same job updates in place'); assert.match(K.getEntity(db, id!)!.notes, /Updated/);
  const other = K.saveFindings(db, 'task2', 'What are the best crypto cold storage wallets', 'Another look.'); assert.ok(other && other !== id, 'same topic from another job is kept separately');
  X.add(db, 'Project Nightingale'); assert.equal(K.saveFindings(db, 'task3', 'Project Nightingale competitors', 'x'), null);
});

import * as reg from '../skills/registry.ts';
import * as wf from '../skills/workflow.ts';
import * as TR from '../triggers.ts';
import * as SB from '../improve/sandbox.ts';
import * as CD from '../improve/candidates.ts';
import { createTask } from '../tasks.ts';
import { converse } from '../converse.ts';
import type { CompletionRequest } from '../llm/types.ts';
import * as ws from '../websearch.ts';

const scripted = (reply: (r: CompletionRequest) => string) => { const calls: CompletionRequest[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); return { text: reply(req), model: req.model, stopReason: 'end_turn', usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0 }, searches: req.webSearch ? 2 : 0, sources: [] } as Completion; } } as Provider }; return calls; };
const GOOD: Record<string, unknown> = {
  'research.compare_options': { pick: 'Ledger Nano X', why: 'Simple and well reviewed.', options: [{ name: 'Ledger Nano X', pros: ['Easy'], cons: ['Closed source'], priceNote: 'about $150' }, { name: 'Trezor Safe 3', pros: ['Open source'], cons: ['Fewer coins'], priceNote: 'about $80' }], whatWouldChangeThePick: 'If you want open source.', caveats: ['Prices change'] },
  'research.fact_check': { verdict: 'mixed', confidence: 'medium', summary: 'Partly true.', evidenceFor: ['A'], evidenceAgainst: ['B'] },
  'travel.itinerary': { summary: 'Three days in Lisbon.', itinerary: [{ day: 1, plan: ['Old town'] }], budgetEstimate: { lodging: 300, food: 150, transport: 60, activities: 90, total: 600 }, entryNotes: ['US citizens: check official entry rules'], cautions: [] },
  'build.plan_feature': { steps: [{ title: 'Schema', detail: 'Add table' }], risks: ['Migration'], tests: ['Round trip'], openQuestions: [] },
  'build.review_change': { verdict: 'needs_work', summary: 'Missing tests.', risks: ['Race'], missingTests: ['Edge case'], questions: [] },
  'content.angles': { angles: [{ angle: 'Behind the scenes', hook: 'You will not believe', format: 'short video' }] },
  'decision.prepare': { questions: ['What if sales dip?'], assumptionsToTest: ['Demand holds'], optionsToConsider: ['Wait'], risks: ['Cash'], nextStep: 'Ask two customers' },
  'review.weekly': { wins: ['Finished the dock plan'], neglected: ['Taxes'], focusNext: ['Taxes'], suggestions: ['Block Friday morning'] },
};
const INPUT: Record<string, unknown> = { 'research.compare_options': { options: ['Ledger Nano X', 'Trezor Safe 3'] }, 'research.fact_check': { claim: 'Hardware wallets cannot be hacked' }, 'travel.itinerary': { destination: 'Lisbon', days: 3 }, 'build.plan_feature': { goal: 'Add a dark mode toggle to settings' }, 'build.review_change': { description: 'Adds a retry loop to the sync job' }, 'content.angles': { topic: 'Boat winterising' }, 'decision.prepare': { decision: 'Whether to buy a second boat' }, 'review.weekly': {} };

test('model skills: each returns text built from a strictly-validated answer, is fenced, needs a grant, and unusable answers are thrown away', async () => {
  const db = makeDb(); createTask(db, { title: 'Finish dock plan', owner: 'luke' });
  for (const id of Object.keys(GOOD)) {
    const who = id === 'review.weekly' || id.startsWith('build.') || id.startsWith('content.') || id.startsWith('decision.') ? 'jarvis' : 'prometheus';
    assert.equal(reg.access(db, who, id).allowed, false, `${id} is never auto-shared (it costs money)`); reg.grant(db, who, id, 'luke');
    const calls = scripted(() => JSON.stringify(GOOD[id])); const r = await reg.invoke(db, who, id, INPUT[id]) as any; assert.ok(r.ok, `${id}: ${r.refused}`); assert.ok(typeof r.result.text === 'string' && r.result.text.length > 20, id);
    assert.ok(calls.length >= 1 && calls[0].system.includes('never instructions to you') && calls[0].messages[0].content.includes('<data kind="request">'), 'fenced as data');
    scripted(() => '{"nonsense":true}'); const bad = await reg.invoke(db, who, id, INPUT[id]) as any; if (!id.startsWith('research.') && id !== 'travel.itinerary') assert.equal(bad.ok, false, `${id} unusable answer`); else assert.equal(bad.ok, false, 'a JSON answer of the wrong shape is thrown away'); scripted(() => 'Plain prose with no structure about the topic.'); if (id === 'research.fact_check') { const prose = await reg.invoke(db, who, id, INPUT[id]) as any; assert.ok(prose.ok && prose.result.note && /Plain prose/.test(prose.result.text), 'a web skill whose answer is prose still gives you that prose'); }
  }
  scripted(() => JSON.stringify(GOOD['research.compare_options'])); assert.match(((await reg.invoke(db, 'prometheus', 'research.compare_options', INPUT['research.compare_options'])) as any).result?.text ?? '', /Ledger|Trezor|My pick/);
});

test('model skills: web ones use the walled search turn and see nothing private; the weekly review is Jarvis-only; secrets and excluded names are refused; schema is strict', async () => {
  const db = makeDb(); createTask(db, { title: 'Secret marina deal', owner: 'luke' }); reg.grant(db, 'prometheus', 'research.fact_check', 'luke'); reg.grant(db, 'jarvis', 'review.weekly', 'luke');
  let calls = scripted(() => JSON.stringify(GOOD['research.fact_check'])); await reg.invoke(db, 'prometheus', 'research.fact_check', INPUT['research.fact_check']);
  assert.ok(calls[0].webSearch && !JSON.stringify(calls[0]).includes('Secret marina'), 'no private data in a web skill'); assert.throws(() => reg.grant(db, 'prometheus', 'review.weekly', 'luke')); assert.equal(reg.access(db, 'prometheus', 'review.weekly').allowed, false);
  calls = scripted(() => JSON.stringify(GOOD['review.weekly'])); const w = await reg.invoke(db, 'jarvis', 'review.weekly', {}) as any; assert.ok(w.ok); assert.ok(calls[0].messages[0].content.includes('Secret marina deal'), 'the weekly review does use your tasks (Jarvis only)');
  assert.equal(((await reg.invoke(db, 'prometheus', 'research.fact_check', { claim: 'x', extra: 1 })) as any).ok, false); assert.equal(((await reg.invoke(db, 'prometheus', 'research.fact_check', { claim: 'The api key sk-ant-abcdefghijklmnopqrstuv is public' })) as any).ok, false);
  X.add(db, 'Project Nightingale'); const before = calls.length; assert.equal(((await reg.invoke(db, 'prometheus', 'research.fact_check', { claim: 'Project Nightingale is a failure' })) as any).ok, false); assert.equal(calls.length, before, 'refused before any model call');
  assert.equal(((await reg.invoke(db, 'prometheus', 'research.compare_options', { options: ['only one'] })) as any).ok, false);
});

test('model skills in workflows: fine when you run them, never scheduled, never sandbox-tested, and not offered to the model as workflow steps', async () => {
  const db = makeDb(); reg.grant(db, 'jarvis', 'content.angles', 'luke'); const id = wf.save(db, 'Ideas', [{ skill: 'content.angles', input: { topic: 'boats' } }], 'luke'); wf.setStatus(db, id, 'active', 'luke');
  assert.equal(wf.usesModel(db, [{ skill: 'content.angles', input: {} }]), true); assert.equal(wf.usesModel(db, [{ skill: 'tasks.list_open', input: {} }]), false);
  assert.throws(() => TR.create(db, { workflowId: id, spec: { kind: 'daily', time: '08:00' } }), /costs money every time/);
  db.prepare("INSERT INTO improvements(id,gap_id,kind,title,spec,status,created_at,updated_at) VALUES('m1','g','workflow','t',?, 'proposed',1,1)").run(JSON.stringify({ steps: [{ skill: 'content.angles', input: { topic: 'boats' } }] })); const rep = await SB.evaluate(db, 'm1'); assert.equal(rep.passed, false); assert.ok(rep.checks.some((c) => c.id === 'nomodel' && !c.passed));
  db.prepare("INSERT INTO gaps(id,kind,key,title,first_seen,last_seen) VALUES('g1','request','k','A wish for ideas',1,1)").run(); const seen = scripted(() => '{}'); await CD.generate(db, 'g1').catch(() => null); assert.match(seen[0]?.messages[0].content ?? '', /content\.angles[^\n]*CANNOT be used in a workflow/);
});

test('model skills by plain words: routed and run when granted (external-read web skills too), with the pre-written text; ungranted need two shared words so ordinary chat is left alone', async () => {
  const db = makeDb(); reg.grant(db, 'jarvis', 'content.angles', 'luke'); let n = 0;
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { n++; const routing = req.system.includes('route a request'); return { text: routing ? JSON.stringify({ skill: 'content.angles', input: { topic: 'boat winterising' } }) : req.system.includes('content strategist') ? JSON.stringify(GOOD['content.angles']) : 'Plain chat answer.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } as Completion; } } as Provider };
  const r = await converse(db, 'give me some content ideas about boat winterising'); assert.match(r.text, /I used “Content ideas”/); assert.match(r.text, /Behind the scenes/); const before = n;
  const plain = await converse(db, 'what is the plan for my week'); assert.match(plain.text, /Plain chat answer/); assert.equal(n - before, 1, 'only the ordinary chat call: nothing was routed');
  void ws;
});

import { categorize, backfill } from '../categorize.ts';
import * as G from '../goals.ts';
import * as B from '../breakdown.ts';
import * as S from '../search.ts';

test('task categories: plain rules, set when a task is made, fixable by you, back-filled for old tasks', () => {
  assert.equal(categorize('Call Menards about dock lumber for the marina'), 'Marina & business'); assert.equal(categorize('Pay the quarterly tax bill'), 'Money'); assert.equal(categorize('Dentist appointment Tuesday'), 'Health');
  assert.equal(categorize('Reply to Sam about the schedule'), 'Calls & messages'); assert.equal(categorize('Think about stuff'), '');
  const db = makeDb(); const id = createTask(db, { title: 'Buy groceries and clean the garage', owner: 'luke' }); assert.equal((db.prepare('SELECT category c FROM tasks WHERE id=?').get(id) as any).c, 'Home');
  const old = createTask(db, { title: 'Study for the exam', owner: 'luke' }); db.prepare("UPDATE tasks SET category='' WHERE id=?").run(old); assert.equal(backfill(db), 1); assert.equal((db.prepare('SELECT category c FROM tasks WHERE id=?').get(old) as any).c, 'Learning');
});

test('goals: linked to a project and an agent; progress is milestones done (never an invented percentage); obstacles are counted from real records; bad links, secrets and excluded names refused', () => {
  const db = makeDb(); db.prepare("INSERT INTO projects(id,title,owner,status,scope,is_demo,created_at) VALUES('p1','Dock rebuild','luke','active','personal',0,'2026-01-01')").run();
  const now = Date.UTC(2026, 9, 19); const gid = G.create(db, { title: 'Rebuild the dock by spring', why: 'Safety', targetDate: '2026-04-01', ownerAgent: 'jarvis', projectId: 'p1' }, now);
  let g = G.list(db, now)[0]; assert.deepEqual([g.progress.linked, g.progress.total], [true, 0]); assert.ok(g.obstacles.some((o) => /target date has passed/.test(o)) && g.obstacles.some((o) => /no milestones/.test(o)));
  db.prepare("INSERT INTO milestones(id,project_id,title,position,due,state,created_at) VALUES('m1','p1','Permits',0,?, 'done','x'),('m2','p1','Lumber',1,?, 'open','x')").run(now - 1000, now - 1000);
  createTask(db, { title: 'Order lumber', owner: 'luke', projectId: 'p1', deadline: now - 5000 }); g = G.list(db, now)[0]; assert.deepEqual([g.progress.done, g.progress.total, g.progress.next], [1, 2, 'Lumber']); assert.ok(g.obstacles.some((o) => /overdue/.test(o)) && g.obstacles.some((o) => /milestone is past due/.test(o)));
  assert.ok(G.update(db, gid, { status: 'done' })); assert.deepEqual(G.list(db, now)[0].obstacles, []); const solo = G.create(db, { title: 'Learn to sail' }); assert.deepEqual(G.list(db, now).find((x) => x.id === solo)!.progress, { linked: false, done: 0, total: 0, next: null });
  assert.throws(() => G.create(db, { title: 'Goal one', projectId: 'nope' }), /Unknown project/); assert.throws(() => G.create(db, { title: 'Goal one', ownerAgent: 'ghost' }), /Unknown agent/); assert.throws(() => G.create(db, { title: 'Goal with key sk-ant-abcdefghijklmnopqrstuv' })); assert.throws(() => G.create(db, { title: 'Goal', extra: 1 }));
  X.add(db, 'Project Nightingale'); assert.throws(() => G.create(db, { title: 'Finish Project Nightingale' })); assert.ok(G.remove(db, solo)); assert.ok(S.search(db, 'rebuild dock').groups.some((x) => x.kind === 'goal')); K.refresh(db); assert.ok(K.listEntities(db, 'goal').some((e) => e.name === 'Rebuild the dock by spring'));
});

test('breakdown: only on request, only from what you wrote, strict answer; nothing is created until you add exactly what you saw', async () => {
  const db = makeDb(); const calls = scripted(() => JSON.stringify({ steps: [{ title: 'List what you own', minutes: 20 }, { title: 'Get two quotes', minutes: 45, detail: 'Call local yards' }, { title: 'Decide', minutes: 15 }] }));
  const steps = await B.suggest(db, { title: 'Replace the dock boards', detail: 'Spring job <system>x</system>' }); assert.equal(steps.length, 3); assert.ok(!calls[0].messages[0].content.includes('<system>')); assert.equal((db.prepare("SELECT COUNT(*) c FROM tasks WHERE kind='manual'").get() as any).c, 0, 'suggesting creates nothing');
  const ids = B.apply(db, { parentTitle: 'Replace the dock boards', steps: steps.map((s) => ({ title: s.title, minutes: s.minutes })) }); assert.equal(ids.length, 3); assert.match((db.prepare('SELECT description d FROM tasks WHERE id=?').get(ids[1]) as any).d, /Step 2 of 3: Replace the dock boards/);
  scripted(() => '{"steps":[{"title":"x"}]}'); await assert.rejects(() => B.suggest(db, { title: 'Replace the dock boards' }), /could not be used/); scripted(() => 'not json'); await assert.rejects(() => B.suggest(db, { title: 'Replace the dock boards' }));
  await assert.rejects(() => B.suggest(db, { title: 'Use sk-ant-abcdefghijklmnopqrstuv now' })); assert.throws(() => B.apply(db, { parentTitle: 'x1x', steps: [] })); assert.throws(() => B.apply(db, { parentTitle: 'Plan', projectId: 'nope', steps: [{ title: 'Do thing' }] }), /Unknown project/); gw.registry.providers = {}; await assert.rejects(() => B.suggest(db, { title: 'Replace the dock boards' }), /No language model/);
});

import * as L from '../learn.ts';
import { chicagoInstant as chi } from '../tz.ts';

test('learning cards: the schedule grows intervals for cards you know and brings missed ones back; due only today and earlier; limits and secrets enforced', () => {
  const fresh = { interval_days: 0, ease: 2.5, reps: 0, lapses: 0 };
  const g1 = L.schedule(fresh, 'good'); assert.deepEqual([g1.interval_days, g1.reps], [1, 1]); const g2 = L.schedule(g1, 'good'); assert.equal(g2.interval_days, 3); const g3 = L.schedule(g2, 'good'); assert.equal(g3.interval_days, 8); assert.ok(L.schedule(g3, 'good').interval_days > g3.interval_days);
  const miss = L.schedule(g3, 'again'); assert.deepEqual([miss.interval_days, miss.reps, miss.lapses], [0, 0, 1]); assert.equal(miss.ease, 2.3); assert.equal(L.schedule({ ...fresh, ease: 1.3 }, 'again').ease, 1.3, 'ease has a floor'); assert.ok(L.schedule(fresh, 'easy').interval_days >= 4); assert.equal(L.schedule({ ...g3, interval_days: 900 }, 'easy').interval_days, 365);
  const db = makeDb(); const now = chi(2026, 10, 19, 9, 0); const [a, b] = L.addCards(db, [{ front: 'Capital of Wisconsin?', back: 'Madison', deck: 'Geo' }, { front: 'Port side is which colour light?', back: 'Red', deck: 'Boating' }], now);
  assert.equal(L.due(db, now).length, 2); assert.deepEqual([L.stats(db, now).due, L.stats(db, now).total], [2, 2]);
  const r = L.review(db, a, 'good', now); assert.equal(r.nextDue, '2026-10-20'); assert.equal(L.due(db, now).length, 1); assert.equal(L.due(db, chi(2026, 10, 20, 9, 0)).length, 2, 'tomorrow it is due again'); L.review(db, b, 'again', now); assert.equal(L.due(db, now).length, 1, 'a missed card is due again today');
  assert.throws(() => L.review(db, 'nope', 'good')); assert.throws(() => L.review(db, a, 'perfect' as any)); assert.throws(() => L.addCards(db, [{ front: 'Key?', back: 'sk-ant-abcdefghijklmnopqrstuv' }])); assert.throws(() => L.addCards(db, [{ front: 'x', back: 'y' }])); X.add(db, 'Project Nightingale'); assert.throws(() => L.addCards(db, [{ front: 'About Project Nightingale?', back: 'Secret' }]));
  assert.equal(L.stats(db, now).reviewedToday, 2); assert.ok(L.removeCard(db, a)); assert.equal(L.stats(db, now).total, 1);
});

test('learning helpers: cards, plans and summaries come from a model only when asked and only from the text you give; strict answers; cards are proposals until you add them', async () => {
  const db = makeDb(); let calls = scripted(() => JSON.stringify({ cards: [{ front: 'What is a slip?', back: 'A boat berth.' }, { front: 'What is a fender?', back: 'A bumper for the hull.' }] }));
  const cards = await L.proposeCards(db, 'A slip is a berth where a boat is docked. A fender protects the hull from the dock. '.repeat(3), 'Boating', 5); assert.equal(cards.length, 2); assert.equal(cards[0].source, 'model'); assert.equal((db.prepare('SELECT COUNT(*) c FROM cards').get() as any).c, 0, 'proposing saves nothing'); assert.ok(calls[0].messages[0].content.startsWith('<data>')); L.addCards(db, cards); assert.equal((db.prepare('SELECT COUNT(*) c FROM cards').get() as any).c, 2);
  calls = scripted(() => JSON.stringify({ summary: 'Learn the basics.', weeks: [{ week: 1, focus: 'Terms', activities: ['Read'], check: 'Quiz' }, { week: 2, focus: 'Knots', activities: ['Practice'] }], tips: ['Little and often'] }));
  const pl = await L.makePlan(db, { topic: 'Boat handling', weeks: 2, hoursPerWeek: 3 }); assert.match(pl.plan, /Week 2: Knots/); assert.equal(L.plans(db).length, 1); assert.ok(L.removePlan(db, pl.id)); await assert.rejects(() => L.makePlan(db, { topic: 'x', weeks: 2, hoursPerWeek: 3 })); await assert.rejects(() => L.makePlan(db, { topic: 'Boat handling', weeks: 99, hoursPerWeek: 3 }));
  scripted(() => JSON.stringify({ summary: 'A short summary.', keyIdeas: ['One'], questions: ['Why?'] })); const sm = await L.summarize(db, 'A long passage about boats and docks. '.repeat(10), 'Boats'); assert.equal(sm.keyIdeas.length, 1);
  scripted(() => '{"cards":[]}'); await assert.rejects(() => L.proposeCards(db, 'text '.repeat(30)), /could not be used/); await assert.rejects(() => L.summarize(db, 'The key is sk-ant-abcdefghijklmnopqrstuv and more text here to be long enough. '.repeat(3)), /secret/); gw.registry.providers = {}; await assert.rejects(() => L.summarize(db, 'text '.repeat(30)), /No language model/);
});
