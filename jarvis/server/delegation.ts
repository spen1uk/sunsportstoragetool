import { z } from 'zod';
import { type DB, id } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { looksSecret } from './memory.ts';
import { isExcluded } from './exclusions.ts';
import * as missions from './missions.ts';
import { createTask } from './tasks.ts';
import { gate as webGate } from './websearch.ts';
import { monthStartOf } from './llm/gateway.ts';

/**
 * The delegation loop. Jarvis takes a request, picks the best agent that really exists and can do it (with the reason), states the objective,
 * the expected deliverable, a deadline and a spending limit, watches the work, checks the result against plain tests and sends weak work
 * back (twice at most) before asking Luke. Luke can always accept, send back with a note, or cancel. Agents that are not connected
 * (Sales, Trading, ...) are named honestly as unavailable instead of being pretended into existence.
 */
export const MAX_RETURNS = 2, DEFAULT_CAP = 3_000_000, MAX_CAP = 10_000_000;
const RESEARCH = /\b(research|find out|look into|look up|investigate|compare|comparison|best|options|alternatives?|competitors?|market|prices?|pricing|trend|news|learn about|what are|how do|which|who makes|review of|reviews|vs|versus|recommend\w*|analy[sz]e|study|evidence|sources?)\b/i;
const OWN = /\b(remind me|add (?:a )?task|schedule|put on my calendar|note that|remember that|to-?do|follow up with|call|text|email)\b/i;
const PLANNED: [string, RegExp][] = [['trading', /\b(trade|trading|backtest|strategy|calvin|blofin|position|stop loss|risk manager)\b/i], ['investing', /\b(invest|investing|portfolio|stocks?|etf|dividend|rebalanc\w+)\b/i], ['ssm-sales', /\b(sales lead|leads|pipeline|quote|close the deal)\b/i], ['ssm-service', /\b(service department|repair order|warranty)\b/i], ['ssm-parts', /\b(parts department|part number|inventory)\b/i], ['ssm-marketing', /\b(ad campaign|ads|marketing campaign|facebook ads|google ads)\b/i], ['health', /\b(workout plan|nutrition plan|baseline)\b/i]];
const clean = (s: string, n: number) => s.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Who should get this, and why. Plain rules over the request, using only agents that exist; connected-or-not is stated honestly. */
export function chooseAgent(db: DB, request: string): { agentId: string; name: string; available: boolean; why: string } {
  for (const [aid, re] of PLANNED) if (re.test(request)) { const a = db.prepare('SELECT id,name,status_kind FROM agents WHERE id=?').get(aid) as { id: string; name: string; status_kind: string } | undefined; if (a) return { agentId: a.id, name: a.name, available: ['connected', 'live'].includes(a.status_kind), why: ['connected', 'live'].includes(a.status_kind) ? `This is ${a.name}'s kind of work.` : `This is ${a.name}'s kind of work, but ${a.name} is not connected to Jarvis yet, so nobody can do it for you today.` }; }
  if (OWN.test(request) && !RESEARCH.test(request)) return { agentId: 'luke', name: 'You (on your task list)', available: true, why: 'This is an errand or reminder rather than research, so it goes on your task list.' };
  if (RESEARCH.test(request)) return { agentId: 'prometheus', name: 'Prometheus', available: true, why: 'This needs information found and checked on the internet, which is what Prometheus does.' };
  return { agentId: 'luke', name: 'You (on your task list)', available: true, why: 'No agent is built for this, so it goes on your task list rather than being guessed at.' };
}
const log = (db: DB, did: string, kind: string, detail = '') => db.prepare('INSERT INTO delegation_events(delegation_id,at,kind,detail) VALUES(?,?,?,?)').run(did, Date.now(), kind, detail.slice(0, 300));
export const events = (db: DB, did: string) => db.prepare('SELECT at,kind,detail FROM delegation_events WHERE delegation_id=? ORDER BY id').all(did);
const hydrate = (r: any) => ({ id: r.id, request: r.request, objective: r.objective, deliverable: r.deliverable, agentId: r.agent_id, why: r.why_agent, deadlineMs: r.deadline_ms, capMicroUsd: r.cap_micro, missionId: r.mission_id, taskId: r.task_id, status: r.status, returns: r.returns, verdict: r.verdict, feedback: r.feedback, spentMicroUsd: r.spent_micro, createdAt: r.created_at, finishedAt: r.finished_at });
export const list = (db: DB) => (db.prepare("SELECT * FROM delegations ORDER BY CASE status WHEN 'in_review' THEN 0 WHEN 'working' THEN 1 WHEN 'returned' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, created_at DESC LIMIT 60").all() as any[]).map(hydrate);

