import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { addDays, localParts, weekdayOf, zonedToUtc } from './time.js';

export interface DayHours { closed: boolean; open: string | null; close: string | null }
export interface Hours { configured: boolean; tz: string; byWeekday: Map<number, DayHours>; holidays: Map<string, { name: string; closed: boolean; notice: string | null }> }

export async function loadHours(db: Db, workspaceId: string): Promise<Hours> {
  const tz = (await db.query('SELECT timezone FROM workspaces WHERE id=$1', [workspaceId])).rows[0]?.timezone ?? 'America/Chicago';
  const rows = (await db.query(`SELECT weekday, closed, to_char(open_time,'HH24:MI') AS open, to_char(close_time,'HH24:MI') AS close FROM business_hours WHERE workspace_id=$1`, [workspaceId])).rows;
  const hol = (await db.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, name, closed, notice FROM holidays WHERE workspace_id=$1`, [workspaceId])).rows;
  return { configured: rows.length > 0, tz, byWeekday: new Map(rows.map((r) => [r.weekday, { closed: r.closed, open: r.open, close: r.close }])), holidays: new Map(hol.map((h) => [h.day, { name: h.name, closed: h.closed, notice: h.notice }])) };
}

export type OpenState = { state: 'open' } | { state: 'closed'; reason: 'after_hours' | 'closed_day' | 'holiday'; holiday?: { name: string; notice: string | null } } | { state: 'unknown' };
const hhmm = (s: string) => s.slice(0, 5);

/** Whether the business is open at `at`, using wall-clock hours in the workspace timezone (DST handled by the timezone database). */
export function openState(h: Hours, at: Date): OpenState {
  if (!h.configured) return { state: 'unknown' };
  const lp = localParts(at, h.tz);
  const hol = h.holidays.get(lp.date);
  if (hol?.closed) return { state: 'closed', reason: 'holiday', holiday: { name: hol.name, notice: hol.notice } };
  const day = h.byWeekday.get(lp.weekday);
  if (!day || day.closed) return { state: 'closed', reason: 'closed_day' };
  const t = `${String(lp.hour).padStart(2, '0')}:${String(lp.minute).padStart(2, '0')}`;
  return t >= hhmm(day.open!) && t < hhmm(day.close!) ? { state: 'open' } : { state: 'closed', reason: 'after_hours' };
}

/** Earliest instant >= `from` at which the business is open (null if hours aren't configured or never open within 14 days). */
export function nextOpenAt(h: Hours, from: Date): Date | null {
  if (!h.configured) return null;
  const start = localParts(from, h.tz).date;
  for (let i = 0; i < 15; i++) {
    const date = addDays(start, i);
    if (h.holidays.get(date)?.closed) continue;
    const day = h.byWeekday.get(weekdayOf(date));
    if (!day || day.closed) continue;
    const openAt = zonedToUtc(`${date}T${hhmm(day.open!)}`, h.tz).utc, closeAt = zonedToUtc(`${date}T${hhmm(day.close!)}`, h.tz).utc;
    if (from < closeAt) return from > openAt ? from : openAt;
  }
  return null;
}

export interface AutomationSettings { auto_response_enabled: boolean; first_contact_message: string | null; after_hours_message: string | null; holiday_message: string | null; cadence_hours: number; quiet_start_hour: number; quiet_end_hour: number }
export async function loadAutomationSettings(db: Db, workspaceId: string): Promise<AutomationSettings> {
  const r = (await db.query('SELECT * FROM automation_settings WHERE workspace_id=$1', [workspaceId])).rows[0];
  return r ?? { auto_response_enabled: false, first_contact_message: null, after_hours_message: null, holiday_message: null, cadence_hours: 12, quiet_start_hour: 21, quiet_end_hour: 8 };
}
void pool;
