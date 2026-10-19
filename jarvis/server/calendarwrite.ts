import { z } from 'zod';
import { type DB, id, getMeta, setMeta } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { getRunner, MacError, classify } from './mac.ts';
import { isPaused } from './pause.ts';
import { sources, upcoming, syncCalendar } from './calendar.ts';
import { chicagoParts, chicagoInstant, addDays, MIN } from './tz.ts';
import { workWindows } from './schedule.ts';
import { looksSecret } from './memory.ts';
import { isExcluded } from './exclusions.ts';

/**
 * Writing to Apple Calendar. Nothing is written without an approval you confirm (the exact title, time and calendar are bound to it).
 * Before asking, Jarvis checks for overlaps with your events and your protected times (gym, family...), allows for travel and preparation,
 * and offers other times that fit. Approved changes go into an outbox and are applied on the Mac with macOS's own scripting; the outcome
 * (applied or failed, and why) is recorded. Repeating events are never moved (too easy to damage a whole series).
 */
const H = 60 * MIN, BUFFER = 15 * MIN;
const target = (db: DB) => getMeta(db, 'calendar:write_target') ?? '';
export function setTarget(db: DB, name: string) {
  if (!sources(db, 'calendar').some((s) => s.name === name)) throw new Error('Choose one of the calendars Jarvis already knows (Calendar page).');
  setMeta(db, 'calendar:write_target', name); audit(db, 'luke', 'calendar.write_target', '', { calendar: name }); publish({ type: 'calendar' });
}
export const getTarget = target;

// ---- protected times ----
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const blockIn = z.object({ label: z.string().min(2).max(60), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: hm, end: hm }).strict().refine((b) => toMin(b.end) > toMin(b.start), 'The end must be after the start.');
export const listProtected = (db: DB) => (db.prepare('SELECT * FROM protected_blocks ORDER BY created_at').all() as any[]).map((r) => ({ id: r.id, label: r.label, days: JSON.parse(r.days) as number[], start: `${String(Math.floor(r.start_min / 60)).padStart(2, '0')}:${String(r.start_min % 60).padStart(2, '0')}`, end: `${String(Math.floor(r.end_min / 60)).padStart(2, '0')}:${String(r.end_min % 60).padStart(2, '0')}`, active: !!r.active }));
export function addProtected(db: DB, raw: unknown) {
  const v = blockIn.parse(raw); if (looksSecret(v.label) || isExcluded(db, v.label)) throw new Error('That label looks like a secret or a name you excluded.'); if (listProtected(db).length >= 20) throw new Error('Up to 20 protected times.');
  const pid = id(); db.prepare('INSERT INTO protected_blocks(id,label,days,start_min,end_min,created_at) VALUES(?,?,?,?,?,?)').run(pid, v.label, JSON.stringify([...new Set(v.days)].sort()), toMin(v.start), toMin(v.end), Date.now()); audit(db, 'luke', 'calendar.protected_added', pid); publish({ type: 'calendar' }); return pid;
}
export const removeProtected = (db: DB, pid: string) => { const r = db.prepare('DELETE FROM protected_blocks WHERE id=?').run(pid); if (r.changes) { audit(db, 'luke', 'calendar.protected_removed', pid); publish({ type: 'calendar' }); } return r.changes > 0; };
/** Protected intervals falling between from and to (Chicago wall-clock times). */
export function protectedIntervals(db: DB, from: number, to: number): { start: number; end: number; label: string }[] {
  const out: { start: number; end: number; label: string }[] = []; const p0 = chicagoParts(from);
  for (let n = 0; n <= Math.ceil((to - from) / (24 * H)) + 1; n++) { const d = addDays(p0.y, p0.m, p0.d, n); for (const b of listProtected(db)) { if (!b.active || !b.days.includes(d.dow)) continue; const s = chicagoInstant(d.y, d.m, d.d, Math.floor(toMin(b.start) / 60), toMin(b.start) % 60), e = chicagoInstant(d.y, d.m, d.d, Math.floor(toMin(b.end) / 60), toMin(b.end) % 60); if (e > from && s < to) out.push({ start: s, end: e, label: b.label }); } }
  return out;
}

// ---- checking a proposed event ----
const evIn = z.object({ title: z.string().min(2).max(120), start: z.number().int(), end: z.number().int(), location: z.string().max(160).default(''), notes: z.string().max(500).default(''), travelBeforeMin: z.number().int().min(0).max(240).default(0), travelAfterMin: z.number().int().min(0).max(240).default(0), prepMin: z.number().int().min(0).max(240).default(0) }).strict()
  .refine((e) => e.end > e.start && e.end - e.start <= 24 * H, 'The end must be after the start, within a day.');
