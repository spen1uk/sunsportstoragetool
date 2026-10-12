import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { chicagoInstant as ci } from '../tz.ts';
import { setRunner, classify, MacError } from '../mac.ts';
import { detectCalendars, syncCalendar, setEnabled, syncState, busyIntervals, upcoming, parseScan, occurrences } from '../calendar.ts';
import { detectFolders, syncNotes, listNotes, getNote, parseNotes } from '../notes.ts';
import { buildBriefing, proposedPlan } from '../today.ts';
import { buildContext } from '../context.ts';
import { handleChat } from '../chat.ts';

const NOW = ci(2026, 10, 12, 8, 0);   // Monday 8:00 Chicago
const H = 3_600_000;
const ev = (calendar: string, uid: string, title: string, start: number, end: number, allDay = false, location = '') => ({ calendar, uid, title, start, end, allDay, location });
const fakeMac = (handlers: { calendars?: string[]; events?: any[]; folders?: string[]; notes?: any[]; fail?: MacError }) => {
  const calls: string[][] = [];
  setRunner(async (script, args) => {
    calls.push(args); if (handlers.fail) throw handlers.fail;
    if (script.includes('C.calendars().map')) return JSON.stringify(handlers.calendars ?? []);
    if (script.includes("Application('Calendar'), out")) { const want = JSON.parse(args[2]); const evs = (handlers.events ?? []).filter((e) => want.includes(e.calendar)); return JSON.stringify({ events: evs, stats: Object.fromEntries(want.map((w: string) => [w, { total: evs.filter((e) => e.calendar === w).length, inWindow: evs.length, repeating: 0 }])) }); }
    if (script.includes('N.folders().map')) return JSON.stringify(handlers.folders ?? []);
    const want = JSON.parse(args[0]); return JSON.stringify((handlers.notes ?? []).filter((n) => want.includes(n.folder)));
  });
  return calls;
};
test.afterEach(() => setRunner(null));

test('calendar: nothing is read until Luke chooses calendars; only chosen ones are requested and stored', async () => {
  const db = makeDb(); const calls = fakeMac({ calendars: ['Home', 'Work', 'Birthdays'], events: [ev('Home', 'a', 'Dentist', NOW + 2 * H, NOW + 3 * H), ev('Work', 'b', 'Standup', NOW + H, NOW + 1.5 * H)] });
  assert.deepEqual(await detectCalendars(db), ['Home', 'Work', 'Birthdays']);
  assert.equal(syncState(db, 'calendar', NOW).status, 'planned');
  const none = await syncCalendar(db, NOW); assert.equal(none.ok, false); assert.equal(calls.filter((c) => c.length === 3).length, 0);   // no event read attempted
  setEnabled(db, 'calendar', ['Home']);
  const r = await syncCalendar(db, NOW); assert.equal(r.ok, true); assert.equal(r.count, 1);
  assert.deepEqual(JSON.parse(calls.at(-1)![2]), ['Home']);
  assert.deepEqual(upcoming(db, NOW, NOW + 24 * H).map((e) => e.title), ['Dentist']);
  assert.equal(syncState(db, 'calendar', NOW + 60_000).status, 'connected');
  assert.equal((db.prepare("SELECT status FROM connections WHERE id='apple-calendar'").get() as any).status, 'connected');
  assert.match((db.prepare("SELECT scopes FROM connections WHERE id='apple-calendar'").get() as any).scopes, /read-only: Home/);
});

test('calendar: un-choosing a calendar deletes its cached events immediately', async () => {
  const db = makeDb(); fakeMac({ calendars: ['Home', 'Work'], events: [ev('Home', 'a', 'Dentist', NOW + H, NOW + 2 * H), ev('Work', 'b', 'Standup', NOW + 3 * H, NOW + 4 * H)] });
  await detectCalendars(db); setEnabled(db, 'calendar', ['Home', 'Work']); await syncCalendar(db, NOW);
  assert.equal(upcoming(db, NOW, NOW + 24 * H).length, 2);
  setEnabled(db, 'calendar', ['Home']); assert.deepEqual(upcoming(db, NOW, NOW + 24 * H).map((e) => e.title), ['Dentist']);
  setEnabled(db, 'calendar', []); assert.equal(upcoming(db, NOW, NOW + 24 * H).length, 0);
  assert.equal((db.prepare("SELECT status FROM connections WHERE id='apple-calendar'").get() as any).status, 'planned');
});

