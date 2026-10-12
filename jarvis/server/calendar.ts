import { z } from 'zod';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { audit } from './audit.ts';
import { getRunner, MacError, isMac } from './mac.ts';
import { publish } from './events.ts';
import { expand } from './recurrence.ts';

const DAY = 86_400_000, PAST_DAYS = 1, AHEAD_DAYS = 14, STALE_MS = 45 * 60_000;

// JXA run on the Mac. Reads only. Bulk property access keeps big calendars fast.
const LIST_JS = `function run(){ const C = Application('Calendar'); return JSON.stringify(C.calendars().map(c => c.name())); }`;
// Reads every event of the chosen calendars in bulk (no date filter in the query: the filter is applied here, because Calendar's own
// date queries silently miss repeating events and, on some setups, everything). Repeating events come back as their RRULE text and are expanded in TypeScript.
const EVENTS_JS = `function run(argv){
  const from = Number(argv[0]), to = Number(argv[1]), want = JSON.parse(argv[2]);
  const C = Application('Calendar'), out = [], stats = {};
  for (const cal of C.calendars()) {
    const name = cal.name(); if (want.indexOf(name) < 0) continue;
    const evs = cal.events, t = evs.summary(), s = evs.startDate(), e = evs.endDate(), a = evs.alldayEvent(), l = evs.location(), u = evs.uid();
    let r = [], x = []; try { r = evs.recurrence(); } catch (err) {} try { x = evs.excludedDates(); } catch (err) {}
    const st = { total: t.length, inWindow: 0, repeating: 0 }; stats[name] = st;
    for (let i = 0; i < t.length; i++) {
      const rule = r[i] ? String(r[i]) : '', sm = s[i].getTime(), em = e[i].getTime();
      if (rule) { if (sm > to) continue; st.repeating++; } else { if (em < from || sm > to) continue; st.inWindow++; }
      out.push({ calendar: name, uid: String(u[i]), title: String(t[i] || ''), start: sm, end: em, allDay: !!a[i], location: String(l[i] || ''), rule: rule,
        exclude: Array.isArray(x[i]) ? x[i].map(d => d.getTime()) : [] });
    }
  }
  return JSON.stringify({ events: out, stats: stats });
}`;

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const EventRow = z.object({ calendar: z.string().min(1).max(200), uid: z.string().min(1).max(300), title: z.string().max(2000), start: z.number().int(), end: z.number().int(), allDay: z.boolean(), location: z.string().max(1000), rule: z.string().max(2000).optional(), exclude: z.array(z.number()).max(5000).optional() });

export type RawEvent = z.infer<typeof EventRow>;
export type CalEvent = { calendar: string; uid: string; title: string; start: number; end: number; allDay: boolean; location: string };
export type Stats = Record<string, { total: number; inWindow: number; repeating: number }>;
export const parseScan = (raw: string): { events: (CalEvent & { rule: string; exclude: number[] })[]; stats: Stats } => {
  const j = z.object({ events: z.array(z.unknown()), stats: z.record(z.string(), z.object({ total: z.number(), inWindow: z.number(), repeating: z.number() })).default({}) }).parse(JSON.parse(raw));
  const events: (CalEvent & { rule: string; exclude: number[] })[] = [];
  for (const x of j.events) {
    const r = EventRow.safeParse(x); if (!r.success) continue;   // skip a malformed row rather than lose the whole sync
    const e = r.data; events.push({ calendar: clean(e.calendar, 120), uid: e.uid, title: clean(e.title, 200) || '(no title)', start: e.start, end: Math.max(e.end, e.start), allDay: e.allDay, location: clean(e.location, 200), rule: (e.rule ?? '').trim(), exclude: e.exclude ?? [] });
  }
  return { events, stats: j.stats };
};
/** Turn the scan into concrete occurrences inside [from, to]: one-off events as they are, repeating ones expanded from their rule. */
export function occurrences(scan: ReturnType<typeof parseScan>, from: number, to: number): { events: CalEvent[]; unsupported: number; repeating: number } {
  const out: CalEvent[] = []; let unsupported = 0, repeating = 0;
  for (const e of scan.events) {
    const { rule, exclude, ...base } = e;
    if (!rule) { if (e.end >= from && e.start <= to) out.push(base); continue; }
    repeating++;
    const occ = expand({ start: e.start, end: e.end, rule, exclude }, from, to);
    if (occ === 'unsupported') { unsupported++; if (e.end >= from && e.start <= to) out.push(base); continue; }   // at least show the first occurrence if it is in range
    for (const o of occ) out.push({ ...base, start: o.start, end: o.end });
  }
  return { events: out, unsupported, repeating };
}

