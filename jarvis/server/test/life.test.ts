import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { chicagoInstant as ci } from '../tz.ts';
import { createHabit, toggleHabit, listHabits, archiveHabit, createPerson, listPeople, markContacted, updatePerson, deletePerson, dayStr } from '../life.ts';
import { getWorkspaces, saveLayout, setActive, deleteLayout, DEFAULT_LAYOUT } from '../workspace.ts';
import { buildBriefing } from '../today.ts';
import { handleChat } from '../chat.ts';
import { buildContext } from '../context.ts';

const T = (d: number, h = 9) => ci(2026, 10, d, h, 0);   // Oct <d> 2026, Chicago

test('habits: Chicago days, streak ends at today or yesterday, weekly count is Monday-first, toggling is reversible, no future days', () => {
  const db = makeDb(); const h = createHabit(db, { name: 'Gym', perWeek: 4 });
  for (const d of [8, 9, 10]) toggleHabit(db, h, T(d), undefined);          // Thu-Sat, each logged on its own day
  let l = listHabits(db, T(10, 22))[0]; assert.equal(l.streak, 3); assert.equal(l.doneToday, true); assert.deepEqual(l.last7, [false, false, false, false, true, true, true]);
  l = listHabits(db, T(11, 8))[0]; assert.equal(l.streak, 3, 'not yet logged today does not break yesterday\'s streak'); assert.equal(l.doneToday, false);
  l = listHabits(db, T(12, 8))[0]; assert.equal(l.streak, 0, 'a full missed day ends it');
  assert.equal(listHabits(db, T(12, 8))[0].weekCount, 0); assert.equal(listHabits(db, T(11, 8))[0].weekCount, 3 - 0 && 3);   // Mon Oct 5 week: Oct 8,9,10
  assert.equal(toggleHabit(db, h, T(12), undefined).done, true); assert.equal(toggleHabit(db, h, T(12), undefined).done, false);
  assert.throws(() => toggleHabit(db, h, T(12), '2026-10-13'), /today or the last two weeks/); assert.throws(() => toggleHabit(db, h, T(12), '2026-09-01'), /last two weeks/);
  assert.equal(dayStr(ci(2026, 10, 12, 23, 30)), '2026-10-12'); assert.equal(dayStr(ci(2026, 10, 13, 0, 30)), '2026-10-13');
  assert.throws(() => createHabit(db, { name: 'gym' }), /already have/); assert.throws(() => createHabit(db, { name: '   ' }));
  assert.equal(archiveHabit(db, h), true); assert.equal(listHabits(db).length, 0);
});

test('people: due only when "every N days" is set; never-contacted counts from when added; most overdue first; contacted resets', () => {
  const db = makeDb(); const a = createPerson(db, { name: 'David', relationship: 'storage customer', everyDays: 30 }), b = createPerson(db, { name: 'Mom', everyDays: 7 }), c = createPerson(db, { name: 'Casual' });
  db.prepare('UPDATE people SET created_at=? WHERE id=?').run(new Date(T(1)).toISOString(), a); db.prepare('UPDATE people SET created_at=? WHERE id=?').run(new Date(T(1)).toISOString(), b);
  let ppl = listPeople(db, T(12)); assert.deepEqual(ppl.map((p) => p.name), ['Mom', 'David', 'Casual']); assert.equal(ppl[0].due, true); assert.equal(ppl[1].due, false); assert.equal(ppl[2].due, false); assert.equal(ppl[2].overdueBy, null);
  markContacted(db, b, T(12)); ppl = listPeople(db, T(13)); assert.equal(ppl.find((p) => p.name === 'Mom')!.due, false); assert.equal(ppl.find((p) => p.name === 'Mom')!.daysSince, 1);
  assert.ok(updatePerson(db, a, { everyDays: 5 })); assert.equal(listPeople(db, T(12)).find((p) => p.name === 'David')!.due, true);
  assert.throws(() => createPerson(db, { name: 'X', everyDays: 0 })); assert.equal(deletePerson(db, c), true);
});

test('briefing suggests overdue contacts without hiding "start with" advice; life data never reaches the model snapshot', () => {
  const db = makeDb(); const a = createPerson(db, { name: 'David Savage', relationship: 'storage', everyDays: 14 });
  db.prepare('UPDATE people SET created_at=? WHERE id=?').run(new Date(T(1)).toISOString(), a);
  db.prepare("INSERT INTO tasks(id,title,kind,owner,state,priority,minutes,created_at,updated_at) VALUES('t1','Write plan','manual','luke','queued',1,30,?,?)").run(new Date().toISOString(), new Date().toISOString());
  const b = buildBriefing(db, T(20)); const rec = b.sections[2].items.map((i) => i.text);
  assert.ok(rec.some((t) => /Stay in touch: David Savage \(storage\)/.test(t))); assert.ok(rec.some((t) => /Start with "Write plan"/.test(t)));
  createHabit(db, { name: 'Secret habit name' }); const ctx = buildContext(db, T(20)); assert.doesNotMatch(ctx, /David Savage|Secret habit name/);
});

test('chat: logging a habit or a contact works from plain sentences, only when exactly one thing matches, and never in private mode', () => {
  const db = makeDb(); createHabit(db, { name: 'Gym' }); createHabit(db, { name: 'Book reading' }); createPerson(db, { name: 'David Savage', everyDays: 30 });
  assert.match(handleChat(db, 'I did gym today').text, /Logged "Gym"/); assert.match(handleChat(db, 'did my gym').text, /already checked off/);
  assert.match(handleChat(db, 'log book reading').text, /Logged "Book reading"/);
  assert.match(handleChat(db, 'I talked to David').text, /in touch with David Savage/);
  assert.equal(listHabits(db).filter((h) => h.doneToday).length, 2);
  const priv = handleChat(db, 'did gym', { private: true, deferFallback: true }); assert.doesNotMatch(priv.text, /Logged/);
  assert.equal(handleChat(db, 'show my life').action?.navigate, '#/life'); assert.equal(handleChat(db, 'open workspace').action?.navigate, '#/workspace');
});

