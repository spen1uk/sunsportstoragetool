import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { CompletionRequest, Completion, Provider } from '../llm/types.ts';
import { converse } from '../converse.ts';
import * as AL from '../autolearn.ts';
import * as memory from '../memory.ts';
import * as X from '../exclusions.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
/** A scripted model: the auto-learn call (identified by its system text) returns `facts`; everything else is ordinary chat. */
function script(facts: unknown[]) { const calls: CompletionRequest[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); const learn = req.system.includes('durable worth remembering'); return { text: learn ? JSON.stringify({ facts }) : 'Very good, sir.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } as Completion; } } as Provider }; return calls; }
const learnCalls = (c: CompletionRequest[]) => c.filter((x) => x.system.includes('durable worth remembering'));
const mem = (db: any) => db.prepare("SELECT content, kind, status, source FROM memories WHERE source='auto' AND superseded_by IS NULL").all() as any[];
const settle = () => new Promise((r) => setTimeout(r, 30));

test('the cheap check lets through statements about himself and stops questions, requests, pasted blocks and long text before any model call', () => {
  for (const t of ['I prefer text messages before 8 AM', 'My wife is Sarah and her birthday is March 3', 'We decided to open the second barn in May', 'From now on call me boss']) assert.equal(AL.worthLearning(t), true, t);
  for (const t of ['what is the weather tomorrow?', 'add a task to call Reid', 'hi', 'ok thanks', 'x'.repeat(700), 'I like it\n'.repeat(10), 'I prefer this: https://a.example/x and https://b.example/y', 'open the dock page', 'The sky is blue today']) assert.equal(AL.worthLearning(t), false, t);
});

test('a durable statement in chat is written down quietly: source auto, preference status for preferences, listed under Recently learned; ordinary requests cost no extra call', async () => {
  const db = makeDb(); const calls = script([{ text: 'Prefers text messages before 8 AM.', kind: 'preference', correction: false }]);
  const r = await converse(db, 'I prefer text messages before 8 AM, never calls'); await settle();
  assert.doesNotMatch(r.text, /learn|remember|noted/i, 'quiet in chat'); assert.equal(learnCalls(calls).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(mem(db))), [{ content: 'Prefers text messages before 8 AM.', kind: 'preference', status: 'preference', source: 'auto' }]);
  assert.match(AL.describeLearned(db), /Prefers text messages before 8 AM/); assert.equal(AL.listLearned(db).length, 1);
  await converse(db, 'how are you today'); await settle(); assert.equal(learnCalls(calls).length, 1, 'no model call for chit-chat');
});

test('never from private mode; never secrets or excluded names; a duplicate is merged not repeated; the daily save cap holds', async () => {
  const db = makeDb(); let calls = script([{ text: 'Prefers tea.', kind: 'preference', correction: false }]);
  await converse(db, 'I always prefer tea in the morning', { private: true }); await settle(); assert.equal(learnCalls(calls).length, 0); assert.equal(mem(db).length, 0);
  calls = script([{ text: 'The wifi password is hunter2hunter2.', kind: 'fact', correction: false }, { text: 'Works with Project Nightingale.', kind: 'project', correction: false }]); X.add(db, 'Project Nightingale');
  assert.equal(await AL.learnFrom(db, 'My wifi password is hunter2hunter2 and I work with Project Nightingale'), 0, 'prefilter and secret check');
  assert.equal(await AL.learnFrom(db, 'I usually work from the shop on Fridays and my wifi password is hunter2hunter2'), 0, 'a secret in the message stops it before any call'); assert.equal(learnCalls(calls).length, 0);
  calls = script([{ text: 'The wifi password is hunter2hunter2.', kind: 'fact', correction: false }, { text: 'Works with Project Nightingale.', kind: 'project', correction: false }]);
  assert.equal(await AL.learnFrom(db, 'I usually work from the shop on Fridays'), 0, 'a secret or an excluded name in the model reply is refused by memory.remember'); assert.equal(mem(db).length, 0);
  script([{ text: 'Works from the shop on Fridays.', kind: 'routine', correction: false }]); assert.equal(await AL.learnFrom(db, 'I usually work from the shop on Fridays'), 1); assert.equal(await AL.learnFrom(db, 'I usually work from the shop on Fridays'), 0, 'duplicate merged'); assert.equal(mem(db).length, 1);
  for (let i = 0; i < 25; i++) { script([{ text: `Likes flavour number ${i} ice cream.`, kind: 'preference', correction: false }]); await AL.learnFrom(db, `I really love flavour number ${i} ice cream every week`); }
  assert.ok(mem(db).length <= 20, `capped at 20 a day, got ${mem(db).length}`);
});

test('corrections win: a flagged correction replaces the earlier fact; an unflagged conflict goes to Needs your decision; two facts at most per message', async () => {
  const db = makeDb(); memory.remember(db, 'Gym is on Wednesday at 6 AM.', { source: 'luke' });
  script([{ text: 'Gym is on Thursday at 6 AM.', kind: 'routine', correction: true }]); assert.equal(await AL.learnFrom(db, 'No, my gym is actually on Thursday at 6 AM, always has been'), 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM memories WHERE content LIKE 'Gym is on Wednesday%' AND superseded_by IS NULL").get() as any).c, 0); assert.match(AL.describeLearned(db), /Thursday/);
  const db2 = makeDb(); memory.remember(db2, 'Storage rate is $12 per foot.', { source: 'luke' });
  script([{ text: 'Storage rate is $15 per foot.', kind: 'fact', correction: false }]); assert.equal(await AL.learnFrom(db2, 'Our storage rate is $15 per foot for next season, I decided'), 1);
  assert.equal(memory.listReviews(db2).length, 1, 'both kept until Luke decides');
  const db3 = makeDb(); script([1, 2, 3].map((i) => ({ text: `Fact number ${i} about the shop hours.`, kind: 'fact', correction: false }))); assert.ok((await AL.learnFrom(db3, 'We open the shop at nine and close at five, I decided')) <= 2);
});

test('in chat: "what have you learned", "forget what you just learned", and the off and on switches; off means no model call', async () => {
  const db = makeDb(); const calls = script([{ text: 'Wife is Sarah.', kind: 'person', correction: false }]);
  await converse(db, 'My wife is Sarah, remember that'); await settle(); assert.equal(mem(db).length, 1);
  assert.match((await converse(db, 'what have you learned')).text, /Wife is Sarah/);
  assert.match((await converse(db, 'forget what you just learned')).text, /forgotten the one thing/); assert.equal(mem(db).length, 0);
  assert.match((await converse(db, 'stop learning automatically')).text, /only remember what you tell me/); assert.equal(AL.autoLearnOn(db), false);
  const before = learnCalls(calls).length; await converse(db, 'My brother is Tom, remember that'); await settle(); assert.equal(learnCalls(calls).length, before, 'switched off: no call'); assert.equal(mem(db).length, 0);
  assert.match((await converse(db, 'start learning automatically')).text, /write down lasting things/); assert.equal(AL.autoLearnOn(db), true);
});

test('over HTTP the list and switch exist, and the source never prints the model text anywhere but memory', () => {
  const src = fs.readFileSync(new URL('../autolearn.ts', import.meta.url), 'utf8'); assert.doesNotMatch(src, /console\./);
  const http = fs.readFileSync(new URL('../http.ts', import.meta.url), 'utf8'); assert.match(http, /'\/api\/memory\/learned'/); assert.match(http, /'\/api\/memory\/autolearn'/);
});