test('calendar: a failed sync keeps the old copy but labels it STALE and records the reason; permission errors are explained', async () => {
  const db = makeDb(); fakeMac({ calendars: ['Home'], events: [ev('Home', 'a', 'Dentist', NOW + H, NOW + 2 * H)] });
  await detectCalendars(db); setEnabled(db, 'calendar', ['Home']); await syncCalendar(db, NOW);
  setRunner(async () => { throw classify('execution error: Not authorized to send Apple events to Calendar. (-1743)', false); });
  const r = await syncCalendar(db, NOW + 20 * 60_000); assert.equal(r.ok, false); assert.match(r.error!, /Automation/);
  assert.equal(syncState(db, 'calendar', NOW + 20 * 60_000).status, 'stale'); assert.equal(upcoming(db, NOW, NOW + 24 * H).length, 1);
  assert.equal((db.prepare("SELECT status FROM connections WHERE id='apple-calendar'").get() as any).status, 'stale');
  fakeMac({ calendars: ['Home'], events: [ev('Home', 'a', 'Dentist', NOW + H, NOW + 2 * H)] });
  assert.equal((await syncCalendar(db, NOW + 25 * 60_000)).ok, true); assert.equal(syncState(db, 'calendar', NOW + 26 * 60_000).status, 'connected');
  assert.equal(syncState(db, 'calendar', NOW + 26 * 60_000 + 50 * 60_000).status, 'stale');   // old copy goes stale on its own
});

test('calendar: never connected + failing is "disconnected", not connected', async () => {
  const db = makeDb(); fakeMac({ calendars: ['Home'] }); await detectCalendars(db); setEnabled(db, 'calendar', ['Home']);
  fakeMac({ fail: new MacError('unavailable', 'not a Mac') });
  assert.equal((await syncCalendar(db, NOW)).ok, false); assert.equal(syncState(db, 'calendar', NOW).status, 'disconnected');
});

test('malformed or hostile rows are skipped or cleaned instead of breaking the sync', () => {
  const rows = parseScan(JSON.stringify({ events: [ev('Home', 'a', 'Fine\u0000\n title', 1, 2), { nope: 1 }, ev('Home', 'b', '', 5, 3)], stats: {} })).events;
  assert.equal(rows.length, 2); assert.equal(rows[0].title, 'Fine title'); assert.equal(rows[1].title, '(no title)'); assert.ok(rows[1].end >= rows[1].start);
  assert.throws(() => parseScan('not json'));
});

test('planner: appointments block work slots (with buffers); all-day events do not', async () => {
  const db = makeDb(); fakeMac({ calendars: ['Home'], events: [ev('Home', 'm', 'Meeting', NOW + 2 * H, NOW + 4 * H), ev('Home', 'h', 'Holiday', NOW - 8 * H, NOW + 16 * H, true)] });
  await detectCalendars(db); setEnabled(db, 'calendar', ['Home']); await syncCalendar(db, NOW);
  assert.equal(busyIntervals(db, NOW, NOW + 24 * H).length, 1);
  db.prepare("INSERT INTO tasks(id,title,kind,owner,state,priority,minutes,created_at,updated_at) VALUES('t1','Write plan','manual','luke','queued',1,180,?,?)").run(new Date().toISOString(), new Date().toISOString());
  const { plan } = proposedPlan(db, NOW, false);
  const p = plan.placements[0]; assert.ok(p); assert.ok(p.end <= NOW + 2 * H - 15 * 60_000 || p.start >= NOW + 4 * H + 15 * 60_000, 'work slot must avoid the meeting and its buffer');
});