export type EventIn = z.infer<typeof evIn>;
export function check(db: DB, raw: unknown, now = Date.now(), ignoreUid?: string) {
  const e = evIn.parse(raw); const from = e.start - (e.prepMin + e.travelBeforeMin) * MIN, to = e.end + e.travelAfterMin * MIN, warnings: string[] = [];
  if (e.start < now) warnings.push('This is in the past.'); const p = chicagoParts(e.start); if (p.hour < 6 || p.hour >= 22) warnings.push('This is very early or late in the day.');
  const conflicts = upcoming(db, from - BUFFER, to + BUFFER).filter((x) => !x.allDay && x.uid !== ignoreUid && x.start < to && x.end > from).map((x) => ({ title: x.title, start: x.start, end: x.end, calendar: x.calendar }));
  const hits = protectedIntervals(db, from, to).filter((b) => b.start < to && b.end > from).map((b) => b.label);
  if (e.prepMin || e.travelBeforeMin || e.travelAfterMin) warnings.push(`Allowing ${e.prepMin} min to prepare, ${e.travelBeforeMin} min travelling there and ${e.travelAfterMin} min back.`);
  return { event: e, blockStart: from, blockEnd: to, conflicts, protectedHits: [...new Set(hits)], warnings, ok: conflicts.length === 0 && hits.length === 0 };
}
/** Times that fit: inside your work hours, clear of events (with a 15-minute buffer) and protected times, allowing travel and prep. */
export function suggestSlots(db: DB, o: { durationMin: number; travelBeforeMin?: number; travelAfterMin?: number; prepMin?: number; fromMs?: number; days?: number; count?: number }, now = Date.now()) {
  const dur = Math.min(8 * 60, Math.max(15, o.durationMin)) * MIN, before = ((o.prepMin ?? 0) + (o.travelBeforeMin ?? 0)) * MIN, after = (o.travelAfterMin ?? 0) * MIN, from = Math.max(o.fromMs ?? now, now), days = Math.min(21, o.days ?? 7), out: { start: number; end: number }[] = [];
  const busy = [...upcoming(db, from - H, from + (days + 1) * 24 * H).filter((x) => !x.allDay).map((x) => ({ start: x.start - BUFFER, end: x.end + BUFFER })), ...protectedIntervals(db, from - H, from + (days + 1) * 24 * H)];
  for (const w of workWindows(from, days + 2)) for (let s = Math.ceil(Math.max(w.start + before, from) / (30 * MIN)) * 30 * MIN; s + dur + after <= w.end; s += 30 * MIN) { const bs = s - before, be = s + dur + after; if (!busy.some((b) => b.start < be && b.end > bs)) out.push({ start: s, end: s + dur }); if (out.length >= (o.count ?? 5)) return out; }
  return out;
}

// ---- asking for approval ----
export const approvalPayload = z.object({ title: z.string().min(2).max(120), calendar: z.string().min(1).max(80), start: z.number().int(), end: z.number().int(), location: z.string().max(160).default(''), notes: z.string().max(500).default(''), heads_up: z.array(z.string().max(200)).max(8).default([]) }).strict();
export const movePayload = z.object({ uid: z.string().min(1).max(200), calendar: z.string().min(1).max(80), title: z.string().max(120), oldStart: z.number().int(), newStart: z.number().int(), newEnd: z.number().int(), heads_up: z.array(z.string().max(200)).max(8).default([]) }).strict();
const fmt = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const describeCreate = (p: any) => `Add “${p.title}” to your ${p.calendar} calendar, ${fmt(p.start)} to ${fmt(p.end)}${p.location ? ` at ${p.location}` : ''}${p.heads_up?.length ? `. Heads up: ${p.heads_up.join(' ')}` : ''}`;
export const describeMove = (p: any) => `Move “${p.title}” (${p.calendar}) from ${fmt(p.oldStart)} to ${fmt(p.newStart)}–${fmt(p.newEnd)}${p.heads_up?.length ? `. Heads up: ${p.heads_up.join(' ')}` : ''}`;
function headsUp(c: ReturnType<typeof check>) { const h = [...c.warnings]; if (c.conflicts.length) h.push(`Overlaps: ${c.conflicts.slice(0, 3).map((x) => x.title).join(', ')}.`); if (c.protectedHits.length) h.push(`Cuts into your protected time: ${c.protectedHits.join(', ')}.`); return h; }

