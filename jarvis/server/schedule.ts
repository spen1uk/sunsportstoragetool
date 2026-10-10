import { chicagoInstant, chicagoParts, addDays, MIN } from './tz.ts';

export const BUFFER = 15 * MIN;

/** Daily touch-points in Chicago local time. Briefing 8:00, reminders 12/16/20, recap 22:00; collection 7:30 and 23:05. */
export const DAILY = { collectMorning: [7, 30], briefing: [8, 0], noon: [12, 0], afternoon: [16, 0], evening: [20, 0], recap: [22, 0], collectEvening: [23, 5] } as const;
export function dailyInstants(y: number, m: number, d: number) {
  return Object.fromEntries(Object.entries(DAILY).map(([k, [h, mi]]) => [k, chicagoInstant(y, m, d, h, mi)])) as Record<keyof typeof DAILY, number>;
}

export type Interval = { start: number; end: number };
export type CalEvent = Interval & { id: string; owner: 'jarvis' | 'external'; taskId?: string; title?: string };
export type PlanTask = { id: string; minutes: number; priority: number; deadline?: number; completed?: boolean };

/** Work windows: Mon–Fri 08:00–18:00 Chicago. Weekends are NOT auto-scheduled (not authorized). */
export function workWindows(from: number, days: number): Interval[] {
  const p = chicagoParts(from); const out: Interval[] = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(p.y, p.m, p.d, i);
    if (day.dow === 0 || day.dow === 6) continue;
    out.push({ start: chicagoInstant(day.y, day.m, day.d, 8, 0), end: chicagoInstant(day.y, day.m, day.d, 18, 0) });
  }
  return out;
}

function subtract(windows: Interval[], busy: Interval[]): Interval[] {
  let free = windows.map((w) => ({ ...w }));
  for (const b of [...busy].sort((x, y) => x.start - y.start)) {
    const next: Interval[] = [];
    for (const f of free) {
      if (b.end <= f.start || b.start >= f.end) { next.push(f); continue; }
      if (b.start > f.start) next.push({ start: f.start, end: b.start });
      if (b.end < f.end) next.push({ start: b.end, end: f.end });
    }
    free = next;
  }
  return free.filter((f) => f.end - f.start > 0);
}

export type Placement = { taskId: string; start: number; end: number };
export type Plan = {
  placements: Placement[]; unscheduled: string[];
  deadlineRisk: { taskId: string; reason: 'unscheduled' | 'ends-after-deadline' }[];
  overcapacity: boolean;
};

/**
 * Place tasks into open work slots, leaving a 15-minute buffer around every existing commitment
 * (external events AND other Jarvis blocks). Order: deadline first, then priority (1 = highest).
 * `now` blocks scheduling in the past. Protected non-work times (family, church, meals) arrive as busy intervals.
 */
export function planTasks(tasks: PlanTask[], busy: Interval[], now: number, horizonDays = 14): Plan {
  const windows = workWindows(now, horizonDays).map((w) => ({ start: Math.max(w.start, now), end: w.end })).filter((w) => w.end > w.start);
  let free = subtract(windows, busy.map((b) => ({ start: b.start - BUFFER, end: b.end + BUFFER })));
  const order = [...tasks].filter((t) => !t.completed).sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.priority - b.priority);
  const placements: Placement[] = [], unscheduled: string[] = [], risk: Plan['deadlineRisk'] = [];
  for (const t of order) {
    const need = t.minutes * MIN;
    const slot = free.find((f) => f.end - f.start >= need);
    if (!slot) { unscheduled.push(t.id); if (t.deadline) risk.push({ taskId: t.id, reason: 'unscheduled' }); continue; }
    const p = { taskId: t.id, start: slot.start, end: slot.start + need };
    placements.push(p);
    free = subtract(free, [{ start: p.start - BUFFER, end: p.end + BUFFER }]);
    if (t.deadline && p.end > t.deadline) risk.push({ taskId: t.id, reason: 'ends-after-deadline' });
  }
  return { placements, unscheduled, deadlineRisk: risk, overcapacity: unscheduled.length > 0 };
}

export type Op = { op: 'create' | 'move' | 'delete'; taskId: string; eventId?: string; start?: number; end?: number; reason: string };

/**
 * Reconcile Jarvis-owned calendar blocks with tasks. Touches ONLY events with owner === 'jarvis'.
 *  - completed/removed task → delete its future Jarvis blocks (and reminders follow separately)
 *  - block already over but task not complete → block is NOT proof of completion; task is re-planned
 *  - external events are never moved, only avoided
 */
export function reconcile(tasks: PlanTask[], events: CalEvent[], now: number, horizonDays = 14): { ops: Op[]; plan: Plan } {
  const ops: Op[] = [];
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const external = events.filter((e) => e.owner === 'external');
  const jarvis = events.filter((e) => e.owner === 'jarvis');
  const keep: CalEvent[] = [];
  const needPlan = new Set<string>();
  for (const e of jarvis) {
    const t = e.taskId ? byTask.get(e.taskId) : undefined;
    if (!t || t.completed) { if (e.end > now) ops.push({ op: 'delete', taskId: e.taskId ?? '', eventId: e.id, reason: t?.completed ? 'task completed' : 'task removed' }); continue; }
    const clash = external.some((x) => x.start < e.end + BUFFER && x.end > e.start - BUFFER);
    if (e.end <= now) { needPlan.add(t.id); ops.push({ op: 'delete', taskId: t.id, eventId: e.id, reason: 'block ended but task is not complete (not marking done)' }); }
    else if (clash) { needPlan.add(t.id); ops.push({ op: 'delete', taskId: t.id, eventId: e.id, reason: 'conflicts with an external event' }); }
    else keep.push(e);
  }
  const scheduledTasks = new Set(keep.map((e) => e.taskId));
  for (const t of tasks) if (!t.completed && !scheduledTasks.has(t.id)) needPlan.add(t.id);
  const plan = planTasks(tasks.filter((t) => needPlan.has(t.id)), [...external, ...keep], now, horizonDays);
  for (const p of plan.placements) ops.push({ op: 'create', taskId: p.taskId, start: p.start, end: p.end, reason: 'scheduled into open work slot' });
  return { ops, plan };
}