const reqIn = z.object({ request: z.string().min(8).max(500), deliverable: z.string().max(200).optional(), deadlineDays: z.number().int().min(1).max(60).optional(), capMicro: z.number().int().min(50_000).max(MAX_CAP).optional() }).strict();
export function delegate(db: DB, raw: unknown, now = Date.now()) {
  const v = reqIn.parse(raw); const text = clean(v.request, 500); if (looksSecret(text) || isExcluded(db, text)) throw new Error('That looks like a secret or mentions something you asked me never to store.');
  const pick = chooseAgent(db, text); if (!pick.available) throw new Error(pick.why);
  const did = id(), deadline = v.deadlineDays ? now + v.deadlineDays * 86_400_000 : null, deliverable = clean(v.deliverable ?? (pick.agentId === 'prometheus' ? 'A short sourced write-up with a clear recommendation and what is still uncertain.' : 'The task done.'), 200), cap = pick.agentId === 'prometheus' ? (v.capMicro ?? DEFAULT_CAP) : 0;
  let mission: string | null = null, task: string | null = null;
  if (pick.agentId === 'prometheus') { const g = webGate(db, { channel: 'dashboard' }); if (g) throw new Error(g); mission = missions.createAssigned(db, { goal: text, title: text.slice(0, 80), capMicro: cap, value: `Delegated by Jarvis. Deliverable: ${deliverable}` }, now); }
  else task = createTask(db, { title: text.slice(0, 120), description: `Delegated: ${deliverable}`, deadline: deadline ?? undefined, priority: 3 });
  db.prepare("INSERT INTO delegations(id,request,objective,deliverable,agent_id,why_agent,deadline_ms,cap_micro,mission_id,task_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(did, text, text, deliverable, pick.agentId, pick.why, deadline, cap, mission, task, pick.agentId === 'prometheus' ? 'working' : 'accepted', now, now);
  log(db, did, 'assigned', `${pick.name}: ${pick.why}`); if (pick.agentId !== 'prometheus') db.prepare('UPDATE delegations SET finished_at=? WHERE id=?').run(now, did);
  audit(db, 'luke', 'delegation.created', did, { agent: pick.agentId, cap }); publish({ type: 'delegations' }); return { id: did, agent: pick };
}
const get = (db: DB, did: string) => db.prepare('SELECT * FROM delegations WHERE id=?').get(did) as any;

/** Plain tests of a finished report. Returns what is wrong, or an empty list if it can go to Luke. */
export function assess(report: any): string[] {
  const out: string[] = []; if (!report) return ['No report was produced.'];
  const st = report.stats ?? {}; if (!(st.findings > 0)) out.push('It found nothing it could back up.'); else if (!(st.corroborated >= 1)) out.push('None of its findings was confirmed by a second independent site.'); if (st.partial) out.push('Part of the work could not be finished.');
  if (!String(report.conclusion ?? '').trim()) out.push('There is no conclusion.'); return out;
}
/** Called after the mission engine ticks: moves delegations along, reviews finished work, sends weak work back (up to twice). */
export function sync(db: DB, now = Date.now()) {
  for (const d of db.prepare("SELECT * FROM delegations WHERE status IN ('working','returned','blocked') AND mission_id IS NOT NULL").all() as any[]) {
    const m = missions.get(db, d.mission_id); const spent = m ? missions.missionSpent(db, m.id) : d.spent_micro; if (spent !== d.spent_micro) db.prepare('UPDATE delegations SET spent_micro=?, updated_at=? WHERE id=?').run(spent, now, d.id);
    if (!m) { fail(db, d, 'The research job no longer exists.', now); continue; }
    if (m.status === 'failed' || m.status === 'stopped') { fail(db, d, `The research job ${m.status}${m.stop_reason ? `: ${m.stop_reason}` : ''}.`, now); continue; }
    if (m.status === 'blocked' && d.status !== 'blocked') { db.prepare("UPDATE delegations SET status='blocked', updated_at=? WHERE id=?").run(now, d.id); log(db, d.id, 'blocked', String(m.blockers ?? '').slice(0, 200)); publish({ type: 'delegations' }); continue; }
    if ((m.status === 'active' || m.status === 'paused') && d.status === 'blocked') { db.prepare("UPDATE delegations SET status='working', updated_at=? WHERE id=?").run(now, d.id); }
    if (m.status !== 'done') continue;
    let report: any = null; try { report = m.report ? JSON.parse(m.report) : null; } catch { /* none */ }
    const problems = assess(report);
    if (problems.length && d.returns < MAX_RETURNS && report) {
      const q = `Find stronger evidence. Problems with the last attempt: ${problems.join(' ')} Focus on: ${clean(d.objective, 200)}`;
      try { missions.addStep(db, m.id, q); db.prepare("UPDATE delegations SET status='returned', returns=returns+1, verdict=?, updated_at=? WHERE id=?").run(problems.join(' '), now, d.id); log(db, d.id, 'returned', `Sent back (${d.returns + 1} of ${MAX_RETURNS}): ${problems.join(' ')}`); audit(db, 'system', 'delegation.returned', d.id, { n: d.returns + 1 }); publish({ type: 'delegations' }); continue; } catch { /* mission cannot take more steps: fall through to review */ }
    }
    db.prepare("UPDATE delegations SET status='in_review', verdict=?, updated_at=? WHERE id=?").run(problems.length ? `Still thin: ${problems.join(' ')}` : 'Passed the checks: findings confirmed by more than one site.', now, d.id); log(db, d.id, 'in_review', problems.length ? 'ready, but still thin' : 'ready'); publish({ type: 'delegations' });
  }
}
function fail(db: DB, d: any, why: string, now: number) { db.prepare("UPDATE delegations SET status='failed', verdict=?, finished_at=?, updated_at=? WHERE id=?").run(why, now, now, d.id); log(db, d.id, 'failed', why); audit(db, 'system', 'delegation.failed', d.id); publish({ type: 'delegations' }); }
export function accept(db: DB, did: string, now = Date.now()) { const d = get(db, did); if (!d || !['in_review', 'blocked', 'working', 'returned'].includes(d.status)) throw new Error('Nothing to accept.'); if (d.mission_id && d.status !== 'in_review') throw new Error('It is not ready for review yet.'); db.prepare("UPDATE delegations SET status='accepted', finished_at=?, updated_at=? WHERE id=?").run(now, now, did); log(db, did, 'accepted', 'accepted by Luke'); audit(db, 'luke', 'delegation.accepted', did); publish({ type: 'delegations' }); }
export function sendBack(db: DB, did: string, feedback: string, now = Date.now()) {
  const d = get(db, did); if (!d || d.status !== 'in_review' || !d.mission_id) throw new Error('Only finished research can be sent back.'); const f = clean(feedback, 300); if (f.length < 8) throw new Error('Say what is missing.'); if (looksSecret(f) || isExcluded(db, f)) throw new Error('That looks like a secret or mentions something you asked me never to store.');
  missions.addStep(db, d.mission_id, `${f} (original aim: ${clean(d.objective, 160)})`); db.prepare("UPDATE delegations SET status='returned', returns=returns+1, feedback=?, updated_at=?, finished_at=NULL WHERE id=?").run(f, now, did); log(db, did, 'returned', `Luke: ${f}`); audit(db, 'luke', 'delegation.returned', did); publish({ type: 'delegations' });
}
export function cancel(db: DB, did: string, now = Date.now()) { const d = get(db, did); if (!d || ['accepted', 'failed', 'cancelled'].includes(d.status)) throw new Error('Already finished.'); if (d.mission_id) { try { missions.stop(db, d.mission_id, 'Delegation cancelled by you'); } catch { /* already finished */ } } db.prepare("UPDATE delegations SET status='cancelled', finished_at=?, updated_at=? WHERE id=?").run(now, now, did); log(db, did, 'cancelled'); audit(db, 'luke', 'delegation.cancelled', did); publish({ type: 'delegations' }); }

// ---- scorecards ----
export type Card = { agent: string; window: string; jobs: number; accepted: number; returned: number; failed: number; acceptRatePct: number | null; avgCostMicro: number | null; avgDays: number | null; skillRuns: number; skillOkPct: number | null; spendMicro: number };
/** Per agent, last 30 days, with the 30 days before for comparison. Only counted from real records; an empty history says so instead of showing zeros as scores. */
export function scorecards(db: DB, now = Date.now()) {
  const DAY = 86_400_000, card = (agent: string, from: number, to: number): Card => {
    const ds = db.prepare("SELECT * FROM delegations WHERE agent_id=? AND created_at>=? AND created_at<?").all(agent, from, to) as any[], done = ds.filter((d) => d.status === 'accepted'), finished = ds.filter((d) => ['accepted', 'failed', 'cancelled'].includes(d.status));
    const sr = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(ok),0) o FROM skill_runs WHERE principal=? AND at>=? AND at<?").get(agent, from, to) as any;
    const spend = agent === 'prometheus' ? Number((db.prepare("SELECT COALESCE(SUM(cost_micro_usd),0) s FROM llm_usage WHERE ok=1 AND task IN ('web','analysis') AND at>=? AND at<?").get(from, to) as any).s) : Number((db.prepare("SELECT COALESCE(SUM(cost_micro_usd),0) s FROM llm_usage WHERE ok=1 AND task IN ('chat','ping') AND at>=? AND at<?").get(from, to) as any).s);
    return { agent, window: `${new Date(from).toISOString().slice(0, 10)} to ${new Date(to - 1).toISOString().slice(0, 10)}`, jobs: ds.length, accepted: done.length, returned: ds.reduce((a, d) => a + d.returns, 0), failed: ds.filter((d) => d.status === 'failed').length,
      acceptRatePct: finished.length ? Math.round((done.length / finished.length) * 100) : null, avgCostMicro: done.length ? Math.round(done.reduce((a, d) => a + d.spent_micro, 0) / done.length) : null, avgDays: done.length ? Math.round((done.reduce((a, d) => a + ((d.finished_at ?? now) - d.created_at), 0) / done.length / DAY) * 10) / 10 : null,
      skillRuns: Number(sr.n), skillOkPct: Number(sr.n) ? Math.round((Number(sr.o) / Number(sr.n)) * 100) : null, spendMicro: spend };
  };
  return Object.fromEntries(['jarvis', 'prometheus'].map((a) => [a, { now: card(a, now - 30 * DAY, now + 1), before: card(a, now - 60 * DAY, now - 30 * DAY) }]));
}
void monthStartOf;
