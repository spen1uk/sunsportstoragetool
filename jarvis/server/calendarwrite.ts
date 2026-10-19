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
import { complete, ready } from './llm/gateway.ts';

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
/** Direct mode (on by default, Luke's choice): calendar changes he asks for himself are applied straight away, with no approval step. They are still logged, and the emergency stop still halts them. */
export const directOn = (db: DB) => getMeta(db, 'hub:direct') !== '0';
export function setDirect(db: DB, on: boolean) { setMeta(db, 'hub:direct', on ? '1' : '0'); audit(db, 'luke', 'hub.direct', '', { on }); publish({ type: 'calendar' }); }
/** The "request" function used in direct mode: queues the change at once instead of raising an approval. */
export const applyNow = (db: DB) => (type: string, payload: unknown): string => { queue(db, type.replace('calendar_', '') as 'create' | 'move' | 'delete', payload); audit(db, 'luke', 'calendar.direct', '', { type }); void drain(db).catch(() => { /* recorded in the outbox */ }); return 'direct'; };

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

export const deletePayload = z.object({ uid: z.string().min(1).max(200), calendar: z.string().min(1).max(80), title: z.string().max(120), start: z.number().int(), series: z.boolean().optional(), count: z.number().int().optional() }).strict();
export const describeDelete = (p: any) => p.series ? `Delete the whole repeating series “${p.title}” (${p.calendar}), all ${p.count ?? ''} dates. This removes every date from Apple Calendar.` : `Delete “${p.title}” (${p.calendar}) on ${fmt(p.start)}. This removes it from Apple Calendar.`;
/** Asks to delete one event. A repeating event is only deleted as a whole series, and only when asked for explicitly (series: true). All-day events are never deleted. */
export function requestDelete(db: DB, o: { uid: string; calendar: string; series?: boolean }, request: (type: string, payload: unknown) => string) {
  const rows = db.prepare('SELECT * FROM calendar_events WHERE uid=? AND calendar=? ORDER BY start_ms').all(o.uid, o.calendar) as any[]; if (!rows.length) throw new Error('That event is not in the calendar copy Jarvis has. Sync the calendar first.');
  if (rows.length > 1 && !o.series) throw new Error('That is a repeating event. Say “delete it on all dates” to remove the whole series.');
  const ev = rows[0]; if (rows.every((r) => r.all_day)) throw new Error('All-day events are not deleted by Jarvis.');
  const series = rows.length > 1;
  return { approvalId: request('calendar_delete', deletePayload.parse({ uid: o.uid, calendar: o.calendar, title: ev.title, start: ev.start_ms, ...(series ? { series: true, count: rows.length } : {}) })), title: ev.title as string, start: ev.start_ms as number, series, count: rows.length };
}
const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function close(a: string, b: string) {   // equal, or one letter off for longer words ("freinds" is "friends")
  if (a === b) return true; if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 1) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  if (d[a.length][b.length] <= 1) return true; return a[0] === b[0] && a[a.length - 1] === b[b.length - 1] && a.length === b.length && [...a].sort().join('') === [...b].sort().join('');   // one letter off, or two swapped letters
}
const STOP = new Set(['task', 'tasks', 'the', 'a', 'an', 'my', 'our', 'that', 'this', 'to', 'of', 'and', 'on', 'for', 'in', 'all', 'dates', 'event', 'events', 'meeting', 'meetings', 'appointment', 'calendar']);
const matches = (title: string, words: string[]) => { const tw = norm(title).split(' '); return words.length > 0 && words.every((w) => tw.some((t) => close(w, t) || (w.length >= 3 && t.startsWith(w)))); };
/**
 * Plain-words delete from chat ("delete the dentist appointment", "remove that event", "delete how to win friends on all dates"). Returns null when the message is not about a calendar event.
 * "on all dates / every time / the whole series" deletes a repeating event as a whole series. In direct mode it is done at once; otherwise it raises an approval.
 */