export type Source = { name: string; enabled: boolean };
export function sources(db: DB, kind: 'calendar' | 'notes'): Source[] {
  return (db.prepare('SELECT name, enabled FROM mac_sources WHERE kind=? ORDER BY name').all(kind) as any[]).map((r) => ({ name: r.name, enabled: !!r.enabled }));
}
export function rememberSources(db: DB, kind: 'calendar' | 'notes', names: string[]) {
  const ins = db.prepare('INSERT OR IGNORE INTO mac_sources(kind,name,enabled) VALUES(?,?,0)');
  tx(db, () => { for (const n of names) ins.run(kind, clean(n, 120)); });
}
/** Luke's choice of exactly which calendars / folders Jarvis may read. Unlisted ones are switched off and their cached copies deleted. */
export function setEnabled(db: DB, kind: 'calendar' | 'notes', enabled: string[]) {
  tx(db, () => {
    db.prepare('UPDATE mac_sources SET enabled=0 WHERE kind=?').run(kind);
    const up = db.prepare('UPDATE mac_sources SET enabled=1 WHERE kind=? AND name=?');
    for (const n of enabled) up.run(kind, n);
    if (kind === 'calendar') db.prepare('DELETE FROM calendar_events WHERE calendar NOT IN (SELECT name FROM mac_sources WHERE kind=\'calendar\' AND enabled=1)').run();
    else db.prepare('DELETE FROM notes_cache WHERE folder NOT IN (SELECT name FROM mac_sources WHERE kind=\'notes\' AND enabled=1)').run();
  });
  audit(db, 'luke', `${kind}.sources`, '', { enabled });
  setConnection(db, kind);
}

const CONN: Record<string, string> = { calendar: 'apple-calendar', notes: 'apple-notes' };
export type SyncState = { detail: any; status: 'connected' | 'stale' | 'disconnected' | 'planned'; lastOk: number | null; lastTry: number | null; error: string | null; count: number };
export function syncState(db: DB, kind: 'calendar' | 'notes', now = Date.now()): SyncState {
  const r = db.prepare('SELECT * FROM mac_sync WHERE kind=?').get(kind) as any;
  const on = sources(db, kind).some((s) => s.enabled);
  if (!on) return { detail: null, status: 'planned', lastOk: null, lastTry: r?.last_try_ms ?? null, error: r?.last_error ?? null, count: 0 };
  if (!r?.last_ok_ms) return { detail: r?.detail ? JSON.parse(r.detail) : null, status: 'disconnected', lastOk: null, lastTry: r?.last_try_ms ?? null, error: r?.last_error ?? null, count: 0 };
  const stale = !!r.last_error || now - r.last_ok_ms > STALE_MS;
  return { detail: r.detail ? JSON.parse(r.detail) : null, status: stale ? 'stale' : 'connected', lastOk: r.last_ok_ms, lastTry: r.last_try_ms, error: r.last_error, count: r.count };
}
/** Keep the Connections table (and so Jarvis's own honesty rules) in step with what really happened. */
export function setConnection(db: DB, kind: 'calendar' | 'notes', now = Date.now()) {
  const s = syncState(db, kind, now);
  const scopes = s.status === 'planned' ? '' : `read-only: ${sources(db, kind).filter((x) => x.enabled).map((x) => x.name).join(', ')}`;
  const note = s.status === 'planned' ? `Not connected. Choose which ${kind === 'calendar' ? 'calendars' : 'folders'} Jarvis may read on the ${kind === 'calendar' ? 'Calendar' : 'Notes'} page.`
    : s.error ? `Last sync failed: ${s.error}` : kind === 'calendar' ? 'Read from the Mac\'s Calendar app. Repeating events are expanded from their rules; unusual patterns may be missed. Nothing is ever written back.' : 'Read from the Mac\'s Notes app, only the folders you chose. Never sent to the language model. Nothing is ever written back.';
  db.prepare('UPDATE connections SET status=?, scopes=?, note=?, last_sync=? WHERE id=?').run(s.status, scopes, note.slice(0, 300), s.lastOk ? new Date(s.lastOk).toISOString() : null, CONN[kind]);
}
export function recordSync(db: DB, kind: 'calendar' | 'notes', ok: boolean, count: number, error: string | null, now = Date.now(), detail: unknown = null) {
  db.prepare(`INSERT INTO mac_sync(kind,last_ok_ms,last_try_ms,last_error,count,detail) VALUES(?,?,?,?,?,?)
    ON CONFLICT(kind) DO UPDATE SET detail=CASE WHEN ? THEN excluded.detail ELSE mac_sync.detail END, last_try_ms=excluded.last_try_ms, last_error=excluded.last_error, last_ok_ms=CASE WHEN ? THEN excluded.last_try_ms ELSE mac_sync.last_ok_ms END, count=CASE WHEN ? THEN excluded.count ELSE mac_sync.count END`)
    .run(kind, ok ? now : null, now, error, count, detail ? JSON.stringify(detail) : null, ok ? 1 : 0, ok ? 1 : 0, ok ? 1 : 0);
  setConnection(db, kind, now);
  publish({ type: 'calendar-sync', kind });
}

