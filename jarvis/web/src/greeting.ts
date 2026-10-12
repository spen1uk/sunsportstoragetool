/** Pure helpers for the Command Center's opening lines (no model call: these are free and always accurate). */
export const chicagoHour = (d: Date = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(d));

export function greeting(d: Date = new Date(), addressAs = 'sir'): string {
  const h = chicagoHour(d), who = addressAs.trim() || 'sir';
  if (h >= 5 && h < 12) return `Good morning, ${who}.`;
  if (h >= 12 && h < 17) return `Good afternoon, ${who}.`;
  if (h >= 17 && h < 22) return `Good evening, ${who}.`;
  return `Working late, ${who}?`;
}

export type Counts = { approvals: number; review: number; blocked: number; running: number; paused: boolean };
const n = (c: number, one: string, many = one + 's') => `${c} ${c === 1 ? one : many}`;

/** One honest sentence about what needs Luke, built only from real counts. */
export function statusLine(c: Counts): string {
  if (c.paused) return 'Jarvis is paused: no new automated work will start.';
  const parts = [
    c.approvals ? `${n(c.approvals, 'decision')} waiting for you` : '', c.review ? `${n(c.review, 'draft')} ready to review` : '',
    c.blocked ? `${n(c.blocked, 'task')} stuck` : '', c.running ? `${n(c.running, 'job')} running` : '',
  ].filter(Boolean);
  if (!parts.length) return 'All quiet. Nothing needs you right now.';
  return (parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`) + '.';
}
