import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, Provider } from '../llm/types.ts';
import { converse } from '../converse.ts';
import * as X from '../exclusions.ts';
import { looksLikeRequest } from '../intent.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
const model = (pick: (u: string) => unknown) => { const calls: { system: string; user: string }[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { const u = req.messages[0].content; calls.push({ system: req.system, user: u }); const intent = req.system.includes('front desk'); return { text: intent ? JSON.stringify(pick(u)) : req.system.includes('task briefs') ? '{"title":"Dock page","context":"","constraints":[],"acceptance":["it loads"],"files":[]}' : 'Plain chat answer.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } as Completion; } } as Provider }; return calls; };
const intentCalls = (c: { system: string }[]) => c.filter((x) => x.system.includes('front desk')).length;

test('intent: a plain request becomes one action from the fixed menu and is done; the reply says exactly what happened', async () => {
  const db = makeDb(); let calls = model(() => ({ action: 'task', args: { title: 'Call the dock supplier' } }));
  const r = await converse(db, 'please put calling the dock supplier on my to-do list'); assert.equal(r.source, 'command'); assert.match(r.text, /Added to your tasks: “Call the dock supplier”/); assert.equal((db.prepare("SELECT COUNT(*) n FROM tasks WHERE title='Call the dock supplier'").get() as any).n, 1);
  calls = model(() => ({ action: 'goal', args: { title: 'Run a half marathon', why: 'health', targetDate: '2027-04-18' } })); assert.match((await converse(db, 'I want you to start a goal for running a half marathon by April 18th 2027')).text, /started a goal: “Run a half marathon”, aiming for 2027-04-18/); assert.equal((db.prepare("SELECT COUNT(*) n FROM goals").get() as any).n, 1);
  calls = model(() => ({ action: 'build', args: { request: 'A simple page that lists dock inspections with a date and a status', repo: '' } })); assert.match((await converse(db, 'can you build me a page that lists dock inspections with dates and status')).text, /written a brief for Claude Code.*Integrations page/); assert.equal((db.prepare("SELECT COUNT(*) n FROM briefs").get() as any).n, 1);
  calls = model(() => ({ action: 'remember', args: { text: 'Prefers morning meetings' } })); assert.match((await converse(db, 'remember that I prefer morning meetings please')).text, /Noted/); void calls;
});

test('intent: questions and chit-chat pay nothing; a null pick, a bad form, a missing detail and a secret all do nothing harmful; private mode, SMS and excluded names never reach it', async () => {
  const db = makeDb(); let calls = model(() => ({ action: null }));
  await converse(db, 'what is a good way to build muscle'); await converse(db, 'tell me a joke about boats'); assert.equal(intentCalls(calls), 0, 'not phrased as a request');
  await converse(db, 'write a short poem about the lake for me'); assert.equal(intentCalls(calls), 0); await converse(db, 'build me something nice for the weekend please'); assert.equal(intentCalls(calls), 1); assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, 0);
  calls = model(() => ({ action: 'task', args: { title: 1 } })); await converse(db, 'add a reminder to stretch every morning'); assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, 0, 'bad form: nothing created');
  calls = model(() => ({ action: 'made_up', args: {} })); await converse(db, 'build me a thing that does stuff'); assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, 0);
  calls = model(() => ({ action: null, ask: 'Which repository should I build it in?' })); assert.equal((await converse(db, 'build the new quote page for me')).text, 'Which repository should I build it in?');
  calls = model(() => ({ action: 'remember', args: { text: 'my key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' } })); assert.match((await converse(db, 'remember my api key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789')).text, /secret|Remember|Noted|can't|cannot/i); assert.equal((db.prepare("SELECT COUNT(*) n FROM memories WHERE content LIKE '%sk-ant%'").get() as any).n, 0);
  calls = model(() => ({ action: 'task', args: { title: 'x task here' } })); await converse(db, 'add a task to call sam please', { private: true }); await converse(db, 'build me a boat tracker thing', { channel: 'sms' }); X.add(db, 'Project Nightingale'); await converse(db, 'build me a tracker for Project Nightingale'); assert.equal(intentCalls(calls), 0);
  assert.ok(looksLikeRequest('Could you build a quote page for the marina') && !looksLikeRequest('how do I build a deck') && !looksLikeRequest('build'));
});

test('calendar by plain words: misspelling ("calender") still works, several events in one message are all added, a missing title reuses the first, and no calendar chosen is explained', async () => {
  const db = makeDb(); const W = await import('../calendarwrite.ts'); const cal = await import('../calendar.ts');
  cal.rememberSources(db, 'calendar', ['Home']); cal.setEnabled(db, 'calendar', ['Home']);
  const calls: string[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req.system.slice(0, 40)); const isCal = req.system.includes('put one or more events'); return { text: isCal ? JSON.stringify({ events: [{ title: 'Put out Sun Sport Marine storage cards', start: '2027-08-01 09:00', end: null, location: '' }, { title: 'Put out Sun Sport Marine storage cards', start: '2027-09-10 09:00', end: null, location: '' }] }) : 'Plain chat answer.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } as Completion; } } as Provider };
  const ask = 'Put on the calender for August 1st 2027 to Put out sun sport marine storage cards. also make one fo september 10th';
  assert.match((await converse(db, ask)).text, /Choose which calendar/, 'no calendar chosen yet: says so, does not claim it cannot'); W.setTarget(db, 'Home');
  const r = await converse(db, ask); assert.equal(r.source, 'command'); assert.match(r.text, /^Done\. I've added 2 events to your Home calendar/); assert.match(r.text, /Aug 1/); assert.match(r.text, /Sep 10/);
  assert.equal(W.outbox(db).filter((o) => o.kind === 'create').length, 2); assert.deepEqual(W.outbox(db).map((o) => o.payload.title), ['Put out Sun Sport Marine storage cards', 'Put out Sun Sport Marine storage cards']);
});
