import { chicagoParts } from './tz.ts';

export type Channel = 'desktop' | 'text' | 'call';
export type Mode = 'normal' | 'church' | 'unavailable' | 'family' | 'meal' | 'away' | 'personal';
export type Urgency = 'routine' | 'urgent' | 'emergency';
export type Ctx = { mode?: Mode; urgency?: Urgency; atComputer?: boolean };
export type Decision = { hold: boolean; channels: Channel[]; preferred: Channel | null; reason: string };

const hm = (h: number, m = 0) => h * 60 + m;
const hold = (reason: string): Decision => ({ hold: true, channels: [], preferred: null, reason });
const allow = (channels: Channel[], reason: string): Decision => ({ hold: false, channels, preferred: channels[0] ?? null, reason });

/**
 * Which channels may be used right now? Pure function of the instant + mode, so every rule is testable.
 *
 * Rules (handoff §6): contact 6:00–23:00 Central; gym/wake 5:40–8:00 text only (routine contact starts 6:00);
 * personal/family text only; meals welcome calls; church/unavailable silent with NO emergency override;
 * "out for a bit" pauses interruptions; sleep holds routine contact, but a major overnight emergency may call.
 */
export function decideContact(at: number | Date, ctx: Ctx = {}): Decision {
  const { hour, minute } = chicagoParts(at);
  const t = hm(hour, minute), mode = ctx.mode ?? 'normal', urg = ctx.urgency ?? 'routine';

  // Church / unavailable: silent, no override (not granted by Luke).
  if (mode === 'church' || mode === 'unavailable') return hold(`${mode}: interruptions held, no emergency override granted`);
  // "I'm out for a bit": pause all interruptions until he says he's back.
  if (mode === 'away') return hold('out for a bit: interruptions paused until "I\'m back"');

  const asleep = t < hm(6) || t >= hm(23);
  if (asleep) {
    if (urg === 'emergency') return allow(['call', 'text'], 'major overnight emergency may call despite sleep hours');
    return hold('sleep hours: routine contact held until 6:00 a.m.');
  }
  // 6:00–8:00 gym/wake routine: text only.
  if (t < hm(8)) return allow(['text'], 'gym/wake routine (5:40–8:00): text only');

  if (mode === 'family') return allow(['text'], 'family time: text only');
  if (mode === 'personal') return allow(['text'], 'personal hours: routine contact by text');
  if (mode === 'meal') return allow(['call', 'text', 'desktop'], 'meal: calls and live conversation welcome');

  // Normal: at the computer → desktop first; away → text, and a call only when very urgent.
  if (ctx.atComputer !== false) return allow(urg === 'routine' ? ['desktop', 'text'] : ['desktop', 'text', 'call'], 'at computer: desktop first');
  return allow(urg === 'routine' ? ['text'] : ['call', 'text'], urg === 'routine' ? 'away from computer: text' : 'away and urgent: call allowed');
}

/** Is the 5:40–8:00 gym/wake window protected from work scheduling at this instant? */
export function inGymWindow(at: number | Date) {
  const p = chicagoParts(at); const t = hm(p.hour, p.minute); return t >= hm(5, 40) && t < hm(8);
}

// ---------- escalation ----------
export type Attempt = { at: number; channel: Channel };
export type Escalation = { kind: 'attention' | 'urgent'; startedAt: number; attempts: Attempt[]; acknowledged: boolean };
export type Step = { action: 'send'; channel: Channel; reason: string } | { action: 'wait'; until: number; reason: string } | { action: 'stop'; reason: string };
const FIVE_MIN = 5 * 60_000;

/**
 * Next step for an unanswered request. Acknowledgment/reply cancels everything.
 * attention: desktop notification now → text after 5 min if still unacknowledged.
 * urgent: (call, then) text immediately; retry the call ONCE after 5 min; never more.
 * Each step is re-checked against the contact rules at the time it would fire.
 */
export function nextStep(e: Escalation, now: number, ctx: Ctx = {}): Step {
  if (e.acknowledged) return { action: 'stop', reason: 'acknowledged' };
  const sent = (c: Channel) => e.attempts.filter((a) => a.channel === c);
  const d = decideContact(now, { ...ctx, urgency: e.kind === 'urgent' ? 'urgent' : ctx.urgency ?? 'routine' });
  if (d.hold) return { action: 'wait', until: now + FIVE_MIN, reason: d.reason };
  const can = (c: Channel) => d.channels.includes(c);

  if (e.kind === 'attention') {
    if (sent('desktop').length === 0 && can('desktop')) return { action: 'send', channel: 'desktop', reason: 'desktop notification first' };
    const first = e.attempts[0]?.at ?? e.startedAt;
    if (sent('text').length === 0) {
      if (now < first + FIVE_MIN) return { action: 'wait', until: first + FIVE_MIN, reason: 'waiting 5 minutes before texting' };
      return can('text') ? { action: 'send', channel: 'text', reason: 'still unacknowledged after 5 minutes' } : { action: 'wait', until: now + FIVE_MIN, reason: 'text not allowed right now' };
    }
    return { action: 'stop', reason: 'escalation complete' };
  }
  // urgent
  const calls = sent('call'), texts = sent('text');
  if (calls.length === 0 && can('call')) return { action: 'send', channel: 'call', reason: 'urgent: call' };
  if (texts.length === 0 && can('text')) return { action: 'send', channel: 'text', reason: 'unanswered urgent call: text immediately' };
  if (calls.length === 1 && can('call')) {
    const due = calls[0].at + FIVE_MIN;
    return now >= due ? { action: 'send', channel: 'call', reason: 'single retry after 5 minutes' } : { action: 'wait', until: due, reason: 'retry once after 5 minutes' };
  }
  return { action: 'stop', reason: calls.length >= 2 ? 'call already retried once; not calling again' : 'no further allowed steps' };
}

/** Group related alerts and suppress duplicates across devices: one notification per dedupe key per window. */
export function dedupe<T extends { key: string; at: number }>(items: T[], windowMs = 10 * 60_000): T[] {
  const last = new Map<string, number>(); const out: T[] = [];
  for (const it of [...items].sort((a, b) => a.at - b.at)) { const p = last.get(it.key); if (p === undefined || it.at - p >= windowMs) { out.push(it); last.set(it.key, it.at); } }
  return out;
}