test('briefing and chat context mention appointments, say when the copy is stale, and never claim a calendar that is not connected', async () => {
  const db = makeDb();
  assert.match(buildBriefing(db, NOW).schedule.caveat, /No calendar is connected/);
  fakeMac({ calendars: ['Home'], events: [ev('Home', 'a', 'Dentist', NOW + 2 * H, NOW + 3 * H)] });
  await detectCalendars(db); setEnabled(db, 'calendar', ['Home']); await syncCalendar(db, NOW);
  const b = buildBriefing(db, NOW + 60_000); assert.equal(b.schedule.appointments[0].title, 'Dentist'); assert.match(b.narration, /Appointment .*Dentist/); assert.doesNotMatch(b.schedule.caveat, /No calendar is connected/);
  assert.match(buildContext(db, NOW + 60_000), /APPOINTMENTS from Luke's Apple Calendar[\s\S]*Dentist/);
  assert.match(buildBriefing(db, NOW + 3 * H).schedule.caveat, /STALE/);
});

test('chat: calendar questions are answered locally; not-connected is said plainly', async () => {
  const db = makeDb(); const t = Date.now();
  assert.match(handleChat(db, "what's on my calendar today").text, /not connected/i);
  fakeMac({ calendars: ['Home'], events: [ev('Home', 'a', 'Dentist', t + 1 * H, t + 2 * H)] });
  await detectCalendars(db); setEnabled(db, 'calendar', ['Home']); await syncCalendar(db, t);
  assert.match(handleChat(db, "what's next").text, /Dentist/);
  assert.equal(handleChat(db, 'open my calendar').action?.navigate, '#/calendar'); assert.equal(handleChat(db, 'show notes').action?.navigate, '#/notes');
});

test('notes: only chosen folders are read; search works; note text never enters chat history or the model snapshot', async () => {
  const db = makeDb(); const secret = 'wifi password hunter2';
  fakeMac({ folders: ['Ideas', 'Private'], notes: [{ id: 'n1', folder: 'Ideas', title: 'Boat ideas', body: 'Build a dock light', modified: NOW }, { id: 'n2', folder: 'Private', title: 'Passwords', body: secret, modified: NOW }] });
  assert.deepEqual(await detectFolders(db), ['Ideas', 'Private']); assert.equal((await syncNotes(db, NOW)).ok, false);
  setEnabled(db, 'notes', ['Ideas']); assert.equal((await syncNotes(db, NOW)).count, 1);
  assert.deepEqual(listNotes(db, 'dock').map((n) => n.title), ['Boat ideas']); assert.equal(listNotes(db, 'hunter2').length, 0); assert.equal(getNote(db, 'n2'), null);
  assert.equal(listNotes(db, '%').length, 0, 'LIKE wildcards in the query are escaped');
  const r = handleChat(db, 'search notes for dock'); assert.match(r.text, /Boat ideas/); assert.doesNotMatch(r.text, /Build a dock light/); assert.equal(r.persisted, false);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM messages WHERE content LIKE '%Boat ideas%'").get() as any).c, 0);
  assert.doesNotMatch(buildContext(db, NOW), /Boat ideas|dock light/);
  setEnabled(db, 'notes', []); assert.equal(listNotes(db).length, 0);
  assert.equal(parseNotes(JSON.stringify([{ id: 'x', folder: 'F', title: '', body: 'a\u0000b', modified: 1 }, { bad: true }])).length, 1);
});

test('classify: timeouts and permission denials get distinct, actionable messages', () => {
  assert.equal(classify('', true).kind, 'timeout'); assert.equal(classify('... (-1743)', false).kind, 'permission'); assert.equal(classify('boom', false).kind, 'failed');
});

test('calendar: a successful sync records what was scanned, so an empty result can be diagnosed', async () => {
  const db = makeDb(); fakeMac({ calendars: ['Home'], events: [ev('Home', 'a', 'Dentist', NOW + H, NOW + 2 * H)] });
  await detectCalendars(db); setEnabled(db, 'calendar', ['Home']); await syncCalendar(db, NOW);
  const st = syncState(db, 'calendar', NOW + 1000); assert.equal(st.detail.scanned, 1); assert.equal(st.detail.calendars.Home.total, 1);
});

test('repeating events are expanded from their rule (weekly, interval, monthly ordinal, count, until, excluded dates)', () => {
  const local = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
  const run = (rule: string, start: number, exclude: number[] = [], from = local(2026, 10, 12), to = local(2026, 10, 26, 23, 59)) =>
    occurrences({ events: [{ calendar: 'C', uid: 'u', title: 'Gym', start, end: start + H, allDay: false, location: '', rule, exclude }], stats: {} }, from, to);
  const days = (r: ReturnType<typeof run>) => r.events.map((e) => new Date(e.start).getDate() + '@' + new Date(e.start).getHours());
  // weekly Mon/Wed at 6am, started months ago → Oct 12 (Mon) .. Oct 26
  assert.deepEqual(days(run('FREQ=WEEKLY;BYDAY=MO,WE', local(2026, 3, 2, 6))), ['12@6', '14@6', '19@6', '21@6', '26@6']);
  // every 2 weeks on Tuesday, anchored Sep 29 → Oct 13, Oct 27 (outside) 
  assert.deepEqual(days(run('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU', local(2026, 9, 29, 9))), ['13@9']);
  // daily with COUNT: 5 occurrences from Oct 10 → 10,11,12,13,14; window starts Oct 12
  assert.deepEqual(days(run('FREQ=DAILY;COUNT=5', local(2026, 10, 10, 7))), ['12@7', '13@7', '14@7']);
  // until stops the series
  assert.deepEqual(days(run('FREQ=DAILY;UNTIL=20261014T235959Z', local(2026, 10, 10, 7))).length >= 3, true);
  assert.deepEqual(days(run('FREQ=DAILY;UNTIL=20261013', local(2026, 10, 10, 7))), ['12@7', '13@7']);
  // monthly: first Monday and last Friday
  assert.deepEqual(days(run('FREQ=MONTHLY;BYDAY=1MO', local(2026, 1, 5, 8), [], local(2026, 11, 1), local(2026, 11, 30, 23))), ['2@8']);
  assert.deepEqual(days(run('FREQ=MONTHLY;BYDAY=-1FR', local(2026, 1, 30, 8), [], local(2026, 10, 1), local(2026, 10, 31, 23))), ['30@8']);
  assert.deepEqual(days(run('FREQ=MONTHLY;BYMONTHDAY=15', local(2026, 1, 15, 12), [], local(2026, 10, 1), local(2026, 10, 31, 23))), ['15@12']);
  // yearly
  assert.deepEqual(days(run('FREQ=YEARLY', local(2020, 10, 20, 0))), ['20@0']);
  // an excluded date is skipped; wall-clock hour is kept across a daylight-saving change (Nov 1 2026)
  assert.deepEqual(days(run('FREQ=WEEKLY;BYDAY=MO', local(2026, 3, 2, 6), [local(2026, 10, 19, 6)])), ['12@6', '26@6']);
  assert.deepEqual(days(run('FREQ=WEEKLY;BYDAY=SU', local(2026, 3, 1, 6), [], local(2026, 10, 25), local(2026, 11, 9, 23))), ['25@6', '1@6', '8@6']);
  // unknown rule: reported, not guessed
  const bad = run('FREQ=HOURLY', local(2026, 10, 13, 6)); assert.equal(bad.unsupported, 1);
  // end of an ongoing event still counts
  assert.equal(run('FREQ=DAILY', local(2026, 10, 1, 23), [], local(2026, 10, 12, 23, 30), local(2026, 10, 12, 23, 59)).events.length >= 1, true);
});