export async function detectCalendars(db: DB): Promise<string[]> {
  const names = z.array(z.string()).parse(JSON.parse(await getRunner()(LIST_JS, [], 30_000)));
  rememberSources(db, 'calendar', names); return names;
}

let syncing = false;
/** Pull the next two weeks (and yesterday) for the chosen calendars. On failure the old copy stays, labelled stale. */
export async function syncCalendar(db: DB, now = Date.now()): Promise<{ ok: boolean; count?: number; error?: string }> {
  const want = sources(db, 'calendar').filter((s) => s.enabled).map((s) => s.name);
  if (!want.length) return { ok: false, error: 'Choose at least one calendar first.' };
  if (syncing) return { ok: false, error: 'A sync is already running.' };
  syncing = true; let detail: unknown = null;
  try {
    const from = now - PAST_DAYS * DAY, to = now + AHEAD_DAYS * DAY;
    const scan = parseScan(await getRunner()(EVENTS_JS, [String(from), String(to), JSON.stringify(want)], 240_000));
    const occ = occurrences(scan, from, to), events = occ.events.filter((e) => want.includes(e.calendar));
    tx(db, () => {
      db.prepare('DELETE FROM calendar_events').run();
      const ins = db.prepare('INSERT OR REPLACE INTO calendar_events(calendar,uid,title,start_ms,end_ms,all_day,location) VALUES(?,?,?,?,?,?,?)');
      for (const e of events) ins.run(e.calendar, e.uid, e.title, e.start, e.end, e.allDay ? 1 : 0, e.location);
    });
    const scanned = Object.values(scan.stats).reduce((n, x) => n + x.total, 0);
    detail = { scanned, calendars: scan.stats, repeatingSeries: occ.repeating, unsupportedRules: occ.unsupported };
    recordSync(db, 'calendar', true, events.length, null, now, detail);
    audit(db, 'jarvis', 'calendar.sync', '', { count: events.length, scanned });
    return { ok: true, count: events.length };
  } catch (e) {
    const msg = e instanceof MacError ? e.message : 'Calendar sync failed.';
    recordSync(db, 'calendar', false, 0, msg, now); audit(db, 'jarvis', 'calendar.sync_failed', '', { kind: (e as any)?.kind ?? 'failed' });
    return { ok: false, error: msg };
  } finally { syncing = false; }
}

export function upcoming(db: DB, from: number, to: number): CalEvent[] {
  return (db.prepare('SELECT * FROM calendar_events WHERE end_ms >= ? AND start_ms <= ? ORDER BY start_ms, title').all(from, to) as any[])
    .map((r) => ({ calendar: r.calendar, uid: r.uid, title: r.title, start: r.start_ms, end: r.end_ms, allDay: !!r.all_day, location: r.location }));
}
/** Busy time for the day planner: timed events only (all-day events are shown but do not block work slots). */
export function busyIntervals(db: DB, from: number, to: number): { start: number; end: number }[] {
  return upcoming(db, from, to).filter((e) => !e.allDay && e.end > e.start).map((e) => ({ start: e.start, end: e.end }));
}
export const calendarConnected = (db: DB, now = Date.now()) => { const s = syncState(db, 'calendar', now).status; return s === 'connected' || s === 'stale'; };
export const macAvailable = isMac;
