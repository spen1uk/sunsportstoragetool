import type { DB } from './db.ts';
import { chicagoParts } from './tz.ts';
import { dailyInstants, planTasks, briefingSpan, type Plan } from './schedule.ts';
import { decideContact } from './contact.ts';
import { getMode } from './modes.ts';
import { clients } from './events.ts';
import { summary as budgetSummary } from './budget.ts';
import { projectDetail } from './milestones.ts';
import { listPeople } from './life.ts';
import { healthIssues } from './health.ts';
import { busyIntervals, upcoming, calendarConnected, syncState } from './calendar.ts';

const rows = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const MAX_WORDS = 390; // ≈ 2.6 min at 150 wpm: inside the 3-minute ceiling

export type Item = { text: string; link?: string; level: 'urgent' | 'info' };
export type Section = { title: string; items: Item[] };

function openManual(db: DB) { return rows(db, "SELECT * FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state NOT IN ('completed','canceled') ORDER BY priority, COALESCE(deadline, 9e15)"); }

export function proposedPlan(db: DB, now: number, week: boolean): { plan: Plan; tasks: Map<string, any> } {
  const tasks = openManual(db);
  const span = briefingSpan(now, week);
  const plan = planTasks(tasks.map((t) => ({ id: t.id, minutes: t.minutes, priority: t.priority, deadline: t.deadline ?? undefined })), busyIntervals(db, now - 86_400_000, now + 15 * 86_400_000), now, 14, span?.until ?? 0);
  return { plan, tasks: new Map(tasks.map((t) => [t.id, t])) };
}

const fmtTime = (t: number) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
const fmtDay = (t: number) => new Date(t).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });

