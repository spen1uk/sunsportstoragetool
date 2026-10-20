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
  await converse(db, 'what is a good way to build muscle'); await converse(db, 'thanks a lot, that was helpful'); assert.equal(intentCalls(calls), 0, 'plain questions and thank-yous cost nothing extra'); await converse(db, 'tell me a joke about boats'); assert.equal(intentCalls(calls), 1, 'anything else gets one cheap look; null means ordinary chat');
  await converse(db, 'write a short poem about the lake for me'); assert.equal(intentCalls(calls), 2); await converse(db, 'build me something nice for the weekend please'); assert.equal(intentCalls(calls), 3); assert.equal((db.prepare('SELECT COUNT(*) n FROM tasks').get() as any).n, 0);
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
  const calls: string[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req.system.slice(0, 40)); const isCal = req.system.includes('answer with JSON only. Operations'); return { text: isCal ? JSON.stringify({ events: [{ title: 'Put out Sun Sport Marine storage cards', start: '2027-08-01 09:00', end: null, location: '' }, { title: 'Put out Sun Sport Marine storage cards', start: '2027-09-10 09:00', end: null, location: '' }] }) : 'Plain chat answer.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } as Completion; } } as Provider };
  const ask = 'Put on the calender for August 1st 2027 to Put out sun sport marine storage cards. also make one fo september 10th';
  assert.match((await converse(db, ask)).text, /Choose which calendar/, 'no calendar chosen yet: says so, does not claim it cannot'); W.setTarget(db, 'Home');
  const r = await converse(db, ask); assert.equal(r.source, 'command'); assert.match(r.text, /^Done\. I've added 2 events to your Home calendar/); assert.match(r.text, /Aug 1/); assert.match(r.text, /Sep 10/);
  assert.equal(W.outbox(db).filter((o) => o.kind === 'create').length, 2); assert.deepEqual(W.outbox(db).map((o) => o.payload.title), ['Put out Sun Sport Marine storage cards', 'Put out Sun Sport Marine storage cards']);
});

test('every plain-words reply tells the chat window to refresh (otherwise the message looks like it was never sent)', async () => {
  const { subscribe } = await import('../events.ts') as any; void subscribe;
  const src = (await import('node:fs')).readFileSync(new URL('../converse.ts', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('INSERT INTO messages') && l.includes("'jarvis'"));
  assert.ok(src.length > 5); for (const l of src) assert.ok(l.includes("publish({ type: 'chat' })"), `missing refresh: ${l.slice(0, 90)}`);
});

test('the model calls for calendar and plain requests use a slot with room for a full JSON answer (the quick-check slot allows only 16 tokens)', async () => {
  const db = makeDb(); const seen: { max: number; ref: string }[] = []; const W = await import('../calendarwrite.ts'); const cal = await import('../calendar.ts'); cal.rememberSources(db, 'calendar', ['Home']); cal.setEnabled(db, 'calendar', ['Home']); W.setTarget(db, 'Home');
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { seen.push({ max: req.maxTokens, ref: req.system.slice(0, 30) }); return { text: req.system.includes('front desk') ? '{"action":null}' : '{"events":[{"title":"Luke Spencer\'s birthday","start":"2026-11-08 09:00","end":null,"location":""}]}', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } } as any; } } as any };
  assert.match((await converse(db, 'add to calender on november 8th its luke spencers birthday')).text, /^Done\. I've added “Luke Spencer's birthday”/); await converse(db, 'build me a page for the dock list please'); assert.ok(seen.length >= 2 && seen.every((s) => s.max >= 300), JSON.stringify(seen));
});

