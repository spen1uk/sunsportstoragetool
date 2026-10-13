import { z } from 'zod';
import type { DB } from './db.ts';
import { id, now as isoNow } from './db.ts';
import { audit } from './audit.ts';
import { chicagoParts, addDays } from './tz.ts';
import { publish } from './events.ts';

/** Chicago calendar day as YYYY-MM-DD. All habit days use Chicago time so a late-night check-in lands on the right day. */
export const dayStr = (t: number) => { const p = chicagoParts(t); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const shift = (day: string, n: number) => { const [y, m, d] = day.split('-').map(Number); const x = addDays(y, m, d, n); return `${x.y}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`; };
const dowOf = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const rows = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export const habitInput = z.object({ name: z.string().min(1).max(60), perWeek: z.number().int().min(1).max(7).default(7) });
export const personInput = z.object({ name: z.string().min(1).max(80), relationship: z.string().max(60).default(''), notes: z.string().max(500).default(''), everyDays: z.number().int().min(1).max(365).nullable().default(null) });

export function createHabit(db: DB, raw: unknown) {
  const h = habitInput.parse(raw), name = clean(h.name, 60); if (!name) throw new Error('A habit needs a name.');
  if (rows(db, 'SELECT 1 FROM habits WHERE archived=0 AND lower(name)=lower(?)', name).length) throw new Error('You already have a habit with that name.');
  if (rows(db, 'SELECT 1 FROM habits WHERE archived=0').length >= 30) throw new Error('That is a lot of habits. Archive one first.');
  const hid = id(); db.prepare('INSERT INTO habits(id,name,per_week,created_at) VALUES(?,?,?,?)').run(hid, name, h.perWeek, isoNow());
  publish({ type: 'life' }); return hid;
}
export function archiveHabit(db: DB, hid: string) { const r = db.prepare('UPDATE habits SET archived=1 WHERE id=? AND archived=0').run(hid); publish({ type: 'life' }); return r.changes > 0; }

/** Check a habit on or off for a day (today by default; past 14 days allowed; never the future). Returns the new state. */
export function toggleHabit(db: DB, hid: string, nowMs = Date.now(), day?: string): { done: boolean } {
  const today = dayStr(nowMs), d = day ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today || d < shift(today, -14)) throw new Error('You can only check in for today or the last two weeks.');
  if (!rows(db, 'SELECT 1 FROM habits WHERE id=? AND archived=0', hid).length) throw new Error('habit not found');
  const had = rows(db, 'SELECT 1 FROM habit_logs WHERE habit_id=? AND day=?', hid, d).length > 0;
  if (had) db.prepare('DELETE FROM habit_logs WHERE habit_id=? AND day=?').run(hid, d); else db.prepare('INSERT INTO habit_logs(habit_id,day) VALUES(?,?)').run(hid, d);
  publish({ type: 'life' }); return { done: !had };
}

export function listHabits(db: DB, nowMs = Date.now()) {
  const today = dayStr(nowMs), weekStart = shift(today, -((dowOf(today) + 6) % 7));   // Monday-first week
  return rows(db, 'SELECT * FROM habits WHERE archived=0 ORDER BY created_at').map((h) => {
    const days = new Set(rows(db, 'SELECT day FROM habit_logs WHERE habit_id=? AND day>=?', h.id, shift(today, -400)).map((r) => r.day as string));
    let streak = 0, cur = days.has(today) ? today : shift(today, -1);
    while (days.has(cur) && streak < 400) { streak++; cur = shift(cur, -1); }
    return { id: h.id, name: h.name, perWeek: h.per_week, doneToday: days.has(today), streak, weekCount: [...days].filter((d) => d >= weekStart && d <= today).length, last7: Array.from({ length: 7 }, (_, i) => days.has(shift(today, i - 6))) };
  });
}

export function createPerson(db: DB, raw: unknown) {
  const p = personInput.parse(raw), name = clean(p.name, 80); if (!name) throw new Error('A person needs a name.');
  if (rows(db, 'SELECT COUNT(*) c FROM people')[0].c >= 200) throw new Error('That is a lot of people. Remove some first.');
  const pid = id(); db.prepare('INSERT INTO people(id,name,relationship,notes,every_days,created_at) VALUES(?,?,?,?,?,?)').run(pid, name, clean(p.relationship, 60), clean(p.notes, 500), p.everyDays, isoNow());
  publish({ type: 'life' }); return pid;
}
export function updatePerson(db: DB, pid: string, raw: unknown) {
  const p = personInput.partial().parse(raw); const cur = rows(db, 'SELECT * FROM people WHERE id=?', pid)[0]; if (!cur) return false;
  db.prepare('UPDATE people SET name=?, relationship=?, notes=?, every_days=? WHERE id=?').run(p.name !== undefined ? clean(p.name, 80) || cur.name : cur.name, p.relationship !== undefined ? clean(p.relationship, 60) : cur.relationship, p.notes !== undefined ? clean(p.notes, 500) : cur.notes, p.everyDays !== undefined ? p.everyDays : cur.every_days, pid);
  publish({ type: 'life' }); return true;
}
export function markContacted(db: DB, pid: string, nowMs = Date.now()) { const r = db.prepare('UPDATE people SET last_contact_ms=? WHERE id=?').run(nowMs, pid); publish({ type: 'life' }); return r.changes > 0; }
export function deletePerson(db: DB, pid: string) { const r = db.prepare('DELETE FROM people WHERE id=?').run(pid); if (r.changes) audit(db, 'luke', 'life.person_removed', pid); publish({ type: 'life' }); return r.changes > 0; }

const DAY = 86_400_000;
/** People with how long since you were last in touch, most overdue first. A person with no "every N days" is never overdue; one never contacted counts from when they were added. */
export function listPeople(db: DB, nowMs = Date.now()) {
  return rows(db, 'SELECT * FROM people').map((p) => {
    const since = p.last_contact_ms ?? Date.parse(p.created_at), daysSince = Math.floor((nowMs - since) / DAY);
    const overdueBy = p.every_days ? daysSince - p.every_days : null;
    return { id: p.id, name: p.name, relationship: p.relationship, notes: p.notes, everyDays: p.every_days as number | null, lastContact: p.last_contact_ms as number | null, daysSince, never: p.last_contact_ms === null, due: overdueBy !== null && overdueBy >= 0, overdueBy };
  }).sort((a, b) => Number(b.due) - Number(a.due) || (b.overdueBy ?? -1e9) - (a.overdueBy ?? -1e9) || a.name.localeCompare(b.name));
}

/** For chat: find the one habit / person a sentence is about (substring either way). null when none or ambiguous. */
export function findHabit(db: DB, text: string) {
  const t = text.toLowerCase(), hits = listHabits(db).filter((h) => t.includes(h.name.toLowerCase()) || h.name.toLowerCase().includes(t.trim()));
  return hits.length === 1 ? hits[0] : null;
}
export function findPerson(db: DB, text: string) {
  const t = text.toLowerCase().trim(); if (t.length < 2) return null;
  const hits = listPeople(db).filter((p) => t.includes(p.name.toLowerCase()) || p.name.toLowerCase().split(' ')[0] === t);
  return hits.length === 1 ? hits[0] : null;
}
