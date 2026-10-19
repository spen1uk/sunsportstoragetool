import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as W from '../calendarwrite.ts';
import * as appr from '../approvals.ts';
import { setRunner, MacError } from '../mac.ts';
import { rememberSources, setEnabled, storeCalendar, diffSoon, recordSync } from '../calendar.ts';
import { chicagoInstant as ci, MIN } from '../tz.ts';
import { setPaused } from '../pause.ts';
import * as X from '../exclusions.ts';
import { fakeSession } from './helpers.ts';

afterEach(() => setRunner(null));
const NOW = ci(2026, 10, 19, 7, 0);   // Monday 7:00 am Chicago
const H = 3_600_000;
function setup() {
  const db = makeDb(); rememberSources(db, 'calendar', ['Home', 'Work']); setEnabled(db, 'calendar', ['Home', 'Work']);
  storeCalendar(db, [{ calendar: 'Work', uid: 'u1', title: 'Team call', start: ci(2026, 10, 20, 10, 0), end: ci(2026, 10, 20, 11, 0), allDay: false, location: '' }, { calendar: 'Home', uid: 'r1', title: 'Weekly chores', start: ci(2026, 10, 21, 18, 0), end: ci(2026, 10, 21, 19, 0), allDay: false, location: '' }, { calendar: 'Home', uid: 'r1', title: 'Weekly chores', start: ci(2026, 10, 28, 18, 0), end: ci(2026, 10, 28, 19, 0), allDay: false, location: '' }, { calendar: 'Home', uid: 'ad', title: 'Holiday', start: ci(2026, 10, 22, 0, 0), end: ci(2026, 10, 23, 0, 0), allDay: true, location: '' }], {}, NOW);
  return db;
}
const req = (db: any) => (type: string, payload: unknown) => appr.requestApproval(db, { actionType: type, payload, requestedBy: 'luke' });
const approveAndRun = (db: any, aid: string) => { const a = db.prepare('SELECT digest FROM approvals WHERE id=?').get(aid) as { digest: string }; const d = appr.decide(db, aid, 'approve', { digest: a.digest, channel: 'dashboard', session: fakeSession(true) }); assert.ok(d.ok, JSON.stringify(d)); return appr.execute(db, aid); };

test('protected times: stored in Chicago time, checked against any proposed event, validated', () => {
  const db = setup(); W.addProtected(db, { label: 'Gym', days: [1, 3, 5], start: '06:00', end: '07:30' });
  assert.deepEqual(W.listProtected(db).map((b) => [b.label, b.days, b.start, b.end]), [['Gym', [1, 3, 5], '06:00', '07:30']]); assert.equal(W.protectedIntervals(db, ci(2026, 10, 19, 0, 0), ci(2026, 10, 20, 0, 0)).length, 1, 'Monday only'); assert.equal(W.protectedIntervals(db, ci(2026, 10, 20, 0, 0), ci(2026, 10, 21, 0, 0)).length, 0);
  assert.throws(() => W.addProtected(db, { label: 'x', days: [1], start: '08:00', end: '07:00' })); assert.throws(() => W.addProtected(db, { label: 'Bad', days: [9], start: '06:00', end: '07:00' })); X.add(db, 'Project Nightingale'); assert.throws(() => W.addProtected(db, { label: 'Project Nightingale time', days: [1], start: '06:00', end: '07:00' }));
  const gym = ci(2026, 10, 19, 6, 30); const c = W.check(db, { title: 'Dentist', start: gym, end: gym + H }, NOW); assert.deepEqual(c.protectedHits, ['Gym']); assert.equal(c.ok, false); assert.ok(W.removeProtected(db, W.listProtected(db)[0].id));
});