export function chatDelete(db: DB, text: string, request: (type: string, payload: unknown) => string, now = Date.now(), direct = false): string | null {
  const m = text.trim().match(/^(?:please\s+|can you\s+|could you\s+)?(?:delete|remove|cancel|get rid of)\s+(.{2,160}?)\s*[?.!]*$/i); if (!m) return null;
  const all = ALL.test(m[1]); const mentionsCal = /\b(event|meeting|appointment|calendar)\b/i.test(text) || all;
  return deleteCore(db, m[1], { all, mentionsCal }, request, now, direct);
}
const ALL = /\b(on all dates|all (?:the )?(?:dates|occurrences|instances|of them)|every (?:date|time|one|occurrence)|the whole series|entire series|whole series|all of it|everywhere)\b/i;
/** Finds the event named by `phrase` and deletes it (a repeating one only as a whole series, when asked for all dates). */
function deleteCore(db: DB, phrase: string, o: { all: boolean; mentionsCal: boolean }, request: (type: string, payload: unknown) => string, now: number, direct: boolean): string | null {
  const { all, mentionsCal } = o;
  const words = norm(phrase).split(' ').filter((w) => w && !STOP.has(w)); const vague = words.length === 0 || (words.length === 1 && ['it', 'one', 'last', 'test'].includes(words[0]));
  if (!mentionsCal && vague) return null;
  const evs = upcoming(db, now - 30 * 24 * H, now + 400 * 24 * H).filter((e) => !e.allDay); let hit: typeof evs = [];
  if (vague) { const last = (db.prepare("SELECT payload FROM calendar_outbox WHERE kind='create' AND status='done' ORDER BY created_at DESC LIMIT 1").get() as { payload: string } | undefined); const t = last ? String(JSON.parse(last.payload).title).toLowerCase() : ''; hit = t ? evs.filter((e) => e.title.toLowerCase() === t) : []; if (!hit.length) return 'Which event? Tell me its name, like “delete the dentist appointment”.'; }
  else hit = evs.filter((e) => matches(e.title, words));
  if (!hit.length) return mentionsCal ? `I couldn't find an upcoming event matching “${phrase.trim()}” in your calendar copy. If it was just added, wait a minute for the sync and ask again.` : null;
  const groups = new Map<string, typeof evs>(); for (const e of hit) groups.set(`${e.calendar}|${e.uid}`, [...(groups.get(`${e.calendar}|${e.uid}`) ?? []), e]);
  const titles = new Set(hit.map((e) => e.title)); if (groups.size > 1 && (titles.size > 1 || groups.size > 3) && !vague) return `I found ${titles.size} events that match: ${[...titles].slice(0, 4).map((t) => `“${t}”`).join('; ')}. Tell me which one, with its full name.`;
  const best = [...groups.values()].sort((x, y) => Math.abs(x[0].start - now) - Math.abs(y[0].start - now))[0]; const repeating = best.length > 1;
  try { const r = requestDelete(db, { uid: best[0].uid, calendar: best[0].calendar, series: all && repeating }, request);
    if (r.series) return direct ? `Done. I've deleted the whole “${r.title}” series, all ${r.count} dates. It will disappear from Apple Calendar within a minute.` : `I've asked for your approval to delete the whole “${r.title}” series (${r.count} dates). Nothing is deleted until you approve it on the Approvals page with your passkey.`;
    return direct ? `Done. I've deleted “${r.title}” (${fmt(r.start)}). It will disappear from Apple Calendar within a minute.` : `I've asked for your approval to delete “${r.title}” on ${fmt(r.start)}. Nothing is deleted until you approve it on the Approvals page with your passkey.`;
  } catch (e) { return (e as Error).message.replace('Say “delete it on all dates” to remove the whole series.', `It has ${best.length} dates. Say “delete ${phrase.trim()} on all dates” to remove the whole series.`); }
}

const SPEC = 'Read Luke\'s message about his calendar and answer with JSON only. Operations: {"op":"add","events":[{"title": string, "start": "YYYY-MM-DD HH:MM", "end": "YYYY-MM-DD HH:MM" or null, "location": string}]} (at most 10) | {"op":"delete","title": the words of the event\'s title, "all": true if he wants every date of a repeating event removed} | {"op":"move","title": the words of the event\'s title, "start": "YYYY-MM-DD HH:MM" the new start} | {"op":"none"} when the message is not asking to change the calendar (a question, another topic). Times are Chicago local time, 24-hour. If no time is given use 09:00. If no length is given use one hour. If a later event in the same message has no title of its own ("also make one for September 10th"), give it the same title as the event before it. Use the year stated; if none, the next time that date comes around. Fix obvious spelling mistakes in titles and write them tidily. Only if a date is truly missing or unclear, answer exactly {"error":"..."} with one short question. Output nothing but the JSON.';
/** Spelling does not matter: calendar, calender, calander, cal. */
const CAL = /\b(calend[ae]r|calander|calendars|cal|agenda|schedule)\b/i;
const CAL_VERB = /\b(add|put|schedule|book|create|make|set up|mark|block|note|write|stick|throw|pencil|place|do|enter|log|delete|remove|cancel|clear|get rid of|take off|move|reschedule|push|shift|change|postpone)\b/i;
/**
 * Plain-words calendar changes from chat: add, delete or move, in any sentence shape ("put on the calender for August 1st…", "on my calender delete all the … events for every date").
 * One model call reads the message (and the last few chat lines, so "those two dates" make sense) and returns a small form; ordinary code finds the event and does it.
 * Returns null when the message is not about changing the calendar.
 */
