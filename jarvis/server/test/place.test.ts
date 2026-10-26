import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { CompletionRequest, Completion, Provider } from '../llm/types.ts';
import { converse } from '../converse.ts';
import * as P from '../place.ts';
import * as ws from '../websearch.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
function script() { const calls: CompletionRequest[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); const web = !!req.webSearch; return { text: web ? 'Sunny and 64 tomorrow, rain holding off until evening.' : 'Your morning is clear, sir, and it will be sunny and 64.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }, searches: web ? 1 : 0, sources: [] } as Completion; } } as Provider }; return calls; }
const webQs = (c: CompletionRequest[]) => c.filter((x) => x.webSearch).map((x) => String(x.messages[x.messages.length - 1].content));

test('places are parsed from replies and statements, and not from chit-chat or requests', () => {
  for (const [t, pend, want] of [['I am in Oconomowoc WI', true, 'Oconomowoc, WI'], ['Oconomowoc, WI', true, 'Oconomowoc, WI'], ['oconomowoc wi', true, 'Oconomowoc, WI'], ["I'm in Lake Country", true, 'Lake Country'], ['in Hartland', true, 'Hartland'], ['Milwaukee', true, 'Milwaukee'], ['I live in Pewaukee, Wisconsin', false, 'Pewaukee Wisconsin'], ['my city is Delafield WI', false, 'Delafield, WI']] as const) assert.equal(P.parsePlace(t, pend), want, t);
  for (const [t, pend] of [['I am in Oconomowoc WI', false], ['yes', true], ['no thanks', true], ['never mind', true], ['what is the weather tomorrow', true], ['I need to call Reid about the dock', true], ['please check the forecast', true], ['I am in a meeting', false]] as const) assert.equal(P.parsePlace(t, pend), null, `${t} / ${pend}`);
});

test('the weather question the first time: Jarvis asks for the city, and the answer finishes the ORIGINAL question (not whatever was searched before)', async () => {
  const db = makeDb(); ws.setConfig(db, { enabled: true, perDay: 15 }); const calls = script();
  const first = await converse(db, "what's the weather tomorrow?"); assert.equal(first.text, P.ASK); assert.equal(webQs(calls).length, 0, 'no search without a place');
  const second = await converse(db, 'I am in Oconomowoc WI'); assert.match(second.text, /Sunny and 64/); const q = webQs(calls); assert.equal(q.length, 1); assert.match(q[0], /weather tomorrow/i); assert.match(q[0], /Oconomowoc, WI/);
  assert.equal(P.getPlace(db), 'Oconomowoc, WI'); assert.ok(db.prepare("SELECT 1 FROM memories WHERE content='Based in Oconomowoc, WI.'").get(), 'kept as a memory');
  await converse(db, 'and what about the weather this weekend?'); const q2 = webQs(calls); assert.match(q2[q2.length - 1], /Oconomowoc, WI/, 'remembered: no need to say it again');
  await converse(db, 'what is the weather in Madison?'); assert.match(webQs(calls).pop()!, /Madison/); assert.doesNotMatch(webQs(calls).pop()!, /Oconomowoc/, 'a place he names wins');
});

test('the combined question: with no place Jarvis answers the calendar part and asks for the city; the reply then completes both parts', async () => {
  const db = makeDb(); ws.setConfig(db, { enabled: true, perDay: 15 }); const calls = script();
  const a = await converse(db, "what's the weather tomorrow and what's on my calendar in the morning?"); assert.equal(webQs(calls).length, 0); const chat = calls.filter((c) => /You are Jarvis, the personal assistant/.test(c.system)); assert.match(chat[0].system, /you do not know where Luke is/); assert.ok(a.text);
  await converse(db, 'Oconomowoc WI'); assert.match(webQs(calls)[0], /Oconomowoc, WI/); const chat2 = calls.filter((c) => /You are Jarvis, the personal assistant/.test(c.system)).pop()!; assert.match(chat2.system, /INTERNET RESULT[\s\S]*Sunny and 64/);
});

test('"I live in …" is remembered without a question; "forget where I live" removes the setting and the memory; moving on drops the pending question; web search off asks nothing', async () => {
  const db = makeDb(); script();
  assert.match((await converse(db, 'I live in Hartland, WI')).text, /Noted, sir: Hartland, WI/); assert.equal(P.getPlace(db), 'Hartland, WI');
  assert.match((await converse(db, 'forget where I live')).text, /forgotten where you are/); assert.equal(P.getPlace(db), null); assert.equal(db.prepare("SELECT COUNT(*) c FROM memories WHERE content LIKE 'Based in%'").get()!.c, 0);
  assert.match((await converse(db, 'I am in a meeting')).text, /./); assert.equal(P.getPlace(db), null, 'transient statements are not a home');
  ws.setConfig(db, { enabled: false, perDay: 15 }); const r = await converse(db, "what's the weather tomorrow?"); assert.notEqual(r.text, P.ASK, 'with web search off Jarvis says so instead of asking for a city'); assert.equal(P.pending(db), null);
  ws.setConfig(db, { enabled: true, perDay: 15 }); await converse(db, "what's the weather tomorrow?"); assert.ok(P.pending(db)); assert.equal(P.pending(db, Date.now() + 16 * 60_000), null, 'forgotten after 15 minutes');
});

test('a new message is not read as a follow-up to a stale web topic: web history is only the web exchanges at the very end, from the last 20 minutes', async () => {
  const db = makeDb(); ws.setConfig(db, { enabled: true, perDay: 15 }); const calls = script();
  await converse(db, 'which restaurants are open late near me tonight'); P.setPlace(db, 'Oconomowoc, WI');
  db.prepare("UPDATE messages SET at=?").run(new Date(Date.now() - 30 * 60_000).toISOString());   // that was half an hour ago
  await converse(db, "what's the weather tomorrow?"); const last = calls.filter((c) => c.webSearch).pop()!; assert.deepEqual(last.messages.map((m) => m.role), ['user'], 'no old food conversation in the weather search');
});
