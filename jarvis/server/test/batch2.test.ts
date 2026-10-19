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