/** Checks, then raises the approval request. Never writes. Returns the check so the page can show what was found. */
export async function requestCreate(db: DB, raw: unknown, request: (type: string, payload: unknown) => string, now = Date.now()) {
  const c = check(db, raw, now); const cal = target(db); if (!cal) throw new Error('Choose which calendar Jarvis may add events to first.');
  if (looksSecret(c.event.title + c.event.notes) || isExcluded(db, `${c.event.title} ${c.event.notes} ${c.event.location}`)) throw new Error('That looks like a secret or mentions something you asked me never to store.');
  const payload = approvalPayload.parse({ title: c.event.title, calendar: cal, start: c.event.start, end: c.event.end, location: c.event.location, notes: c.event.notes, heads_up: headsUp(c) });
  return { check: c, approvalId: request('calendar_create', payload) };
}
export function requestMove(db: DB, o: { uid: string; calendar: string; newStart: number; newEnd?: number }, request: (type: string, payload: unknown) => string, now = Date.now()) {
  const rows = db.prepare('SELECT * FROM calendar_events WHERE uid=? AND calendar=?').all(o.uid, o.calendar) as any[]; if (!rows.length) throw new Error('That event is not in the calendar copy Jarvis has. Sync the calendar first.');
  if (rows.length > 1) throw new Error('That is a repeating event. Jarvis will not move one, because it could change the whole series. Move it in Calendar yourself.'); const ev = rows[0]; if (ev.all_day) throw new Error('All-day events are not moved by Jarvis.');
  const newEnd = o.newEnd ?? o.newStart + (ev.end_ms - ev.start_ms); const c = check(db, { title: ev.title, start: o.newStart, end: newEnd }, now, o.uid);
  const payload = movePayload.parse({ uid: o.uid, calendar: o.calendar, title: ev.title, oldStart: ev.start_ms, newStart: o.newStart, newEnd, heads_up: headsUp(c) }); return { check: c, approvalId: request('calendar_move', payload) };
}

// ---- applying approved changes ----
export function queue(db: DB, kind: 'create' | 'move', payload: unknown, approvalId?: string, now = Date.now()) {
  const p = kind === 'create' ? approvalPayload.parse(payload) : movePayload.parse(payload); const oid = id();
  db.prepare('INSERT INTO calendar_outbox(id,kind,payload,approval_id,created_at) VALUES(?,?,?,?,?)').run(oid, kind, JSON.stringify(p), approvalId ?? null, now); audit(db, 'system', 'calendar.queued', oid, { kind }); publish({ type: 'calendar' }); return oid;
}
const CREATE_JS = `function run(argv){ const a = JSON.parse(argv[0]); const C = Application('Calendar'); const cal = C.calendars.byName(a.calendar); const ev = C.Event({ summary: a.title, startDate: new Date(a.start), endDate: new Date(a.end), location: a.location || '', description: a.notes || '' }); cal.events.push(ev); return JSON.stringify({ ok: true }); }`;
const MOVE_JS = `function run(argv){ const a = JSON.parse(argv[0]); const C = Application('Calendar'); const found = C.calendars.byName(a.calendar).events.whose({ uid: a.uid })(); if (found.length !== 1) throw new Error('expected exactly one matching event, found ' + found.length); found[0].startDate = new Date(a.newStart); found[0].endDate = new Date(a.newEnd); return JSON.stringify({ ok: true }); }`;
let draining = false;
/** Applies queued changes on the Mac. Safe to call often; does nothing when the queue is empty. Never throws. */
export async function drain(db: DB, now = Date.now()): Promise<number> {
  if (draining || isPaused(db)) return 0; draining = true; let done = 0;
  try {
    for (const o of db.prepare("SELECT * FROM calendar_outbox WHERE status='queued' AND attempts<3 ORDER BY created_at").all() as any[]) {
      db.prepare('UPDATE calendar_outbox SET attempts=attempts+1 WHERE id=?').run(o.id); const p = JSON.parse(o.payload);
      try {
        await getRunner()(o.kind === 'create' ? CREATE_JS : MOVE_JS, [JSON.stringify(o.kind === 'create' ? { calendar: p.calendar, title: p.title, start: p.start, end: p.end, location: p.location, notes: p.notes } : p)], 60_000);
        db.prepare("UPDATE calendar_outbox SET status='done', done_at=?, error=NULL WHERE id=?").run(now, o.id); audit(db, 'system', 'calendar.applied', o.id, { kind: o.kind }); done++;
      } catch (e) {
        const msg = e instanceof MacError ? e.message : classify(String((e as Error).message), false).message; const final = o.attempts + 1 >= 3 || (e instanceof MacError && e.kind !== 'timeout');
        db.prepare('UPDATE calendar_outbox SET error=?, status=? WHERE id=?').run(msg.slice(0, 240), final ? 'failed' : 'queued', o.id); audit(db, 'system', 'calendar.apply_failed', o.id, { kind: o.kind, final });
      }
    }
    if (done) { publish({ type: 'calendar' }); void syncCalendar(db, now).catch(() => { /* the next scheduled sync will refresh */ }); }
  } finally { draining = false; }
  return done;
}
export const outbox = (db: DB) => (db.prepare('SELECT id,kind,payload,status,error,attempts,created_at,done_at FROM calendar_outbox ORDER BY created_at DESC LIMIT 20').all() as any[]).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
export const retry = (db: DB, oid: string) => { const r = db.prepare("UPDATE calendar_outbox SET status='queued', attempts=0, error=NULL WHERE id=? AND status='failed'").run(oid); return r.changes > 0; };
