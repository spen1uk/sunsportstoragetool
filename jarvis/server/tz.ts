export const TZ = 'America/Chicago';

export type Parts = { y: number; m: number; d: number; hour: number; minute: number; dow: number }; // dow: 0=Sun..6=Sat
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function chicagoParts(t: number | Date): Parts {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour, minute: +p.minute, dow: DOW[p.weekday] };
}

/**
 * Instant (ms) of a Chicago wall-clock time. DST-safe: a time skipped by spring-forward maps to the
 * first valid instant after the gap; an ambiguous fall-back time maps to its first occurrence.
 */
export function chicagoInstant(y: number, m: number, d: number, hour = 0, minute = 0): number {
  const want = Date.UTC(y, m - 1, d, hour, minute);
  const asWall = (t: number) => { const p = chicagoParts(t); return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute); };
  let t = want - asWall(want) + want; // first guess using offset at `want`
  for (let i = 0; i < 3; i++) { const diff = want - asWall(t); if (diff === 0) break; t += diff; }
  // Skipped local time: asWall(t) !== want. Move forward to the first real instant at/after the gap.
  if (asWall(t) < want) t += (want - asWall(t));
  // Ambiguous: prefer the earliest instant that renders as `want`.
  const earlier = t - 3600_000; if (asWall(earlier) === want) t = earlier;
  return t;
}

/** Add whole calendar days in Chicago local time (keeps the wall-clock time across DST). */
export function addDays(y: number, m: number, d: number, n: number) {
  const x = new Date(Date.UTC(y, m - 1, d + n)); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), dow: x.getUTCDay() };
}
export const MIN = 60_000;
