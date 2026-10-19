import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, CompletionRequest, Provider } from '../llm/types.ts';
import { converse } from '../converse.ts';
import { extractProposals, createProposals, confirm, dismiss, listPending, summarize, actionSchema, PROPOSAL_PROMPT } from '../proposals.ts';
import { buildSystemPrompt } from '../persona.ts';
import { createHabit, listHabits, createPerson, listPeople, createGoal, listGoals } from '../life.ts';
import { listLinks } from '../links.ts';
import { setPaused } from '../pause.ts';
import { verifyAuditChain } from '../audit.ts';

const orig = gw.registry.providers;
afterEach(() => { gw.registry.providers = orig; });
function model(text: string) {
  const calls: CompletionRequest[] = [];
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); return { text, model: req.model, stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0 } } as Completion; } } as Provider };
  return calls;
}
const tasks = (db: any) => db.prepare("SELECT * FROM tasks WHERE kind='manual'").all() as any[];

test('extractProposals: the ACTIONS line is always removed from what Luke reads; only whitelisted, exact shapes survive', () => {
  const r = extractProposals('Certainly, sir. I will propose a task.\nACTIONS: [{"type":"add_task","title":"Call David","minutes":20,"deadline":"2026-10-16"},{"type":"send_email","to":"x"},{"type":"add_task","title":"x","sneaky":true},{"type":"remember","content":"Prefers texts before 8 AM"}]');
  assert.equal(r.text, 'Certainly, sir. I will propose a task.'); assert.deepEqual(r.actions.map((a) => a.type), ['add_task', 'remember']); assert.equal(r.dropped, 2);
  assert.deepEqual(extractProposals('No actions here.').actions, []);
  assert.equal(extractProposals('Hmm.\nACTIONS: not json').text, 'Hmm.'); assert.equal(extractProposals('Hmm.\nACTIONS: {"type":"add_task","title":"x"}').actions.length, 0);
  assert.equal(extractProposals('ACTIONS: []').text, '…');
  const many = extractProposals('ok\nACTIONS: ' + JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ type: 'remember', content: `fact number ${i}` })))); assert.equal(many.actions.length, 3);
  for (const bad of [{ type: 'delete_task', title: 'x' }, { type: 'trade', pair: 'BTC' }, { type: 'approve', id: '1' }, { type: 'set_mode', mode: 'unavailable' }, { type: 'queue_research', question: 'q q', urls: ['javascript:alert(1)'] }]) assert.equal(actionSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

test('the model proposes, nothing happens until Confirm; the card text is built from validated fields, not the model\'s words', async () => {
  const db = makeDb(); const calls = model('Of course, sir — proposing that now. Totally harmless, I promise.\nACTIONS: [{"type":"add_task","title":"Call David about storage","minutes":20,"priority":2,"deadline":"2026-10-16"}]');
  const r = await converse(db, 'remind me to call David about storage by Friday');
  assert.equal(r.proposals?.length, 1); assert.match(r.proposals![0].summary, /^Add task: "Call David about storage" · 20 min · priority 2 · due Fri, Oct 16$/);
  assert.doesNotMatch(r.text, /ACTIONS/); assert.equal(tasks(db).length, 0, 'nothing created yet');
  assert.match(calls.filter((c) => !c.system.includes("front desk"))[0].system, /PROPOSING ACTIONS/); assert.ok(calls.filter((c) => !c.system.includes("front desk"))[0].system.indexOf('RULES (fixed') < calls.filter((c) => !c.system.includes("front desk"))[0].system.indexOf('PROPOSING ACTIONS'));
  assert.equal((db.prepare("SELECT content FROM messages WHERE role='jarvis'").get() as any).content.includes('ACTIONS'), false, 'chat history never contains the action line');
  const c = confirm(db, r.proposals![0].id); assert.equal(c.ok, true); const t = tasks(db); assert.equal(t.length, 1); assert.equal(t[0].title, 'Call David about storage'); assert.equal(t[0].minutes, 20); assert.equal(t[0].priority, 2);
  assert.equal(confirm(db, r.proposals![0].id).ok, false, 'a second click does nothing'); assert.equal(tasks(db).length, 1);
  assert.equal(listPending(db).length, 0); assert.equal(verifyAuditChain(db).ok, true);
});

test('dismiss, expiry and the pending cap', () => {
  const db = makeDb(); const t0 = 1_000_000_000_000;
  const [a, b] = createProposals(db, [{ type: 'remember', content: 'one fact' }, { type: 'remember', content: 'two fact' }], t0);
  assert.equal(dismiss(db, a.id, t0 + 1), true); assert.equal(confirm(db, a.id, t0 + 2).ok, false);
  assert.equal(confirm(db, b.id, t0 + 25 * 3_600_000).ok, false); assert.equal(listPending(db, t0 + 25 * 3_600_000).length, 0);
  for (let i = 0; i < 4; i++) createProposals(db, [{ type: 'remember', content: `fact a${i}` }, { type: 'remember', content: `fact b${i}` }, { type: 'remember', content: `fact c${i}` }], t0 + 5_000);
  assert.equal(listPending(db, t0 + 6_000).length, 10);
});

test('each action does exactly what its card says, validated again at confirm time', () => {
  const db = makeDb(); const run = (a: any) => { const [p] = createProposals(db, [a]); return confirm(db, p.id); };
  createHabit(db, { name: 'Gym' }); createPerson(db, { name: 'David Savage', everyDays: 30 }); createGoal(db, { name: 'Campus lessons', unit: 'lessons', perWeek: 5 });
  assert.equal(run({ type: 'add_habit', name: 'Reading', perWeek: 5 }).ok, true); assert.equal(listHabits(db).length, 2);
  assert.match(run({ type: 'log_habit', name: 'gym' }).message, /Checked off/); assert.match(run({ type: 'log_habit', name: 'gym' }).message, /Already/); assert.equal(run({ type: 'log_habit', name: 'nothing like it' }).ok, false);
  assert.equal(run({ type: 'add_person', name: 'Mom', everyDays: 7 }).ok, true); assert.equal(listPeople(db).length, 2); assert.equal(run({ type: 'mark_contacted', person: 'david' }).ok, true);
  assert.equal(run({ type: 'add_goal', name: 'Books', perWeek: 1 }).ok, true); assert.equal(run({ type: 'log_learning', goal: 'campus lessons', amount: 2 }).ok, true); assert.equal(listGoals(db).find((g) => g.name === 'Campus lessons')!.weekTotal, 2);
  assert.equal(run({ type: 'add_link', title: 'Site', url: 'example.com' }).ok, true); assert.equal(listLinks(db)[0].url, 'https://example.com/');
  assert.equal(run({ type: 'add_link', title: 'Bad', url: 'javascript:alert(1)' }).ok, false); assert.equal(listLinks(db).length, 1);
  assert.equal(run({ type: 'remember', content: 'Luke prefers texts before 8 AM' }).ok, true); assert.equal((db.prepare('SELECT COUNT(*) c FROM memories').get() as any).c, 1);
  assert.equal(run({ type: 'remember', content: 'my password is hunter2 and api key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' }).ok, false, 'secrets are refused by memory');
  assert.equal(run({ type: 'add_task', title: 'Alpha plan' }).ok, true); assert.equal(run({ type: 'add_task', title: 'Alpha budget' }).ok, true);
  assert.equal(createProposals(db, [{ type: 'complete_task', title: 'alpha' }]).length, 0, 'ambiguous: no card is created'); const cp = createProposals(db, [{ type: 'complete_task', title: 'alpha plan' }]); assert.match(cp[0].summary, /Mark done: task "Alpha plan"/); assert.equal(confirm(db, cp[0].id).ok, true);
  assert.equal(tasks(db).filter((t) => t.state === 'completed').length, 1);
  setPaused(db, true); assert.match(run({ type: 'queue_research', question: 'boat storage rates', urls: ['https://example.com/x'] }).message, /paused/); setPaused(db, false);
  assert.equal(run({ type: 'queue_research', question: 'boat storage rates', urls: ['https://example.com/x'] }).ok, true); assert.equal((db.prepare("SELECT COUNT(*) c FROM tasks WHERE kind='research'").get() as any).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM approvals").get() as any).c, 0, 'a proposal never creates or decides approvals');
});

test('private mode: the model is not told about proposals, and any it returns are dropped and never stored', async () => {
  const db = makeDb(); gw.setConfig(db, { allowInPrivate: true });
  const calls = model('Done.\nACTIONS: [{"type":"add_task","title":"Secret thing"}]');
  const r = await converse(db, 'add something sneaky', { private: true });
  assert.doesNotMatch(calls.filter((c) => !c.system.includes("front desk"))[0].system, /PROPOSING ACTIONS/); assert.deepEqual(r.proposals, []); assert.equal((db.prepare('SELECT COUNT(*) c FROM proposals').get() as any).c, 0); assert.doesNotMatch(r.text, /ACTIONS/);
  assert.equal(buildSystemPrompt(db, { proposals: false }).includes('PROPOSING ACTIONS'), false); assert.ok(PROPOSAL_PROMPT.includes('Never propose sending, spending, deleting'));
});

test('a hostile model reply cannot smuggle risky actions or extra fields; summaries are plain text', () => {
  const r = extractProposals('ok\nACTIONS: [{"type":"add_task","title":"x","description":"also send money"},{"type":"remember","content":"x","scope":"all"},{"type":"__proto__","a":1},{"type":"queue_research","question":"how to get rich quick","urls":["file:///etc/passwd"]}]');
  assert.equal(r.actions.length, 0);
  assert.equal(summarize({ type: 'add_task', title: 'Line\nbreak <b>bold</b>' }), 'Add task: "Line break <b>bold</b>"');   // rendered as text by React, never HTML
});