export async function chatCreate(db: DB, text: string, request: (type: string, payload: unknown) => string, now = Date.now(), direct = false): Promise<string | null> {
  const t = text.trim(); const recent = (db.prepare('SELECT role, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 8) ORDER BY id').all() as { role: string; content: string }[]).map((m) => ({ role: m.role, content: m.content.replace(/\n\nFrom the internet[\s\S]*/, '').slice(0, 300) }));
  const explicit = CAL.test(t) || /\b(event|appointment|meeting|reminder)\b/i.test(t);
  const followUp = !explicit && recent.some((m) => CAL.test(m.content) || /^Done\. I've (added|deleted|moved)/.test(m.content)) && !/^(?:add task|new task|task:|remember|forget|complete|done with|search|find|what|how|why|who|when|where)\b/i.test(t);   // "add the cards for those two dates" right after talking about the calendar
  if (!CAL_VERB.test(t) || !(explicit || followUp) || t.length > 600 || /^(?:what|how|why|who|when|where|which|is|are|do you|does|did)\b/i.test(t)) return null;
  if (!ready(db, 'chat')) return explicit ? 'I need a model connected to read that. Add it on the Calendar page instead.' : null;
  const cp = chicagoParts(now); const r = await complete(db, { task: 'chat', ref: 'calendar-add', system: SPEC + ` Right now it is ${new Date(now).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${cp.y}-${String(cp.m).padStart(2, '0')}-${String(cp.d).padStart(2, '0')}).`, messages: [...(recent.length ? [{ role: 'user' as const, content: `<data kind="recent conversation, oldest first">\n${recent.map((m) => `${m.role === 'luke' ? 'Luke' : 'Jarvis'}: ${m.content.replace(/[<>]/g, ' ')}`).join('\n')}\n</data>\nThe request below is Luke's newest message. Use the conversation only to understand which dates and what he means.` }, { role: 'assistant' as const, content: 'Understood.' }] : []), { role: 'user', content: t }], channel: 'dashboard' }, now);
  if (!r.ok) return followUp ? null : 'I could not read that just now. Try the Calendar page, or ask again in a moment.';
  let j: any; try { j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch { return followUp ? null : 'I could not work out the dates. Tell me the day, like “put dentist on my calendar Friday at 3pm”.'; }
  if (j.error) return followUp ? null : String(j.error).slice(0, 200);
  const at = (v: unknown) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/); return m ? chicagoInstant(+m[1], +m[2], +m[3], +m[4], +m[5]) : NaN; };
  const op = j.op ?? (Array.isArray(j.events) || j.title ? 'add' : 'none');
  if (op === 'none') return null;
  if (op === 'delete') { const phrase = String(j.title ?? '').slice(0, 160).trim(); if (phrase.length < 2) return 'Which event should I delete? Tell me its name.'; return deleteCore(db, phrase, { all: !!j.all || ALL.test(t), mentionsCal: true }, request, now, direct); }
  if (op === 'move') {
    const phrase = String(j.title ?? '').slice(0, 160).trim(), start = at(j.start); const words = norm(phrase).split(' ').filter((w) => w && !STOP.has(w)); if (!words.length || !Number.isFinite(start)) return 'Which event should I move, and to when? For example “move the dentist to Friday at 3pm”.';
    const hit = upcoming(db, now - 30 * 24 * H, now + 400 * 24 * H).filter((e) => !e.allDay && matches(e.title, words)); const uids = new Set(hit.map((e) => `${e.calendar}|${e.uid}`));
    if (!hit.length) return `I couldn't find an upcoming event matching “${phrase}” in your calendar copy.`; if (uids.size > 1) return `I found ${uids.size} events that match: ${[...new Set(hit.map((e) => e.title))].slice(0, 4).map((x) => `“${x}”`).join('; ')}. Tell me which one, with its full name.`;
    try { const mv = requestMove(db, { uid: hit[0].uid, calendar: hit[0].calendar, newStart: start }, request, now); const heads = headsUp(mv.check);
      return (direct ? `Done. I've moved “${hit[0].title}” to ${fmt(start)}. It will update in Apple Calendar within a minute.` : `I've asked for your approval to move “${hit[0].title}” to ${fmt(start)}. Nothing moves until you approve it on the Approvals page.`) + (heads.length ? ` Heads up: ${heads.join(' ')}` : '');
    } catch (err) { return (err as Error).message; }
  }
  const list: any[] = Array.isArray(j.events) ? j.events.slice(0, 10) : j.title ? [j] : []; if (!list.length) return followUp ? null : 'I could not work out what to add. Tell me the day and what it is.';
  const done: string[] = [], notes: string[] = [];
  for (const e of list) {
    const start = at(e.start), end = e.end ? at(e.end) : start + H; if (!Number.isFinite(start) || !Number.isFinite(end)) { notes.push(`I couldn't read the date for “${String(e.title ?? '').slice(0, 60)}”.`); continue; }
    try { const out = await requestCreate(db, { title: String(e.title ?? '').slice(0, 120), start, end, location: String(e.location ?? '').slice(0, 160) }, request, now); const heads = headsUp(out.check).filter((x) => !/very early or late/.test(x));
      done.push(`“${out.check.event.title}”, ${fmt(start)}${heads.length ? ` (heads up: ${heads.join(' ')})` : ''}`);
    } catch (err) { notes.push((err as Error).message); if (/Choose which calendar/.test((err as Error).message)) break; }
  }
  const lead = !done.length ? '' : direct ? `Done. I've added ${done.length === 1 ? done[0] : `${done.length} events to your ${target(db)} calendar:\n- ${done.join('\n- ')}`}${done.length === 1 ? ` to your ${target(db)} calendar` : ''}. They'll appear in Apple Calendar within a minute.` : `I've asked for your approval to add ${done.length === 1 ? done[0] : `${done.length} events:\n- ${done.join('\n- ')}`}. Nothing is added until you approve it on the Approvals page.`;
  return [lead, ...notes].filter(Boolean).join('\n');
}