/** Briefing in the required order: urgent → updates → schedule/priorities → recommendations. Text only (read-aloud arrives with voice, deferred). */
import { briefingItems as missionBriefing } from './missions.ts';
import { due as decisionsDue } from './decisions.ts';
import { briefingItems as improveBriefing } from './improve/rollout.ts';
export function buildBriefing(db: DB, now = Date.now()) {
  const p = chicagoParts(now), isMonday = p.dow === 1;
  const urgent: Item[] = [], updates: Item[] = [], recs: Item[] = [], unavailable: string[] = [];

  for (const a of rows(db, "SELECT * FROM approvals WHERE status='pending' ORDER BY created_at")) urgent.push({ text: `Decision needed: ${a.summary}`, link: '#/approvals', level: 'urgent' });
  for (const t of rows(db, "SELECT * FROM tasks WHERE state IN ('failed','waiting_input','waiting_approval') AND is_demo=0")) {
    if (t.state === 'waiting_approval') continue; // already shown as an approval
    urgent.push({ text: `${t.state === 'failed' ? 'Failed' : 'Waiting on you'}: ${t.title}${t.waiting_reason ? ` — ${t.waiting_reason}` : t.last_error ? ` — ${t.last_error}` : ''}`, link: '#/tasks', level: t.state === 'failed' ? 'urgent' : 'info' });
  }
  // Milestones: facts only (dates, linked tasks, dependencies), grouped under their project.
  for (const pr of rows(db, "SELECT id,title FROM projects WHERE is_demo=0 AND status='active'")) {
    const d = projectDetail(db, pr.id, now); if (!d) continue;
    for (const m of d.milestones) {
      if (m.status === 'overdue') urgent.push({ text: `Overdue milestone in ${pr.title}: "${m.title}" was due ${fmtDay(m.due)}.`, link: '#/tasks', level: 'urgent' });
      else if (m.status === 'ready_to_confirm') updates.push({ text: `Ready to confirm: "${m.title}" (${pr.title}) — all linked tasks are done.`, link: '#/tasks', level: 'info' });
      else if (m.status === 'at_risk') recs.push({ text: `At risk: "${m.title}" (${pr.title}) is due ${fmtDay(m.due)}${m.tasks.total === 0 ? ' with no tasks linked to it' : ` with ${m.tasks.open} task(s) still open`}.`, link: '#/tasks', level: 'urgent' });
    }
  }
  for (const h of healthIssues(db, now)) (h.level === 'urgent' ? urgent : recs).push({ text: h.text, link: h.link, level: h.level === 'urgent' ? 'urgent' : 'info' });   // backups overdue, disk low, database trouble…
  const b = budgetSummary(db);
  if (b.level !== 'ok') urgent.push({ text: `Budget at ${Math.round(b.pctCommitted * 100)}% of the monthly cap (${b.level}).`, link: '#/settings', level: 'urgent' });
  if (db.prepare("SELECT 1 FROM meta WHERE key='paused' AND value='1'").get()) urgent.push({ text: 'Jarvis is paused: no new automated work is starting.', link: '#/settings', level: 'urgent' });

  for (const a of rows(db, "SELECT * FROM artifacts WHERE status='in_review' AND is_demo=0")) updates.push({ text: `Ready for review: ${a.title} (v${a.current_version})`, link: '#/review', level: 'info' });
  for (const d of decisionsDue(db, now)) updates.push({ text: `Time to look back: you decided "${d.title}" and expected to know how it went by ${d.expected_by}.`, link: '#/knowledge', level: 'info' });
  for (const it of improveBriefing(db)) updates.push({ text: it.text, link: it.link, level: 'info' });
  for (const it of missionBriefing(db, now)) updates.push({ text: it.text, link: it.link, level: 'info' });   // self-started research that found something corroborated
  const since = new Date(now - 24 * 3600_000).toISOString();
  const done = rows(db, "SELECT title FROM tasks WHERE state='completed' AND completed_at > ? AND is_demo=0", since);
  if (done.length) updates.push({ text: `${done.length} task(s) completed in the last 24 hours.`, level: 'info' });
  // Managers: never invent reports. Planned/unconnected ones are listed as unavailable, grouped.
  const planned = rows(db, "SELECT name FROM agents WHERE role='manager' AND status_kind='planned'").map((r) => r.name);
  if (planned.length) unavailable.push(`No report available (not connected): ${planned.join(', ')}.`);

  const { plan, tasks } = proposedPlan(db, now, isMonday);
  const blocks = plan.placements.map((pl) => ({ ...pl, title: tasks.get(pl.taskId).title, day: fmtDay(pl.start), when: `${fmtTime(pl.start)}–${fmtTime(pl.end)}` }));
  for (const r of plan.deadlineRisk) recs.push({ text: `Deadline risk: "${tasks.get(r.taskId)?.title}" (${r.reason === 'unscheduled' ? 'no open slot before the horizon' : 'would finish after its deadline'}). Consider moving something or extending the deadline.`, link: '#/tasks', level: 'urgent' });
  if (plan.overcapacity) recs.push({ text: `Over capacity: ${plan.unscheduled.length} task(s) do not fit in work hours ${isMonday ? 'this week' : 'in the next work day'}.`, link: '#/tasks', level: 'urgent' });
  const next = [...openManual(db)][0];
  if (next && !recs.length) recs.push({ text: `Start with "${next.title}" — highest priority${next.deadline ? ', due ' + fmtDay(next.deadline) : ''}.`, link: '#/tasks', level: 'info' });
  if (!openManual(db).length && !urgent.length) recs.push({ text: 'Nothing is pending. Good moment to assign research or set tomorrow\'s priorities.', level: 'info' });
  for (const pr of listPeople(db, now).filter((x) => x.due).slice(0, 3)) recs.push({ text: `Stay in touch: ${pr.name}${pr.relationship ? ` (${pr.relationship})` : ''} — ${pr.never ? 'not contacted yet' : `${pr.daysSince} days since you were in touch`}; you wanted every ${pr.everyDays} days.`, link: '#/life', level: 'info' });

  // Narration under the cap: urgent first, then updates, schedule, recommendations; overflow stays visible in the dashboard.
  const calOn = calendarConnected(db, now), calState = syncState(db, 'calendar', now);
  const appts = calOn ? upcoming(db, now, now + 2 * 86_400_000).slice(0, 12).map((e) => ({ title: e.title, day: fmtDay(e.start), when: e.allDay ? 'all day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`, location: e.location, allDay: e.allDay, start: e.start, calendar: e.calendar })) : [];
  const lines = [...urgent.map((i) => i.text), ...updates.map((i) => i.text), ...appts.filter((a) => !a.allDay).slice(0, 5).map((a) => `Appointment ${a.day} ${a.when}: ${a.title}`), ...blocks.slice(0, 8).map((b) => `${b.day} ${b.when}: ${b.title}`), ...recs.map((i) => i.text), ...unavailable];
  let words = 0; const narration: string[] = []; let overflow = 0;
  for (const l of lines) { const w = l.split(/\s+/).length; if (words + w > MAX_WORDS) { overflow++; continue; } words += w; narration.push(l); }

  return {
    generatedAt: now, isMonday, weekAhead: isMonday,
    sections: [{ title: 'Urgent issues and decisions', items: urgent }, { title: 'Significant updates', items: updates }, { title: 'Recommended actions', items: recs }] as Section[],
    schedule: { appointments: appts, calendar: calState.status, blocks, risks: plan.deadlineRisk, overcapacity: plan.overcapacity, unscheduled: plan.unscheduled.map((id) => tasks.get(id)?.title),
      caveat: calOn ? `Proposed around your Apple Calendar appointments${calState.status === 'stale' ? ' (the calendar copy is STALE: last sync failed or is old, so new appointments may be missing)' : ''}, within Mon–Fri 8:00–18:00 work hours. Unusual repeat patterns may be missing. Nothing is written back to your calendar.` : 'Proposed against Mon–Fri 8:00–18:00 work hours only. No calendar is connected, so existing appointments are unknown and nothing is written anywhere.' },
    unavailable, narration: narration.join(' '), narrationWords: words, estimatedSeconds: Math.round((words / 150) * 60), overflow,
  };
}

export function buildRecap(db: DB, now = Date.now()) {
  const p = chicagoParts(now);
  const startOfDay = new Date(now - (p.hour * 60 + p.minute) * 60_000).toISOString();
  const done = rows(db, "SELECT title FROM tasks WHERE state='completed' AND completed_at >= ? AND is_demo=0", startOfDay).map((r) => r.title);
  const open = openManual(db).slice(0, 8).map((t) => t.title);
  const overnight = overnightPlan(db);
  // What needs a decision from Luke tonight
  const decisions: string[] = [];
  const ap = Number((db.prepare("SELECT COUNT(*) c FROM approvals WHERE status='pending'").get() as any).c); if (ap) decisions.push(`${ap} approval${ap === 1 ? '' : 's'} waiting`);
  const rv = Number((db.prepare("SELECT COUNT(*) c FROM artifacts WHERE status='in_review' AND is_demo=0").get() as any).c); if (rv) decisions.push(`${rv} draft${rv === 1 ? '' : 's'} ready to review`);
  for (const d of decisionsDue(db, now)) decisions.push(`look back on “${d.title}”`);
  const pm = Number((db.prepare("SELECT COUNT(*) c FROM missions WHERE status='proposed'").get() as any).c); if (pm) decisions.push(`${pm} research idea${pm === 1 ? '' : 's'} to accept or dismiss`);
  const im = Number((db.prepare("SELECT COUNT(*) c FROM improvements WHERE status='passed'").get() as any).c); if (im) decisions.push(`${im} tested improvement${im === 1 ? '' : 's'} to decide on`);
  return { completedToday: done, unfinished: open, tomorrow: proposedPlan(db, now, false).plan.placements.length, overnightCount: overnight.length, decisionsNeeded: decisions };
}

/** Overnight Plan: Jarvis-owned queued work with owner, desired result, priority, dependency/approval holds, and budget estimate. */
export function overnightPlan(db: DB) {
  return rows(db, "SELECT * FROM tasks WHERE kind IN ('research','revision') AND state NOT IN ('completed','canceled','failed') AND is_demo=0 ORDER BY tonight DESC, priority, created_at").map((t) => ({
    id: t.id, title: t.title, owner: t.owner, desiredResult: t.description || (t.kind === 'research' ? 'Sourced, quoted draft ready for review' : 'New version for comparison'),
    priority: t.priority, tonight: !!t.tonight, state: t.state, hold: t.state === 'waiting_approval' ? 'Waiting for your approval (see Approvals)' : t.state === 'waiting_input' ? (t.waiting_reason ?? 'Waiting on you') : null,
    requires: t.requires, estimateMicroUsd: t.kind === 'research' ? 2000 : 500, attempts: t.attempts,
  }));
}

export function contactNow(db: DB, now = Date.now()) {
  const m = getMode(db, now);
  return { ...m, atComputer: clients.n > 0, decision: decideContact(now, { mode: m.mode, atComputer: clients.n > 0 }), todayTimes: dailyInstants(chicagoParts(now).y, chicagoParts(now).m, chicagoParts(now).d) };
}
