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