test('calendar follow-ups: after talking about the calendar, "place crds … on aug 1 and sep 10 2027" works without the word calendar; unrelated requests are left alone', async () => {
  const db = makeDb(); const W = await import('../calendarwrite.ts'); const cal = await import('../calendar.ts'); cal.rememberSources(db, 'calendar', ['Home']); cal.setEnabled(db, 'calendar', ['Home']); W.setTarget(db, 'Home');
  const seenUsers: string[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { seenUsers.push(req.messages.map((m: any) => m.content).join('\n')); const cal2 = req.system.includes('answer with JSON only. Operations'); return { text: cal2 ? '{"events":[{"title":"Place cards for boat storage on houses in Lake Country","start":"2027-08-01 09:00","end":null,"location":""},{"title":"Place cards for boat storage on houses in Lake Country","start":"2027-09-10 09:00","end":null,"location":""}]}' : 'Plain chat answer.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } } as any; } } as any };
  const before = await converse(db, 'place crds for boat storage on houses in lake country on aug 1 and sep 10 2027'); assert.doesNotMatch(before.text, /^Done/, 'no calendar talk yet: this is ordinary chat');
  db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', 'put on the calender for August 1st 2027 to put out cards', new Date().toISOString(), 'dashboard'); db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', 'Which two dates do you mean, and what should the cards be for?', new Date().toISOString(), 'dashboard');
  const r = await converse(db, 'place crds for boat storage on houses in lake country on aug 1 and sep 10 2027'); assert.match(r.text, /^Done\. I've added 2 events/); assert.ok(seenUsers.some((u) => u.includes('recent conversation')));
  await converse(db, 'add task call the dock supplier'); assert.equal(W.outbox(db).length, 2, 'a task request after calendar talk is not hijacked');
});

test('calendar by model: delete in any sentence shape ("on my calender delete all the … tasks for every date"), move by plain words, and questions are left alone', async () => {
  const db = makeDb(); const W = await import('../calendarwrite.ts'); const cal = await import('../calendar.ts'); const { chicagoInstant: ci } = await import('../tz.ts'); cal.rememberSources(db, 'calendar', ['Home']); cal.setEnabled(db, 'calendar', ['Home']); W.setTarget(db, 'Home');
  const now = Date.now(); const day = 86_400_000; cal.storeCalendar(db, [1, 2, 3].map((n) => ({ calendar: 'Home', uid: 'win', title: 'How to Win Friends & Influence People', start: now + n * day, end: now + n * day + 3_600_000, allDay: false, location: '' })).concat([{ calendar: 'Home', uid: 'dent', title: 'Dentist', start: now + 5 * day, end: now + 5 * day + 3_600_000, allDay: false, location: '' }]), {}, now);
  const sent: string[] = []; const { setRunner } = await import('../mac.ts'); setRunner(async (s2: string) => { sent.push(s2); return '{"ok":true}'; });
  let reply: unknown = { op: 'delete', title: 'How to Win Friends and Influence People', all: true };
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { return { text: JSON.stringify(reply), model: req.model, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } } as any; } } as any };
  try {
    const r = await converse(db, 'on my calender delete all the "how to win frends and influence people tasks" for every date'); assert.match(r.text, /^Done\. I've deleted the whole “How to Win Friends & Influence People” series, all 3 dates/); await new Promise((x) => setTimeout(x, 30)); assert.ok(sent.some((x) => x.includes('C.delete(')));
    const when = '2027-03-05 15:00'; reply = { op: 'move', title: 'dentist', start: when }; const m = await converse(db, 'please move the dentist on my calendar to march 5th at 3pm'); assert.match(m.text, /^Done\. I've moved “Dentist” to Fri, Mar 5/); await new Promise((x) => setTimeout(x, 30)); assert.ok(sent.some((x) => x.includes('startDate =')));
    reply = { op: 'none' }; const q = await converse(db, 'what is on my calendar tomorrow'); assert.doesNotMatch(q.text, /^Done/);
  } finally { setRunner(null); }
});

test('typos do not matter: "delte" still reaches the model and deletes; questions about the calendar do not call the model', async () => {
  const db = makeDb(); const W = await import('../calendarwrite.ts'); const cal = await import('../calendar.ts'); cal.rememberSources(db, 'calendar', ['Home']); cal.setEnabled(db, 'calendar', ['Home']); W.setTarget(db, 'Home');
  const now = Date.now(); cal.storeCalendar(db, [{ calendar: 'Home', uid: 'a', title: 'How to Win Friends & Influence People', start: now + 86_400_000, end: now + 90_000_000, allDay: false, location: '' }], {}, now);
  let n = 0; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { if (req.system.includes('Operations')) n++; return { text: '{"op":"delete","title":"how to win frineds and influence people","all":true}', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } } as any; } } as any };
  const { setRunner } = await import('../mac.ts'); setRunner(async () => '{"ok":true}');
  try { assert.match((await converse(db, 'on my calender delte all "how to win frineds and influence people tasks')).text, /^Done\. I've deleted “How to Win Friends & Influence People”/); const before = n; await converse(db, 'my calendar tomorrow'); await converse(db, 'what is on my calender today'); assert.equal(n, before, 'questions are not sent to the model'); } finally { setRunner(null); }
});

test('front desk sees every message: several actions in one request run in order; "cannot" is logged as something to build and "build it" writes the brief; what can you do is answered; chat never starts with I cannot', async () => {
  const db = makeDb(); const I = await import('../intent.ts'); const G = await import('../improve/gaps.ts');
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: any) { const u = req.messages[req.messages.length - 1].content; const front = req.system.includes('front desk'); const brief = req.system.includes('task briefs');
    const text = front ? (u.includes('bank balance') ? '{"actions":[{"action":"cannot","args":{"what":"Read his bank balance","why":"no bank connection exists"}}]}' : u.includes('and remember') ? '{"actions":[{"action":"task","args":{"title":"Order dock cleats"}},{"action":"remember","args":{"text":"Prefers stainless cleats"}}]}' : '{"action":null}') : brief ? '{"title":"Read bank balance","context":"","constraints":[],"acceptance":["shows balance"],"files":[]}' : 'Plain chat answer.';
    return { text, model: req.model, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } } as any; } } as any };
  const multi = await converse(db, 'put ordering dock cleats on my list and remember that I prefer stainless cleats'); assert.match(multi.text, /Added to your tasks: “Order dock cleats”[\s\S]*Noted/); assert.equal((db.prepare("SELECT COUNT(*) n FROM tasks WHERE title='Order dock cleats'").get() as any).n, 1);
  const can = await converse(db, 'pull my current bank balance from the credit union'); assert.match(can.text, /^I can't do that one yet: no bank connection exists\..*to-build list.*Say “build it”/); assert.equal(G.list(db).filter((g) => /bank balance/i.test(g.title)).length, 1);
  assert.match((await converse(db, 'build it')).text, /written a brief for Claude Code: “Read bank balance”/); assert.equal((await converse(db, 'build it')).text.includes('written a brief'), false, 'only once');
  const caps = await converse(db, 'what can you do'); assert.match(caps.text, /Calendar: add, move and delete[\s\S]*What I can't do yet/); assert.ok(I.asksCapabilities('What can you do?') && !I.asksCapabilities('what can you do about the weather in Madison'));
  assert.ok(!I.isPlainQuestion('can you open the notes app') && I.isPlainQuestion('what is the plan for my week') && I.isPlainQuestion('And next quarter?') && !I.isPlainQuestion('put dentist on my list'));
});