test('checking an event: overlaps, travel and preparation widen the block, past and odd hours are warned about, bad input refused', () => {
  const db = setup(); const t = ci(2026, 10, 20, 11, 30);
  assert.equal(W.check(db, { title: 'Lunch', start: t, end: t + H }, NOW).ok, true);
  const widened = W.check(db, { title: 'Lunch', start: t, end: t + H, travelBeforeMin: 40, prepMin: 20 }, NOW); assert.equal(widened.conflicts[0]?.title, 'Team call', 'a 60-minute lead time now reaches the team call'); assert.equal(widened.blockStart, t - 60 * MIN); assert.match(widened.warnings.join(' '), /20 min to prepare/);
  assert.match(W.check(db, { title: 'Old', start: NOW - H, end: NOW }, NOW).warnings[0], /past/); assert.match(W.check(db, { title: 'Late', start: ci(2026, 10, 20, 23, 0), end: ci(2026, 10, 20, 23, 30) }, NOW).warnings.join(' '), /early or late/);
  assert.throws(() => W.check(db, { title: 'Bad', start: t, end: t - 1 })); assert.throws(() => W.check(db, { title: 'x', start: t, end: t + H })); assert.throws(() => W.check(db, { title: 'Fine title', start: t, end: t + H, extra: 1 }));
  assert.equal(W.check(db, { title: 'Team call move', start: ci(2026, 10, 20, 10, 15), end: ci(2026, 10, 20, 10, 45) }, NOW, 'u1').conflicts.length, 0, 'an event does not conflict with itself when it is being moved');
});

test('suggested times: inside work hours, clear of events with a buffer, protected time, travel and prep allowed for', () => {
  const db = setup(); W.addProtected(db, { label: 'Gym', days: [1], start: '08:00', end: '09:30' });
  const s = W.suggestSlots(db, { durationMin: 60, count: 6 }, NOW); assert.equal(s.length, 6); for (const x of s) { assert.ok(x.end - x.start === H); assert.equal(x.start % (30 * MIN), 0); }
  assert.ok(s.every((x) => !(x.start < ci(2026, 10, 19, 9, 30) && x.end > ci(2026, 10, 19, 8, 0))), 'never inside the gym block'); assert.ok(s[0].start >= ci(2026, 10, 19, 9, 30), 'first free slot after the gym');
  const tuesday = W.suggestSlots(db, { durationMin: 60, fromMs: ci(2026, 10, 20, 8, 0), days: 1, count: 20 }, NOW); assert.ok(tuesday.every((x) => x.end <= ci(2026, 10, 20, 10, 0) - 15 * MIN || x.start >= ci(2026, 10, 20, 11, 15)), 'the team call keeps a 15-minute buffer');
  const withTravel = W.suggestSlots(db, { durationMin: 60, travelBeforeMin: 45, fromMs: ci(2026, 10, 20, 8, 0), days: 1, count: 1 }, NOW); assert.ok(withTravel[0].start - 45 * MIN >= ci(2026, 10, 20, 8, 0), 'travel time fits inside the work window');
});

test('writing needs a chosen calendar and your approval: the request carries the exact event and heads-up notes; approving queues it; the Mac applies it with the data passed as an argument, never spliced into the script', async () => {
  const db = setup(); const ev = { title: `Dock "quote" \`$(rm -rf /)\` ' meeting`, start: ci(2026, 10, 20, 10, 30), end: ci(2026, 10, 20, 11, 30), location: 'Marina office' };
  await assert.rejects(() => W.requestCreate(db, ev, req(db), NOW), /Choose which calendar/); assert.throws(() => W.setTarget(db, 'Nope')); W.setTarget(db, 'Work');
  const r = await W.requestCreate(db, ev, req(db), NOW); assert.equal(r.check.conflicts.length, 1); const a = db.prepare('SELECT * FROM approvals WHERE id=?').get(r.approvalId) as any; assert.equal(a.risk, 'high'); assert.match(a.summary, /Add “Dock/); assert.match(a.summary, /Overlaps: Team call/); assert.equal(a.status, 'pending');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM calendar_outbox').get() as any).c, 0, 'asking changes nothing');
  assert.equal(appr.decide(db, r.approvalId, 'approve', { digest: a.digest, channel: 'dashboard', session: fakeSession(false) }).ok, false, 'needs a fresh step-up'); const ex = approveAndRun(db, r.approvalId); assert.ok(ex.ok); assert.match(ex.outcome, /queued for Calendar/);
  const seen: { script: string; args: string[] }[] = []; setRunner(async (script, args) => { seen.push({ script, args }); return '{"ok":true}'; });
  assert.equal(await W.drain(db, NOW), 1); const wr = seen.filter((x) => x.script.includes('C.Event(')); assert.equal(wr.length, 1, 'one write (a re-read of the calendar follows)'); assert.ok(!wr[0].script.includes('rm -rf') && !wr[0].script.includes('Dock'), 'the title is not in the script'); const sent = JSON.parse(wr[0].args[0]); assert.equal(sent.title, ev.title); assert.equal(sent.calendar, 'Work'); assert.equal(sent.start, ev.start);
  assert.equal(W.outbox(db)[0].status, 'done'); assert.equal(await W.drain(db, NOW), 0, 'applied once');
});

