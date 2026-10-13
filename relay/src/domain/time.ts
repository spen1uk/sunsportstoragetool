/** Timezone helpers with explicit DST semantics (no external deps). */
export function assertTimezone(tz: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new RangeError(`unknown timezone: ${tz}`); }
}

function offsetMs(utcMs: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

export interface Zoned { utc: Date; dst: 'none' | 'gap_shifted_forward' | 'ambiguous_first_occurrence' }

/**
 * Convert a wall-clock time ('YYYY-MM-DDTHH:mm') in `tz` to an instant.
 *  - Non-existent local time (spring-forward gap): moved FORWARD to the first valid instant after the gap.
 *  - Ambiguous local time (fall-back overlap): the FIRST occurrence is used.
 */
export function zonedToUtc(local: string, tz: string): Zoned {
  assertTimezone(tz);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new RangeError('local time must look like YYYY-MM-DDTHH:mm');
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const before = offsetMs(guess - 36 * 3600_000, tz), after = offsetMs(guess + 36 * 3600_000, tz);
  const valid = [...new Set([before, after])].map((off) => guess - off).filter((c) => offsetMs(c, tz) === guess - c).sort((a, b) => a - b);
  if (valid.length === 2) return { utc: new Date(valid[0]), dst: 'ambiguous_first_occurrence' };
  if (valid.length === 1) return { utc: new Date(valid[0]), dst: 'none' };
  return { utc: new Date(guess - before), dst: 'gap_shifted_forward' };
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number; date: string }
/** Wall-clock components of an instant in `tz` (weekday 0 = Sunday). */
export function localParts(d: Date, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday: wd, date: `${p.year}-${p.month}-${p.day}` };
}
const pad = (n: number) => String(n).padStart(2, '0');
/** Calendar-day arithmetic on a YYYY-MM-DD string (no timezone involved). */
export function addDays(date: string, n: number): string { const [y, m, d] = date.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
export const weekdayOf = (date: string) => new Date(date + 'T00:00:00Z').getUTCDay();

/** Quiet hours are a wall-clock window (start..end, may wrap midnight). Returns the instant they end if `now` is inside, else null. DST-safe. */
export function quietHoursEnd(now: Date, tz: string, startHour: number, endHour: number): Date | null {
  if (startHour === endHour) return null;
  const lp = localParts(now, tz);
  const inQuiet = startHour > endHour ? lp.hour >= startHour || lp.hour < endHour : lp.hour >= startHour && lp.hour < endHour;
  if (!inQuiet) return null;
  const endDate = startHour > endHour && lp.hour >= startHour ? addDays(lp.date, 1) : lp.date;
  return zonedToUtc(`${endDate}T${pad(endHour)}:00`, tz).utc;
}
