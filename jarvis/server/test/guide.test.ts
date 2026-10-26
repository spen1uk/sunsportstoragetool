import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDb } from './helpers.ts';
import { buildSystemPrompt, guideFor, backupSavedPersona, setPersona, getPersona } from '../persona.ts';

test('the guide is in the system prompt for chat, under the fixed rules, with the not-connected list; the fixed rules and the capability truth still come first', () => {
  const db = makeDb(); const p = buildSystemPrompt(db, { channel: 'dashboard' });
  assert.ok(p.indexOf('RULES (fixed') < p.indexOf('PERSONALITY AND RESPONSE GUIDE') && p.indexOf('PERSONALITY AND RESPONSE GUIDE') < p.indexOf('CAPABILITIES (truth source)'));
  assert.match(p, /JARVIS, Lukas Spencer's personal AI assistant/); assert.match(p, /## 2\. How you answer/); assert.match(p, /Answer everything he asked/); assert.match(p, /Cite your sources/); assert.match(p, /NOT CONNECTED YET[\s\S]*texting, calling or emailing/);
  assert.match(p, /Answer every question and request in Luke's latest message/); assert.match(p, /Do not mention, correct, or apologise for earlier replies/); assert.doesNotMatch(p, /British English/);
  assert.match(p, /Where these preferences conflict with the personality guide, the guide wins/);
  assert.doesNotMatch(p, /‚Ä¶/, 'no garbled characters');
});

test('each channel gets only the parts it needs: screen gets writing style and examples, texts get writing style without examples, voice gets speaking style only', () => {
  const screen = guideFor('dashboard', false), sms = guideFor('sms', false), voice = guideFor('voice', true);
  assert.match(screen, /## 3\. Writing style/); assert.match(screen, /## 11\. A few examples/); assert.doesNotMatch(screen, /## 4\. Speaking style/);
  assert.match(sms, /## 3\. Writing style/); assert.doesNotMatch(sms, /## 11\./);
  assert.match(voice, /## 4\. Speaking style/); assert.doesNotMatch(voice, /## 3\. Writing style|## 11\./);
  for (const g of [screen, sms, voice]) for (const n of [1, 2, 5, 6, 7, 8, 9, 10]) assert.match(g, new RegExp(`## ${n}\\. `), `section ${n}`);
  assert.match(buildSystemPrompt(makeDb(), { brief: true, channel: 'car' }), /under about 60 words/);
});

test('the guide cannot loosen the code: the capability list still marks unconnected things, and the guide text is placed as instructions from Luke, not as data', () => {
  const db = makeDb(); const p = buildSystemPrompt(db, { channel: 'dashboard' });
  assert.match(p, /the CAPABILITIES list is the truth/); assert.match(p, /\(do not claim this works\)/);
  // approvals are enforced in code, not by the prompt: the always-ask list is untouched
  const src = fs.readFileSync(new URL('../approvals.ts', import.meta.url), 'utf8'); assert.match(src, /ALWAYS_ASK[\s\S]{0,300}send_message[\s\S]{0,200}trade_or_transfer/);
});

test('the saved persona settings are backed up once a day before anything else changes them', () => {
  const db = makeDb(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
  assert.equal(backupSavedPersona(db, dir, '2026-10-25'), null, 'nothing saved yet, nothing to back up');
  setPersona(db, { ...getPersona(db), addressAs: 'boss' }); const f = backupSavedPersona(db, dir, '2026-10-25')!; assert.equal(path.basename(f), 'persona-2026-10-25.json'); assert.match(fs.readFileSync(f, 'utf8'), /boss/);
  setPersona(db, { ...getPersona(db), addressAs: 'sir' }); backupSavedPersona(db, dir, '2026-10-25'); assert.match(fs.readFileSync(f, 'utf8'), /boss/, 'the first copy of the day is kept');
});

import { afterEach } from 'node:test';
import * as gw from '../llm/gateway.ts';
import type { Completion, CompletionRequest, Provider } from '../llm/types.ts';
import { converse } from '../converse.ts';
import * as ws from '../websearch.ts';
import * as registry from '../skills/registry.ts';
import { createTask } from '../tasks.ts';
const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });

test('the self-test question: the weather part is looked up (walled off from his data), the calendar part comes from his own data, and one reply covers both', async () => {
  const db = makeDb(); ws.setConfig(db, { enabled: true, perDay: 15 }); createTask(db, { title: 'Call Reid about the dock', kind: 'manual', priority: 1 } as any);
  const calls: CompletionRequest[] = [];
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); const web = !!req.webSearch; return { text: web ? 'Sunny and 64 tomorrow, rain holding off until evening.' : 'Sunny and 64 tomorrow, sir, with rain holding off until evening. Nothing is on your calendar in the morning.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }, searches: web ? 1 : 0, sources: [] } as Completion; } } as Provider };
  const r = await converse(db, "what's the weather tomorrow and what's on my calendar in the morning?");
  const web = calls.filter((c) => c.webSearch), chat = calls.filter((c) => !c.webSearch && /You are Jarvis, the personal assistant/.test(c.system));
  assert.equal(web.length, 1); assert.doesNotMatch(web[0].system + JSON.stringify(web[0].messages), /Call Reid|CURRENT STATE|my calendar/, 'nothing private goes to the web, and the personal wording is removed from the query');
  assert.equal(chat.length, 1); assert.match(chat[0].system, /INTERNET RESULT[\s\S]*Sunny and 64/); assert.match(chat[0].system, /CURRENT STATE/); assert.match(chat[0].system, /Answer everything he asked/);
  assert.match(r.text, /Sunny and 64[\s\S]*calendar/);
  const sms = await converse(db, "what's the weather tomorrow and what's on my calendar in the morning?", { channel: 'sms' }); assert.ok(sms.text); assert.equal(calls.filter((c) => c.webSearch).length, 1, 'no web search over text messages');
  const { isMixedAsk } = ws; for (const t of ["what's on my schedule tomorrow", 'what is the weather in Rome', 'add a task to check my calendar']) assert.equal(isMixedAsk(t), false, t);
});

test('the mixed question is not swallowed by the skill router, with web search on or off; with it off, Jarvis answers the calendar part and says the weather needs web search', async () => {
  for (const on of [true, false]) {
    const db = makeDb(); ws.setConfig(db, { enabled: on, perDay: 15 }); registry.grant(db, 'jarvis', 'search.everything', 'luke'); const calls: CompletionRequest[] = [];
    gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); const router = /route a request to ONE tool/.test(req.system); return { text: router ? '{"skill":"search.everything","input":{"query":"weather tomorrow calendar morning"}}' : 'Combined answer.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }, searches: req.webSearch ? 1 : 0, sources: [] } as Completion; } } as Provider };
    const r = await converse(db, "what's the weather tomorrow and what's on my calendar in the morning?");
    assert.equal(r.text, 'Combined answer.', `web ${on ? 'on' : 'off'}`); const chat = calls.filter((c) => /You are Jarvis, the personal assistant/.test(c.system)); assert.equal(chat.length, 1);
    if (!on) assert.match(chat[0].system, /WEB SEARCH: not enabled/);
  }
});