test('applying: failures are recorded and retried only when worth it; permission problems say what to do; pause holds everything; a tampered payload cannot be queued', async () => {
  const db = setup(); W.setTarget(db, 'Home'); const ev = { title: 'Boat show', start: ci(2026, 10, 24, 10, 0), end: ci(2026, 10, 24, 12, 0) };
  const mk = async () => { const r = await W.requestCreate(db, ev, req(db), NOW); approveAndRun(db, r.approvalId); };
  await mk(); setRunner(async () => { throw new MacError('permission', 'macOS has not allowed this yet.'); }); assert.equal(await W.drain(db, NOW), 0); let o = W.outbox(db)[0]; assert.equal(o.status, 'failed'); assert.match(o.error, /not allowed/);
  setRunner(async () => '{"ok":true}'); assert.ok(W.retry(db, o.id)); setPaused(db, true); assert.equal(await W.drain(db, NOW), 0, 'paused: nothing is written'); setPaused(db, false); assert.equal(await W.drain(db, NOW), 1); assert.equal(W.outbox(db)[0].status, 'done');
  await mk(); let n = 0; setRunner(async () => { n++; throw new MacError('timeout', 'slow'); }); await W.drain(db, NOW); await W.drain(db, NOW); await W.drain(db, NOW); assert.equal(n, 3); assert.equal(W.outbox(db)[0].status, 'failed', 'three tries then it stops');
  assert.throws(() => W.queue(db, 'create', { title: 'x', calendar: 'Home', start: 1, end: 2, extra: 'y' })); assert.throws(() => W.queue(db, 'move', { uid: '' }));
});

test('moving: only a single, timed event that Jarvis has seen; repeating and all-day events are refused; the move needs an approval and goes through the same outbox', async () => {
  const db = setup(); W.setTarget(db, 'Work'); const newStart = ci(2026, 10, 20, 14, 0);
  assert.throws(() => W.requestMove(db, { uid: 'r1', calendar: 'Home', newStart }, req(db), NOW), /repeating/); assert.throws(() => W.requestMove(db, { uid: 'ad', calendar: 'Home', newStart }, req(db), NOW), /All-day/); assert.throws(() => W.requestMove(db, { uid: 'zzz', calendar: 'Home', newStart }, req(db), NOW), /not in the calendar copy/);
  const m = W.requestMove(db, { uid: 'u1', calendar: 'Work', newStart }, req(db), NOW); assert.match((db.prepare('SELECT summary FROM approvals WHERE id=?').get(m.approvalId) as any).summary, /Move “Team call”/); assert.equal(m.check.conflicts.length, 0);
  approveAndRun(db, m.approvalId); const seen: string[][] = []; setRunner(async (s2, args) => { if (s2.includes('startDate = ')) seen.push(args); return '{"ok":true}'; }); await W.drain(db, NOW); const sent = JSON.parse(seen[0][0]); assert.deepEqual([sent.uid, sent.newStart, sent.newEnd - sent.newStart], ['u1', newStart, H]);
});

test('calendar change alerts: new, moved and removed events in the next 48 hours are noticed; the first sync and far-off changes stay quiet', () => {
  const was = [{ uid: 'a', title: 'Dentist', start_ms: NOW + 5 * H }, { uid: 'b', title: 'Gym', start_ms: NOW + 10 * H }, { uid: 'far', title: 'Conference', start_ms: NOW + 10 * 24 * H }];
  const now = [{ calendar: 'x', uid: 'a', title: 'Dentist', start: NOW + 6 * H, end: NOW + 7 * H, allDay: false, location: '' }, { calendar: 'x', uid: 'c', title: 'Lunch with Sam', start: NOW + 20 * H, end: NOW + 21 * H, allDay: false, location: '' }];
  const d = diffSoon(was, now, NOW); assert.equal(d.length, 3); assert.ok(d.some((x) => /^Moved: Dentist/.test(x))); assert.ok(d.some((x) => /^New: Lunch with Sam/.test(x))); assert.ok(d.some((x) => /^Removed: Gym/.test(x))); assert.ok(!d.some((x) => /Conference/.test(x)));
  const db = setup(); const before = (db.prepare("SELECT COUNT(*) c FROM notifications WHERE kind='calendar'").get() as any).c; storeCalendar(db, [{ calendar: 'Work', uid: 'u1', title: 'Team call', start: ci(2026, 10, 20, 15, 0), end: ci(2026, 10, 20, 16, 0), allDay: false, location: '' }], {}, NOW + 1000);
  const after = (db.prepare("SELECT COUNT(*) c FROM notifications WHERE kind='calendar'").get() as any).c; assert.equal(after, before + 1); assert.match((db.prepare("SELECT body FROM notifications WHERE kind='calendar'").get() as any).body, /Moved: Team call/); void recordSync;
});

