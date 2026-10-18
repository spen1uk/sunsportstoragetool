import type { DB } from './db.ts';
import { buildBriefing } from './today.ts';
import { getMode } from './modes.ts';
import { decideContact } from './contact.ts';
import { isPaused } from './pause.ts';
import { summary as budget } from './budget.ts';
import { listProjects } from './milestones.ts';
import { handoffFor, handoffContext } from './handoff.ts';
import { contextLine as weatherLine } from './weather.ts';
import { contextLine as webLine } from './websearch.ts';

const rows = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
/** User-authored text becomes DATA in the prompt: strip anything that could look like markup, collapse whitespace, cap length. */
const clean = (s: unknown, n = 140) => String(s ?? '').replace(/[<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const chicago = (t: number) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * A compact, READ-ONLY snapshot of Luke's real state for the chat model: tasks, approvals, review items, projects/milestones,
 * the briefing's urgent items, contact mode, budget. Demo records are excluded. The model can read this and nothing else:
 * it still has no tools, so it cannot change any of it. Capped in size so it stays cheap (≈ a few hundred tokens).
 */
export function buildContext(db: DB, now = Date.now(), channel = 'dashboard'): string {
  const L: string[] = [];
  const mode = getMode(db, now), d = decideContact(now, { mode: mode.mode });
  L.push(`Now: ${chicago(now)} (America/Chicago). Contact mode: ${mode.mode} (${d.hold ? 'interruptions held' : `channels: ${d.channels.join(', ')}`}).${isPaused(db) ? ' JARVIS IS PAUSED: no new automated work.' : ''}`);
  const b = budget(db); L.push(`Monthly budget: ${Math.round(b.pctCommitted * 100)}% committed (${b.level}).`);

  const br = buildBriefing(db, now);
  const urgent = br.sections[0].items.map((i) => clean(i.text, 200)).slice(0, 6); if (urgent.length) L.push('URGENT / DECISIONS:\n' + urgent.map((t) => `- ${t}`).join('\n'));
  const upd = br.sections[1].items.map((i) => clean(i.text, 160)).slice(0, 5); if (upd.length) L.push('UPDATES:\n' + upd.map((t) => `- ${t}`).join('\n'));

  const open = rows(db, "SELECT title,priority,minutes,deadline,state FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state NOT IN ('completed','canceled') ORDER BY priority, COALESCE(deadline, 9e15), created_at LIMIT 15");
  const openTotal = (rows(db, "SELECT COUNT(*) c FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state NOT IN ('completed','canceled')")[0] as any).c;
  L.push(openTotal ? `LUKE'S OPEN TASKS (${openTotal}; priority 1 = most important):\n` + open.map((t) => `- P${t.priority} ${clean(t.title)} (${t.minutes} min${t.deadline ? `, due ${chicago(t.deadline)}` : ''})`).join('\n') + (openTotal > open.length ? `\n- …and ${openTotal - open.length} more` : '') : "LUKE'S OPEN TASKS: none.");

  const work = rows(db, "SELECT title,state,waiting_reason FROM tasks WHERE kind IN ('research','revision') AND is_demo=0 AND state NOT IN ('completed','canceled') ORDER BY created_at DESC LIMIT 6");
  if (work.length) L.push('JARVIS-RUN WORK:\n' + work.map((t) => `- ${clean(t.title)}: ${t.state.replace('_', ' ')}${t.waiting_reason ? ` (${clean(t.waiting_reason, 100)})` : ''}`).join('\n'));

  const ap = rows(db, "SELECT summary,risk FROM approvals WHERE status='pending' ORDER BY created_at LIMIT 6");
  if (ap.length) L.push('PENDING APPROVALS (only Luke can decide these, in the dashboard):\n' + ap.map((a) => `- ${clean(a.summary, 160)} [${a.risk} risk]`).join('\n'));
  const rv = rows(db, "SELECT title,current_version FROM artifacts WHERE status='in_review' AND is_demo=0 LIMIT 5");
  if (rv.length) L.push('READY FOR REVIEW:\n' + rv.map((a) => `- ${clean(a.title, 100)} (v${a.current_version})`).join('\n'));

  const projs = listProjects(db, now).filter((p: any) => !p.is_demo && p.status === 'active').slice(0, 6);
  if (projs.length) L.push('PROJECTS (progress is counted in milestones, never percentages):\n' + projs.map((p: any) => `- ${clean(p.title, 80)}: ${p.progress.label}; health ${p.progress.health}${p.progress.next ? `; next "${clean(p.progress.next.title, 70)}"` : ''}`).join('\n'));

  const appts = br.schedule.appointments ?? [];
  if (appts.length) L.push(`APPOINTMENTS from Luke's Apple Calendar, next 2 days (read-only copy${br.schedule.calendar === 'stale' ? ', STALE: may be out of date' : ''}; recurring events may be missing):\n` + appts.slice(0, 8).map((a) => `- ${a.day} ${a.when}: ${clean(a.title, 80)}`).join('\n'));
  if (br.schedule.blocks.length) L.push(`PROPOSED NEXT WORK SLOTS (a proposal only; ${br.schedule.calendar === 'connected' || br.schedule.calendar === 'stale' ? 'planned around his Apple Calendar, which may miss recurring events' : 'no calendar is connected, so appointments are unknown'}):\n` + br.schedule.blocks.slice(0, 6).map((x) => `- ${x.day} ${x.when}: ${clean(x.title, 80)}`).join('\n'));
  { const w = weatherLine(db, now); if (w) L.push(w); } L.push(webLine(db));
  const hf = handoffFor(db, channel, now); if (hf) L.push(handoffContext(hf));
  return L.join('\n\n').slice(0, 4500);
}
