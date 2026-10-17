import { handoffFor, handoffSpeech } from './handoff.ts';
import { greetingBit as weatherBit } from './weather.ts';
import type { DB } from './db.ts';
import { greeting as timeGreeting, statusLine } from '../web/src/greeting.ts';
import { getPersona } from './persona.ts';
import { upcoming, calendarConnected, syncState } from './calendar.ts';
import { contactNow } from './today.ts';
import { healthIssues } from './health.ts';
import { isPaused } from './pause.ts';

/**
 * What Jarvis says when a device wakes up, and the one-glance summary for driving mode. Built ONLY from real records (no model call, no cost, instant),
 * so it can never invent an appointment, a result or the weather. Two profiles:
 *   glance (driving): at most two short sentences, no clutter;   full (parked / phone / desk): a little more context.
 * Things Jarvis has no data for (e.g. weather) are simply not mentioned.
 */
export type Profile = 'glance' | 'full';
export type Card = { kind: 'urgent' | 'appointment' | 'overnight' | 'info'; text: string; link?: string };
export type CoreStateName = 'paused' | 'urgent' | 'blocked' | 'working' | 'idle';
const one = (db: DB, sql: string, ...p: (string | number)[]) => (db.prepare(sql).get(...p) as any).c as number;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const num = (c: number, one: string, many = one + 's') => `${c} ${c === 1 ? one : many}`;
const timeOf = (t: number) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });

export function counts(db: DB) {
  return {
    approvals: one(db, "SELECT COUNT(*) c FROM approvals WHERE status='pending'"), review: one(db, "SELECT COUNT(*) c FROM artifacts WHERE status='in_review'"),
    blocked: one(db, "SELECT COUNT(*) c FROM tasks WHERE state IN ('waiting_input','failed')"), running: one(db, "SELECT COUNT(*) c FROM tasks WHERE state IN ('running','verifying')"),
    urgent: one(db, "SELECT COUNT(*) c FROM approvals WHERE status='pending' AND risk='high'") + one(db, "SELECT COUNT(*) c FROM notifications WHERE state IN ('pending','delivered') AND urgency!='routine'"),
  };
}
export function coreState(db: DB): CoreStateName { const c = counts(db); return isPaused(db) ? 'paused' : c.urgent > 0 ? 'urgent' : c.running > 0 ? 'working' : c.approvals > 0 || c.blocked > 0 ? 'blocked' : 'idle'; }

/** Next timed appointment that starts within `hours` (and hasn't ended). */
function nextAppointment(db: DB, now: number, hours: number) {
  if (!calendarConnected(db, now)) return null;
  return upcoming(db, now, now + hours * 3_600_000).find((e) => !e.allDay && e.end > now) ?? null;
}

