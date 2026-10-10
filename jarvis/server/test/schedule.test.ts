import test from 'node:test';
import assert from 'node:assert/strict';
import { chicagoInstant as ci, chicagoParts } from '../tz.ts';
import { decideContact, nextStep, dedupe, type Escalation } from '../contact.ts';
import { dailyInstants, workWindows, planTasks, reconcile, BUFFER, type CalEvent } from '../schedule.ts';

const iso = (t: number) => new Date(t).toISOString();
const H = 3600_000, M = 60_000;

test('Chicago wall-clock ↔ instant is DST-correct (spring forward Mar 8, fall back Nov 1 2026)', () => {
  assert.equal(iso(ci(2026, 3, 7, 8)), '2026-03-07T14:00:00.000Z'); // CST
  assert.equal(iso(ci(2026, 3, 8, 8)), '2026-03-08T13:00:00.000Z'); // CDT
  assert.equal(iso(ci(2026, 11, 1, 8)), '2026-11-01T14:00:00.000Z'); // CST
  assert.equal(iso(ci(2026, 10, 31, 8)), '2026-10-31T13:00:00.000Z'); // CDT
  assert.equal(iso(ci(2026, 3, 8, 2, 30)), '2026-03-08T08:30:00.000Z'); // skipped 2:30 → 3:30 CDT
  assert.equal(iso(ci(2026, 11, 1, 1, 30)), '2026-11-01T06:30:00.000Z'); // ambiguous → first (CDT)
  assert.deepEqual(chicagoParts(ci(2026, 10, 12, 9, 15)), { y: 2026, m: 10, d: 12, hour: 9, minute: 15, dow: 1 });
});

test('8:00 briefing stays at 8:00 Chicago across DST (23h / 25h apart in real time)', () => {
  const a = dailyInstants(2026, 3, 7).briefing, b = dailyInstants(2026, 3, 8).briefing;
  assert.equal(b - a, 23 * H);
  const c = dailyInstants(2026, 10, 31).briefing, d = dailyInstants(2026, 11, 1).briefing;
  assert.equal(d - c, 25 * H);
  const day = dailyInstants(2026, 10, 12);
  assert.deepEqual(['collectMorning', 'briefing', 'noon', 'afternoon', 'evening', 'recap', 'collectEvening'].map((k) => { const p = chicagoParts((day as any)[k]); return `${p.hour}:${String(p.minute).padStart(2, '0')}`; }),
    ['7:30', '8:00', '12:00', '16:00', '20:00', '22:00', '23:05']);
});

const MON = (h: number, m = 0) => ci(2026, 10, 12, h, m);
const SAT = (h: number, m = 0) => ci(2026, 10, 10, h, m);

test('contact rules: sleep, gym text-only, normal, away, personal, family, meal', () => {
  assert.equal(decideContact(MON(5, 50)).hold, true);                                  // before 6:00 routine contact
  assert.deepEqual(decideContact(MON(6, 30)).channels, ['text']);                      // gym/wake: text only
  assert.deepEqual(decideContact(MON(7, 59), { urgency: 'urgent', atComputer: false }).channels, ['text']); // even urgent: no call in gym window
  assert.equal(decideContact(MON(9)).preferred, 'desktop');                            // at computer → desktop first
  assert.deepEqual(decideContact(MON(9), { atComputer: false }).channels, ['text']);   // away, routine
  assert.equal(decideContact(MON(9), { atComputer: false, urgency: 'urgent' }).preferred, 'call');
  assert.equal(decideContact(MON(23, 30)).hold, true);                                  // after 11 pm
  assert.deepEqual(decideContact(MON(10), { mode: 'personal' }).channels, ['text']);
  assert.deepEqual(decideContact(MON(10), { mode: 'family' }).channels, ['text']);
  assert.ok(decideContact(MON(12), { mode: 'meal' }).channels.includes('call'));
  assert.ok(decideContact(SAT(11), { atComputer: false, urgency: 'urgent' }).channels.includes('call')); // weekend calls ok in hours
  assert.equal(decideContact(MON(10), { mode: 'away' }).hold, true);                   // "I'm out for a bit"
});

test('sleep: routine held, major emergency may call; church/unavailable never overridden', () => {
  assert.equal(decideContact(MON(2), { urgency: 'urgent' }).hold, true);
  assert.equal(decideContact(MON(2), { urgency: 'emergency' }).preferred, 'call');
  assert.equal(decideContact(MON(2), { urgency: 'emergency', mode: 'church' }).hold, true);
  assert.equal(decideContact(MON(10), { urgency: 'emergency', mode: 'unavailable' }).hold, true);
});

test('escalation: attention = desktop, then text after 5 min; acknowledgment cancels', () => {
  const t0 = MON(10); const e: Escalation = { kind: 'attention', startedAt: t0, attempts: [], acknowledged: false };
  assert.deepEqual(nextStep(e, t0), { action: 'send', channel: 'desktop', reason: 'desktop notification first' });
  e.attempts.push({ at: t0, channel: 'desktop' });
  assert.equal(nextStep(e, t0 + 2 * M).action, 'wait');
  assert.deepEqual([nextStep(e, t0 + 5 * M).action, (nextStep(e, t0 + 5 * M) as any).channel], ['send', 'text']);
  assert.equal(nextStep({ ...e, acknowledged: true }, t0 + 5 * M).action, 'stop');
  e.attempts.push({ at: t0 + 5 * M, channel: 'text' });
  assert.equal(nextStep(e, t0 + 20 * M).action, 'stop');
});