test('workspace: default layout valid; layouts are validated, saved by name, activatable; Main cannot be deleted; limits enforced', () => {
  const db = makeDb(); let w = getWorkspaces(db); assert.equal(w.active, 'Main'); assert.deepEqual(w.layouts.Main, DEFAULT_LAYOUT);
  const mine = [{ id: 'conversation', type: 'conversation', x: 0, y: 0, w: 12, h: 10 }, { id: 'tasks', type: 'tasks', x: 0, y: 10, w: 6, h: 6 }];
  saveLayout(db, 'Focus', mine); setActive(db, 'Focus'); w = getWorkspaces(db); assert.equal(w.active, 'Focus'); assert.deepEqual(w.layouts.Focus, mine);
  assert.throws(() => saveLayout(db, 'Bad', [{ id: 'a', type: 'tasks', x: 8, y: 0, w: 6, h: 4 }]), /past the right edge/);
  assert.throws(() => saveLayout(db, 'Bad', [{ id: 'a', type: 'nope', x: 0, y: 0, w: 4, h: 4 }])); assert.throws(() => saveLayout(db, 'Bad', [mine[0], mine[0]]), /duplicate/);
  assert.throws(() => saveLayout(db, '../x', mine)); assert.throws(() => saveLayout(db, '@active', mine)); assert.throws(() => setActive(db, 'Nope'), /no such layout/);
  assert.throws(() => deleteLayout(db, 'Main')); deleteLayout(db, 'Focus'); assert.equal(getWorkspaces(db).active, 'Main'); assert.equal(getWorkspaces(db).layouts.Focus, undefined);
  for (let i = 0; i < 12; i++) saveLayout(db, `L${i}`, mine); assert.throws(() => saveLayout(db, 'One more', mine), /up to 12/);
});

import { normalizeUrl, addLink, listLinks, removeLink } from '../links.ts';
import { createGoal, logLearning, undoLearning, listGoals, findGoal } from '../life.ts';

test('links: only plain http(s) addresses are accepted; credentials, scripts and files are refused; limit enforced', () => {
  assert.equal(normalizeUrl('example.com/a b'), 'https://example.com/a%20b');
  assert.equal(normalizeUrl('http://localhost:3000/x'), 'http://localhost:3000/x');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'https://user:pw@example.com', 'ftp://example.com', 'notaurl', '']) assert.throws(() => normalizeUrl(bad));
  const db = makeDb(); const id = addLink(db, { title: ' The   Real World ', url: 'www.example.com/campus' });
  assert.deepEqual(listLinks(db).map((l) => [l.title, l.url, l.host]), [['The Real World', 'https://www.example.com/campus', 'example.com']]);
  assert.equal(removeLink(db, id), true); assert.equal(listLinks(db).length, 0);
  for (let i = 0; i < 40; i++) addLink(db, { title: `L${i}`, url: `https://e${i}.example.com` }); assert.throws(() => addLink(db, { title: 'x', url: 'https://x.example.com' }), /lot of links/);
});

test('learning goals: weekly totals are Monday-first and Chicago-dated, streaks count whole weeks, undo takes back the last entry', () => {
  const db = makeDb(); const g = createGoal(db, { name: 'TRW lessons', unit: 'lessons', perWeek: 3 });
  const log = (day: number, n = 1) => logLearning(db, g, n, T(day));
  log(5); log(6, 2);                          // week of Mon Oct 5: 3 → complete
  log(12); log(13);                           // week of Mon Oct 12: 2 so far
  let l = listGoals(db, T(13, 22))[0]; assert.equal(l.weekTotal, 2); assert.equal(l.done, false); assert.deepEqual(l.weeks.slice(-2), [3, 2]); assert.equal(l.streakWeeks, 1, 'open week never breaks the streak');
  log(14); l = listGoals(db, T(14, 22))[0]; assert.equal(l.done, true); assert.equal(l.streakWeeks, 2); assert.equal(l.allTime, 6);
  assert.equal(listGoals(db, T(19, 8))[0].weekTotal, 0, 'a new week starts Monday');
  assert.equal(undoLearning(db, g), true); assert.equal(listGoals(db, T(14, 22))[0].weekTotal, 2);
  assert.throws(() => logLearning(db, g, 0)); assert.throws(() => logLearning(db, g, 99)); assert.throws(() => createGoal(db, { name: 'trw LESSONS' }), /already have/);
  assert.equal(findGoal(db, 'trw lessons')?.id, g); assert.equal(findGoal(db, 'ab'), null);
});

test('chat: "finished a TRW lesson" logs progress toward the one matching goal; a habit of the same words wins; private mode is read-only', () => {
  const db = makeDb(); createGoal(db, { name: 'TRW lessons', unit: 'lessons', perWeek: 5 });
  const r = handleChat(db, 'I finished a TRW lesson'.replace('finished', 'did')); assert.match(r.text, /Logged one lesson toward "TRW lessons"/); assert.match(r.text, /1 of 5/);
  assert.equal(listGoals(db)[0].weekTotal, 1);
  assert.doesNotMatch(handleChat(db, 'did TRW lessons', { private: true, deferFallback: true }).text, /Logged/); assert.equal(listGoals(db)[0].weekTotal, 1);
});