export function buildGreeting(db: DB, o: { profile?: Profile; now?: number; lastSeen?: number | null; channel?: string } = {}) {
  const now = o.now ?? Date.now(), profile = o.profile ?? 'full', who = getPersona(db).addressAs, c = counts(db);
  const hello = timeGreeting(new Date(now), who), cards: Card[] = [], bits: string[] = [];
  const away = o.lastSeen ? now - o.lastSeen : null;
  // what needs him, in priority order
  if (isPaused(db)) bits.push('Jarvis is paused, so nothing new will run');
  else {
    if (c.urgent) { bits.push(`${num(c.urgent, 'urgent item')} need${c.urgent === 1 ? 's' : ''} your attention`); cards.push({ kind: 'urgent', text: `${num(c.urgent, 'urgent item')}`, link: '#/approvals' }); }
    else if (c.approvals) { bits.push(`${num(c.approvals, 'decision')} ${c.approvals === 1 ? 'is' : 'are'} waiting for you`); cards.push({ kind: 'info', text: `${num(c.approvals, 'decision')} waiting`, link: '#/approvals' }); }
  }
  const appt = nextAppointment(db, now, profile === 'glance' ? 3 : 12);
  if (appt) { const mins = Math.round((appt.start - now) / 60_000), when = mins <= 0 ? 'now' : mins < 60 ? `in ${mins} minutes` : `at ${timeOf(appt.start)}`; const t = clip(appt.title, profile === 'glance' ? 40 : 80); bits.push(`next up: ${t} ${when}`); cards.push({ kind: 'appointment', text: `${timeOf(appt.start)} ${appt.title}`, link: '#/calendar' }); }
  if (profile === 'full' || !bits.length) {
    if (c.review) { bits.push(`${num(c.review, 'draft')} ${c.review === 1 ? 'is' : 'are'} ready for your review`); cards.push({ kind: 'overnight', text: `${num(c.review, 'draft')} ready to review`, link: '#/review' }); }
    const done = one(db, "SELECT COUNT(*) c FROM tasks WHERE state='completed' AND kind IN ('research','revision') AND is_demo=0 AND updated_at>=?", new Date(now - (away ?? 12 * 3_600_000)).toISOString());
    if (done && profile === 'full') cards.push({ kind: 'overnight', text: `${num(done, 'job')} finished while you were away` });
    const contact = contactNow(db, now); if (profile === 'full' && contact.mode !== 'normal') bits.push(`you are in ${contact.mode} mode`);
    if (profile === 'full') for (const h of healthIssues(db, now).filter((i) => i.level === 'urgent').slice(0, 1)) { bits.push(h.text.replace(/\.$/, '')); cards.push({ kind: 'urgent', text: h.text, link: h.link }); }
  }
  if (profile === 'full') { const w = weatherBit(db, now); if (w) bits.push(w); }
  const hf = profile === 'full' && o.channel ? handoffFor(db, o.channel, now) : null;
  if (hf) { bits.push(handoffSpeech(hf)); cards.push({ kind: 'info', text: `Continue from ${hf.fromName}: ${hf.lastAsk}` }); }
  const limit = profile === 'glance' ? 2 : 4, picked = bits.slice(0, limit);
  const head = away !== null && away < 20 * 60_000 ? `Welcome back, ${who}.` : hello;
  const body = picked.length ? picked.map((b, i) => (i === 0 ? b[0].toUpperCase() + b.slice(1) : b)).join('. ') + '.' : 'All systems are operational. Nothing needs you right now.';
  const calNote = calendarConnected(db, now) && syncState(db, 'calendar', now).status === 'stale' ? 'calendar copy may be out of date' : null;
  return { profile, speak: `${head} ${body}`.replace(/\s+/g, ' ').trim(), cards: cards.slice(0, profile === 'glance' ? 2 : 6), core: coreState(db), caveats: calNote ? [calNote] : [], generatedAt: now };
}

/** The tiny summary for driving mode: two short lines and the numbers, nothing else. */
export function buildGlance(db: DB, now = Date.now()) {
  const c = counts(db), appt = nextAppointment(db, now, 3);
  const line1 = isPaused(db) ? 'Paused' : c.urgent ? `${num(c.urgent, 'urgent item')}` : c.approvals ? `${num(c.approvals, 'decision')} waiting` : 'All quiet';
  const line2 = appt ? clip(`${timeOf(appt.start)} ${appt.title}`, 40) : c.review ? `${num(c.review, 'draft')} to review` : c.running ? `${num(c.running, 'job')} running` : '';
  return { line1, line2, core: coreState(db), counts: { approvals: c.approvals, urgent: c.urgent, running: c.running }, generatedAt: now };
}

/** Make a reply fit for a speaker: no markdown, links, bullets or emoji; whole sentences; capped length. */
export function toSpeech(text: string, max = 600): string {
  let t = text.replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/[*_`#>~]+/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\[(\d{1,3})\]/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s*\n+\s*/g, '. ').replace(/\.\s*\./g, '.').replace(/\s+/g, ' ').trim();
  if (t.length > max) { const cut = t.slice(0, max), i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! ')); t = i > 120 ? cut.slice(0, i + 1) : cut.trimEnd() + '…'; }
  return t;
}
export { statusLine };
