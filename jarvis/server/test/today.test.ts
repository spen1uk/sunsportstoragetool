import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { chicagoInstant as ci } from '../tz.ts';
import { tickNotifications, ack, snooze } from '../notify.ts';
import { setMode, getMode } from '../modes.ts';
import { clients } from '../events.ts';
import { createTask, completeTask, cancelTask } from '../tasks.ts';
import { requestApproval } from '../approvals.ts';
import { setPaused } from '../pause.ts';
import { buildBriefing, overnightPlan } from '../today.ts';

const MON = (h: number, m = 0, s = 0) => ci(2026, 10, 12, h, m) + s * 1000;
const M = 60_000;
const byKey = (db: any, k: string) => db.prepare('SELECT * FROM notifications WHERE key LIKE ?').get(`%${k}`) as any;

test('8:00 briefing is created once, delivered to the desktop at the computer; text is recorded as NOT SENT (no SMS adapter)', () => {
  const db = makeDb(); clients.n = 1;
  assert.equal(tickNotifications(db, MON(7, 59)).delivered.length, 0);
  const r = tickNotifications(db, MON(8, 0, 20)); assert.equal(r.delivered.length, 1);
  assert.equal(tickNotifications(db, MON(8, 1)).delivered.length, 0);          // not repeated
  const n = byKey(db, ':briefing'); assert.equal(n.desktop_at, MON(8, 0, 20)); assert.match(n.text_note, /NOT SENT/);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM notifications WHERE key LIKE '%:briefing'").get() as any).c, 1);
  clients.n = 0;
});

test('church/unavailable holds the briefing; "I\'m back" releases it', () => {
  const db = makeDb(); clients.n = 1;
  setMode(db, 'church', null);
  assert.equal(tickNotifications(db, MON(8, 5)).delivered.length, 0);
  setMode(db, 'normal', null);
  assert.equal(tickNotifications(db, MON(8, 40)).delivered.length, 1);
  clients.n = 0;
});

test('timed mode expires by itself', () => {
  const db = makeDb(); const t = Date.now();
  setMode(db, 'church', t + 60 * M);
  assert.equal(getMode(db, t + 30 * M).mode, 'church');
  assert.equal(getMode(db, t + 61 * M).mode, 'normal');
});

test('missed scheduled items are recorded as missed, not silently backfilled', () => {
  const db = makeDb(); clients.n = 1;
  createTask(db, { title: 'a' });
  tickNotifications(db, MON(17, 0));
  assert.match(byKey(db, ':briefing').note, /missed/); assert.equal(byKey(db, ':briefing').state, 'skipped');
  assert.equal(byKey(db, ':afternoon').state, 'pending');                        // 16:00 is within 3h → still delivered
  clients.n = 0;
});

test('reminders list unfinished tasks by importance; completing them cancels the reminder', () => {
  const db = makeDb(); clients.n = 1;
  const a = createTask(db, { title: 'Pay dock fee', priority: 1 }); createTask(db, { title: 'Tidy notes', priority: 4 });
  tickNotifications(db, MON(12, 0, 5)); const n = byKey(db, ':noon');
  assert.match(n.title, /2 unfinished/); assert.match(n.body, /Important: Pay dock fee/); assert.match(n.body, /1 other/);
  completeTask(db, a, 'luke', 'x');
  cancelTask(db, (db.prepare("SELECT id FROM tasks WHERE title='Tidy notes'").get() as any).id);
  tickNotifications(db, MON(16, 0, 5)); assert.equal(byKey(db, ':afternoon').state, 'skipped'); assert.match(byKey(db, ':afternoon').note, /nothing/);
  clients.n = 0;
});

test('approval attention: desktop now, text recorded after 5 min, acknowledgment cancels', () => {
  const db = makeDb(); clients.n = 1;
  const aid = requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 2e8 }, requestedBy: 'luke' });
  const t0 = MON(10, 0);
  tickNotifications(db, t0); assert.equal(byKey(db, aid).desktop_at, t0);
  tickNotifications(db, t0 + 2 * M); assert.equal(byKey(db, aid).text_at, null);
  tickNotifications(db, t0 + 5 * M + 1); assert.ok(byKey(db, aid).text_at); assert.match(byKey(db, aid).text_note, /NOT SENT/);
  // second approval acknowledged before 5 minutes → never texted
  const b = requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 3e8 }, requestedBy: 'luke' });
  const t1 = MON(11, 0); tickNotifications(db, t1); ack(db, byKey(db, b).id, t1 + M);
  tickNotifications(db, t1 + 6 * M); assert.equal(byKey(db, b).text_at, null); assert.equal(byKey(db, b).state, 'acked');
  clients.n = 0;
});

