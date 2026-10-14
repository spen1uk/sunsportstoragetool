/**
 * Expands a repeating Apple Calendar event (its iCalendar RRULE text) into the occurrences that fall inside a window.
 * Times keep the same wall-clock hour in the Mac's local time zone across daylight-saving changes.
 * Supported: DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with ordinals like 1MO / -1FR), BYMONTHDAY, excluded dates.
 * Anything it cannot read is reported as unsupported rather than guessed.
 */
export type Master = { start: number; end: number; rule: string; exclude: number[] };
export type Rule = { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'; interval: number; count?: number; until?: number; byday: { n: number; d: number }[]; bymonthday: number[] };
const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseUntil(v: string): number | undefined {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/); if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (!m[4]) return new Date(y, mo, d, 23, 59, 59).getTime();
  return m[7] ? Date.UTC(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6])) : new Date(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}
export function parseRule(text: string): Rule | null {
  const kv = new Map<string, string>();
  for (const part of text.replace(/^RRULE:/i, '').split(';')) { const i = part.indexOf('='); if (i > 0) kv.set(part.slice(0, i).trim().toUpperCase(), part.slice(i + 1).trim()); }
  const freq = kv.get('FREQ'); if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const byday: { n: number; d: number }[] = [], seen = new Set<string>();
  for (const t of (kv.get('BYDAY') ?? '').split(',').filter(Boolean).slice(0, 40)) { const m = t.trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); if (!m) return null; const k = `${m[1] ?? ''}${m[2]}`; if (seen.has(k)) continue; seen.add(k); byday.push({ n: m[1] ? Number(m[1]) : 0, d: DOW[m[2]] }); }   // duplicates are ignored: a hostile rule must not multiply its own output
  if (byday.length > 14) return null;
  const bymonthday = (kv.get('BYMONTHDAY') ?? '').split(',').filter(Boolean).map(Number); if (bymonthday.some((n) => !Number.isInteger(n) || n === 0 || Math.abs(n) > 31)) return null;
  const interval = Math.max(1, Number(kv.get('INTERVAL') ?? 1) || 1);
  const count = kv.has('COUNT') ? Number(kv.get('COUNT')) : undefined;
  return { freq, interval, count: count && count > 0 ? count : undefined, until: kv.has('UNTIL') ? parseUntil(kv.get('UNTIL')!) : undefined, byday, bymonthday };
}

const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate();
/** The date (day-of-month) of the nth `dow` in a month; n<0 counts from the end. null if it does not exist. */
function nthWeekday(y: number, m: number, dow: number, n: number): number | null {
  const first = new Date(y, m, 1).getDay(), dim = daysIn(y, m);
  if (n > 0) { const d = 1 + ((dow - first + 7) % 7) + (n - 1) * 7; return d <= dim ? d : null; }
  const last = new Date(y, m, dim).getDay(), d = dim - ((last - dow + 7) % 7) + (n + 1) * 7; return d >= 1 ? d : null;
}

const MAX_STEPS = 12_000, MAX_OCCURRENCES = 400;
export function expand(master: Master, from: number, to: number): { start: number; end: number }[] | 'unsupported' {
  const rule = parseRule(master.rule); if (!rule) return 'unsupported';
  const dur = Math.max(0, master.end - master.start), s0 = new Date(master.start);
  const H = s0.getHours(), Mi = s0.getMinutes(), S = s0.getSeconds();
  const out: { start: number; end: number }[] = []; let n = 0, steps = 0;
  const excluded = new Set(master.exclude.map((t) => Math.round(t / 60_000)));
  const at = (y: number, m: number, d: number) => new Date(y, m, d, H, Mi, S).getTime();
  const take = (t: number): boolean => {          // returns false when the series is over
    if (t < master.start) return true;
    if (rule.until !== undefined && t > rule.until) return false;
    n++; if (rule.count !== undefined && n > rule.count) return false;
    if (t > to) return false;
    if (!excluded.has(Math.round(t / 60_000)) && t + dur >= from) { out.push({ start: t, end: t + dur }); if (out.length >= MAX_OCCURRENCES) return false; }
    return true;
  };
  const Y = s0.getFullYear(), M = s0.getMonth(), D = s0.getDate();
  if (rule.freq === 'DAILY') {
    for (let k = 0; steps++ < MAX_STEPS; k += rule.interval) if (!take(at(Y, M, D + k))) break;
  } else if (rule.freq === 'WEEKLY') {
    const days = (rule.byday.length ? rule.byday.map((b) => b.d) : [s0.getDay()]).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));   // Monday-first
    const mondayOffset = (s0.getDay() + 6) % 7;
    outer: for (let w = 0; steps++ < MAX_STEPS; w += rule.interval) for (const dw of days) { if (!take(at(Y, M, D - mondayOffset + w * 7 + ((dw + 6) % 7)))) break outer; }
  } else if (rule.freq === 'MONTHLY') {
    outer2: for (let k = 0; steps++ < MAX_STEPS; k += rule.interval) {
      const y = Y + Math.floor((M + k) / 12), m = (M + k) % 12, dim = daysIn(y, m), days = new Set<number>();
      if (rule.byday.length) for (const b of rule.byday) { if (b.n) { const d = nthWeekday(y, m, b.d, b.n); if (d) days.add(d); } else for (let d = 1; d <= dim; d++) if (new Date(y, m, d).getDay() === b.d) days.add(d); }
      else if (rule.bymonthday.length) for (const d of rule.bymonthday) { const dd = d > 0 ? d : dim + 1 + d; if (dd >= 1 && dd <= dim) days.add(dd); }
      else if (D <= dim) days.add(D);
      for (const d of [...days].sort((a, b) => a - b)) if (!take(at(y, m, d))) break outer2;
    }
  } else {
    for (let k = 0; steps++ < MAX_STEPS; k += rule.interval) { if (M === 1 && D === 29 && daysIn(Y + k, 1) < 29) continue; if (!take(at(Y + k, M, D))) break; }
  }
  return out;
}