// ---- applying approved changes ----
export function queue(db: DB, kind: 'create' | 'move' | 'delete', payload: unknown, approvalId?: string, now = Date.now()) {
  const p = kind === 'create' ? approvalPayload.parse(payload) : kind === 'move' ? movePayload.parse(payload) : deletePayload.parse(payload); const oid = id();
  db.prepare('INSERT INTO calendar_outbox(id,kind,payload,approval_id,created_at) VALUES(?,?,?,?,?)').run(oid, kind, JSON.stringify(p), approvalId ?? null, now); audit(db, 'system', 'calendar.queued', oid, { kind }); publish({ type: 'calendar' }); return oid;
}
const CREATE_JS = `function run(argv){ const a = JSON.parse(argv[0]); const C = Application('Calendar'); const cal = C.calendars.byName(a.calendar); const ev = C.Event({ summary: a.title, startDate: new Date(a.start), endDate: new Date(a.end), location: a.location || '', description: a.notes || '' }); cal.events.push(ev); return JSON.stringify({ ok: true }); }`;
const MOVE_JS = `function run(argv){ const a = JSON.parse(argv[0]); const C = Application('Calendar'); const found = C.calendars.byName(a.calendar).events.whose({ uid: a.uid })(); if (found.length !== 1) throw new Error('expected exactly one matching event, found ' + found.length); found[0].startDate = new Date(a.newStart); found[0].endDate = new Date(a.newEnd); return JSON.stringify({ ok: true }); }`;
const DELETE_JS = `function run(argv){ const a = JSON.parse(argv[0]); const C = Application('Calendar'); const found = C.calendars.byName(a.calendar).events.whose({ uid: a.uid })(); if (found.length !== 1) throw new Error('expected exactly one matching event, found ' + found.length); C.delete(found[0]); return JSON.stringify({ ok: true }); }`;
let draining = false;
/** Applies queued changes on the Mac. Safe to call often; does nothing when the queue is empty. Never throws. */
export async function drain(db: DB, now = Date.now()): Promise<number> {
  if (draining || isPaused(db)) return 0; draining = true; let done = 0;
  try {
    for (const o of db.prepare("SELECT * FROM calendar_outbox WHERE status='queued' AND attempts<3 ORDER BY created_at").all() as any[]) {
      db.prepare('UPDATE calendar_outbox SET attempts=attempts+1 WHERE id=?').run(o.id); const p = JSON.parse(o.payload);
      try {
        await getRunner()(o.kind === 'create' ? CREATE_JS : o.kind === 'delete' ? DELETE_JS : MOVE_JS, [JSON.stringify(o.kind === 'create' ? { calendar: p.calendar, title: p.title, start: p.start, end: p.end, location: p.location, notes: p.notes } : p)], 60_000);
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