test('escalation: urgent = call, text immediately, ONE retry after 5 min, never a third call', () => {
  const t0 = MON(14); const e: Escalation = { kind: 'urgent', startedAt: t0, attempts: [], acknowledged: false };
  assert.equal((nextStep(e, t0, { atComputer: false }) as any).channel, 'call'); e.attempts.push({ at: t0, channel: 'call' });
  assert.equal((nextStep(e, t0 + M, { atComputer: false }) as any).channel, 'text'); e.attempts.push({ at: t0 + M, channel: 'text' });
  assert.equal(nextStep(e, t0 + 3 * M, { atComputer: false }).action, 'wait');
  assert.equal((nextStep(e, t0 + 5 * M, { atComputer: false }) as any).channel, 'call'); e.attempts.push({ at: t0 + 5 * M, channel: 'call' });
  assert.equal(nextStep(e, t0 + 30 * M, { atComputer: false }).action, 'stop');
});

test('escalation respects quiet modes at fire time (church holds the retry)', () => {
  const t0 = MON(14); const e: Escalation = { kind: 'urgent', startedAt: t0, attempts: [], acknowledged: false };
  assert.equal(nextStep(e, t0, { mode: 'church' }).action, 'wait');
});

test('duplicate notifications for the same key are grouped within the window', () => {
  const out = dedupe([{ key: 'approval:1', at: 0 }, { key: 'approval:1', at: 2 * M }, { key: 'approval:2', at: 3 * M }, { key: 'approval:1', at: 11 * M }]);
  assert.deepEqual(out.map((o) => o.at), [0, 3 * M, 11 * M]);
});

test('work windows: Mon–Fri 8–18 Chicago only; nothing auto-scheduled on weekends', () => {
  const w = workWindows(SAT(9), 7); // Sat Oct 10 → next Fri
  assert.equal(w.length, 5);
  assert.equal(iso(w[0].start), iso(ci(2026, 10, 12, 8))); assert.equal(iso(w[0].end), iso(ci(2026, 10, 12, 18)));
  assert.ok(w.every((x) => { const p = chicagoParts(x.start); return p.dow >= 1 && p.dow <= 5; }));
});

test('planner keeps 15-minute buffers, avoids existing events, orders by deadline then priority, flags risk', () => {
  const now = MON(7);
  const meeting = { start: MON(9), end: MON(10) };
  const plan = planTasks([
    { id: 'low', minutes: 60, priority: 5 },
    { id: 'due', minutes: 60, priority: 3, deadline: MON(9, 30) },
    { id: 'hi', minutes: 30, priority: 1 },
  ], [meeting], now, 1);
  const p = Object.fromEntries(plan.placements.map((x) => [x.taskId, x]));
  // Gap before the meeting is 8:00–8:45 (15-min buffer), too short for the 60-min 'due' task; the 30-min 'hi' task fits there.
  assert.equal(p.hi.start, MON(8));
  assert.equal(p.due.start, MON(10, 15));                       // first slot after meeting + buffer
  assert.deepEqual(plan.deadlineRisk, [{ taskId: 'due', reason: 'ends-after-deadline' }]);
  for (const x of plan.placements) assert.ok(x.end <= meeting.start - BUFFER || x.start >= meeting.end + BUFFER, `${x.taskId} violates buffer`);
  const sorted = [...plan.placements].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start - sorted[i - 1].end >= BUFFER, 'buffer between Jarvis blocks');
});

test('planner: overcapacity and deadline risk are reported, not hidden', () => {
  const now = MON(7);
  const plan = planTasks([{ id: 'big', minutes: 11 * 60, priority: 1, deadline: MON(18) }], [], now, 1);
  assert.equal(plan.overcapacity, true); assert.deepEqual(plan.unscheduled, ['big']);
  assert.deepEqual(plan.deadlineRisk, [{ taskId: 'big', reason: 'unscheduled' }]);
});

test('reconcile: only Jarvis-owned blocks change; ended block ≠ done; completed task frees future blocks', () => {
  const now = MON(13);
  const external: CalEvent = { id: 'ext', owner: 'external', start: MON(14), end: MON(15), title: 'Dentist' };
  const missed: CalEvent = { id: 'j1', owner: 'jarvis', taskId: 'A', start: MON(9), end: MON(10) };           // ended, task A not done
  const clash: CalEvent = { id: 'j2', owner: 'jarvis', taskId: 'B', start: MON(14, 5), end: MON(14, 45) };    // overlaps dentist
  const future: CalEvent = { id: 'j3', owner: 'jarvis', taskId: 'C', start: MON(16), end: MON(17) };          // task C completed
  const { ops, plan } = reconcile([{ id: 'A', minutes: 60, priority: 2 }, { id: 'B', minutes: 30, priority: 2 }, { id: 'C', minutes: 60, priority: 3, completed: true }], [external, missed, clash, future], now, 2);
  assert.ok(!ops.some((o) => o.eventId === 'ext'), 'external event must never be touched');
  assert.ok(ops.find((o) => o.eventId === 'j1' && /not complete/.test(o.reason)));
  assert.ok(ops.find((o) => o.eventId === 'j2' && o.op === 'delete'));
  assert.ok(ops.find((o) => o.eventId === 'j3' && o.reason === 'task completed'));
  assert.deepEqual(plan.placements.map((p) => p.taskId).sort(), ['A', 'B']);   // A and B re-planned, C is not
  for (const p of plan.placements) { assert.ok(p.start >= now); assert.ok(p.end <= external.start - BUFFER || p.start >= external.end + BUFFER); }
});