test('deleting: single, timed events only; it needs an approval; chat finds the event by name, asks which when unsure, and the delete goes through the outbox', async () => {
  const db = setup(); W.setTarget(db, 'Work');
  assert.throws(() => W.requestDelete(db, { uid: 'r1', calendar: 'Home' }, req(db)), /repeating/); assert.throws(() => W.requestDelete(db, { uid: 'ad', calendar: 'Home' }, req(db)), /All-day/); assert.throws(() => W.requestDelete(db, { uid: 'zzz', calendar: 'Home' }, req(db)), /not in the calendar copy/);
  assert.equal(W.chatDelete(db, 'what is the weather', req(db), NOW), null); assert.equal(W.chatDelete(db, 'cancel my subscription', req(db), NOW), null, 'not about the calendar');
  assert.match(W.chatDelete(db, 'delete the nonexistent meeting', req(db), NOW)!, /couldn't find/); assert.equal((db.prepare("SELECT COUNT(*) c FROM approvals WHERE action_type='calendar_delete'").get() as any).c, 0, 'nothing asked yet');
  const said = W.chatDelete(db, 'Delete the team call event', req(db), NOW)!; assert.match(said, /asked for your approval to delete “Team call”/);
  const a = db.prepare("SELECT * FROM approvals WHERE action_type='calendar_delete'").get() as any; assert.equal(a.risk, 'high'); assert.match(a.summary, /Delete “Team call”/); assert.equal(W.outbox(db).length, 0, 'not queued before approval');
  approveAndRun(db, a.id); const seen: string[] = []; setRunner(async (s2) => { seen.push(s2); return '{"ok":true}'; }); assert.equal(await W.drain(db, NOW), 1); assert.ok(seen[0].includes('C.delete(')); assert.equal(W.outbox(db)[0].kind, 'delete'); assert.equal(W.outbox(db)[0].status, 'done');
  // "that event" refers to the one Jarvis just added
  W.setTarget(db, 'Home'); const ev = { title: 'Test from Jarvis', start: ci(2026, 10, 22, 15, 0), end: ci(2026, 10, 22, 16, 0) }; const r = await W.requestCreate(db, ev, req(db), NOW); approveAndRun(db, r.approvalId); await W.drain(db, NOW);
  storeCalendar(db, [{ calendar: 'Home', uid: 't1', title: 'Test from Jarvis', start: ev.start, end: ev.end, allDay: false, location: '' }], {}, NOW);
  assert.match(W.chatDelete(db, 'delete that event', req(db), NOW)!, /approval to delete “Test from Jarvis”/);
});

test('direct mode: on by default; deletes and adds Luke asks for in chat are queued at once (no approval) and applied; turning it off brings approvals back', async () => {
  const db = setup(); W.setTarget(db, 'Work'); assert.equal(W.directOn(db), true); const seen: string[] = []; setRunner(async (s2) => { seen.push(s2); return '{"ok":true}'; });
  const say = W.chatDelete(db, 'delete the team call meeting', W.applyNow(db), NOW, true)!; assert.match(say, /^Done\. I've deleted “Team call”/); assert.equal((db.prepare('SELECT COUNT(*) c FROM approvals').get() as any).c, 0, 'no approval raised'); await new Promise((r) => setTimeout(r, 20)); assert.ok(seen.some((x) => x.includes('C.delete(')), 'applied on the Mac'); assert.equal(W.outbox(db)[0].status, 'done');
  W.setDirect(db, false); assert.equal(W.directOn(db), false); assert.match(W.chatDelete(db, 'delete the holiday event', req(db), NOW, false)!, /couldn't find/);
  setPaused(db, true); W.setDirect(db, true); setRunner(async () => '{"ok":true}'); const w2 = setup(); void w2; W.chatDelete(db, 'delete the team call meeting', W.applyNow(db), NOW, true); await new Promise((r) => setTimeout(r, 20)); assert.equal(W.outbox(db).filter((o) => o.status === 'queued').length, 1, 'while paused nothing is applied'); setPaused(db, false);
});