test('gym/wake window: no desktop pop-ups before 8:00 away from computer routes to text only', () => {
  const db = makeDb(); clients.n = 0;
  requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 2e8 }, requestedBy: 'luke' });
  tickNotifications(db, MON(7, 0));
  const q = () => db.prepare("SELECT * FROM notifications WHERE kind='approval'").get() as any;
  assert.equal(q().desktop_at, null); assert.equal(q().text_at, null);   // attention waits 5 minutes before texting
  tickNotifications(db, MON(7, 6)); assert.equal(q().desktop_at, null); assert.ok(q().text_at); // text only, recorded as not sent
});

test('sleep hours hold routine notifications; pause stops dispatch; snooze defers', () => {
  const db = makeDb(); clients.n = 1;
  requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 2e8 }, requestedBy: 'luke' });
  const n = () => db.prepare("SELECT * FROM notifications WHERE kind='approval'").get() as any;
  tickNotifications(db, MON(2, 0)); assert.equal(n().desktop_at, null);
  setPaused(db, true); tickNotifications(db, MON(10, 0)); assert.equal(n().desktop_at, null); setPaused(db, false);
  snooze(db, n().id, 30, MON(10, 0)); tickNotifications(db, MON(10, 10)); assert.equal(n().desktop_at, null);
  tickNotifications(db, MON(10, 31)); assert.equal(n().desktop_at, MON(10, 31));
  clients.n = 0;
});

test('briefing: urgent first, planned managers listed as unavailable (never invented), narration under the cap, Monday = week ahead', () => {
  const db = makeDb();
  createTask(db, { title: 'Renew insurance', priority: 1, minutes: 45, deadline: MON(9) });
  requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 2e8 }, requestedBy: 'luke' });
  for (let i = 0; i < 80; i++) createTask(db, { title: `Filler task number ${i} with a reasonably long descriptive title`, priority: 3, minutes: 30 });
  db.prepare("UPDATE tasks SET state='failed', last_error='a long error message describing exactly what went wrong during the attempt and what was tried' WHERE title LIKE 'Filler task number 1%'").run();
  const b = buildBriefing(db, MON(7, 30));
  assert.equal(b.isMonday, true);
  assert.match(b.sections[0].items[0].text, /Decision needed/);
  assert.match(b.unavailable.join(' '), /Sun Sport Marine/);
  assert.ok(b.narrationWords <= 390 && b.estimatedSeconds <= 180); assert.ok(b.overflow > 0);
  assert.ok(b.schedule.overcapacity); assert.ok(b.sections[2].items.some((i) => /Over capacity/.test(i.text)));
  assert.match(b.schedule.caveat, /No calendar is connected/);
  const days = new Set(b.schedule.blocks.map((x) => x.day)); assert.ok(days.size > 1, 'Monday briefing spans the week');
});

test('overnight plan: "do this tonight" outranks routine priority and shows holds/estimates', () => {
  const db = makeDb();
  const a = createTask(db, { title: 'routine', kind: 'research', priority: 2, input: { question: 'q q q', urls: ['https://a.example/'] } });
  const b = createTask(db, { title: 'tonight', kind: 'research', priority: 5, input: { question: 'q q q', urls: ['https://a.example/'] } });
  db.prepare("UPDATE tasks SET tonight=1, priority=1 WHERE id=?").run(b);
  db.prepare("UPDATE tasks SET state='waiting_approval' WHERE id=?").run(a);
  const p = overnightPlan(db);
  assert.equal(p[0].id, b); assert.equal(p[0].tonight, true); assert.match(p[1].hold!, /approval/); assert.ok(p[0].estimateMicroUsd > 0);
});

test('briefing on a Saturday evening plans the next work day (Monday), not an empty "today"', () => {
  const db = makeDb();
  createTask(db, { title: 'Renew insurance', priority: 1, minutes: 45 }); createTask(db, { title: 'Call marina', priority: 2, minutes: 30 });
  const sat = ci(2026, 10, 10, 21, 24);
  const b = buildBriefing(db, sat);
  assert.equal(b.schedule.overcapacity, false); assert.equal(b.schedule.blocks.length, 2);
  assert.ok(b.schedule.blocks.every((x) => /Mon/.test(x.day)), JSON.stringify(b.schedule.blocks.map((x) => x.day)));
  assert.equal(b.schedule.blocks[0].when.startsWith('8:00'), true);
});
