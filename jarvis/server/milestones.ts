import { type DB, id, now } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';

const DAY = 24 * 3600_000, SOON = 3 * DAY;
const rows = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];

export type MStatus = 'done' | 'canceled' | 'blocked' | 'overdue' | 'ready_to_confirm' | 'at_risk' | 'in_progress' | 'not_started';
export type Health = 'no_plan' | 'complete' | 'overdue' | 'blocked' | 'at_risk' | 'on_track';

export function createMilestone(db: DB, m: { projectId: string; title: string; description?: string; due?: number | null; dependsOn?: string | null; isDemo?: boolean }) {
  const p = db.prepare('SELECT id FROM projects WHERE id=?').get(m.projectId); if (!p) throw new Error('project not found');
  if (m.dependsOn) { const d = db.prepare('SELECT project_id FROM milestones WHERE id=?').get(m.dependsOn) as any; if (!d || d.project_id !== m.projectId) throw new Error('dependency must be a milestone in the same project'); }
  const pos = ((db.prepare('SELECT COALESCE(MAX(position),0) p FROM milestones WHERE project_id=?').get(m.projectId) as any).p as number) + 1;
  const mid = id();
  db.prepare('INSERT INTO milestones(id,project_id,title,description,position,due,depends_on,is_demo,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(mid, m.projectId, m.title.slice(0, 200), (m.description ?? '').slice(0, 2000), pos, m.due ?? null, m.dependsOn ?? null, m.isDemo ? 1 : 0, now());
  audit(db, 'luke', 'milestone.created', mid, { title: m.title }); publish({ type: 'projects' }); return mid;
}

export function linkTask(db: DB, taskId: string, milestoneId: string | null) {
  if (milestoneId) {
    const m = db.prepare('SELECT project_id, state FROM milestones WHERE id=?').get(milestoneId) as any; const t = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as any;
    if (!m || !t) throw new Error('not found'); if (m.state !== 'open') throw new Error('milestone is not open');
    if (t.project_id && t.project_id !== m.project_id) throw new Error('task belongs to a different project');
    db.prepare('UPDATE tasks SET milestone_id=?, project_id=COALESCE(project_id,?) WHERE id=?').run(milestoneId, m.project_id, taskId);
  } else db.prepare('UPDATE tasks SET milestone_id=NULL WHERE id=?').run(taskId);
  publish({ type: 'projects' });
}

type Ctx = { tasks: { total: number; done: number; open: number }; blockedBy?: string };
function statusOf(m: any, c: Ctx, at: number): MStatus {
  if (m.state === 'done') return 'done'; if (m.state === 'canceled') return 'canceled';
  if (c.blockedBy) return 'blocked';
  if (c.tasks.total > 0 && c.tasks.open === 0) return 'ready_to_confirm';        // all linked work is finished: only Luke's confirmation is outstanding (even if the date has passed)
  if (m.due && m.due < at) return 'overdue';
  if (m.due && m.due - at < SOON && (c.tasks.total === 0 || c.tasks.open > 0)) return 'at_risk';
  return c.tasks.done > 0 ? 'in_progress' : 'not_started';
}

/** Milestones with computed status and the evidence behind them. Status is derived from facts (dates, linked tasks, dependencies), never typed in. */
export function projectDetail(db: DB, projectId: string, at = Date.now()) {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as any; if (!project) return null;
  const ms = rows(db, 'SELECT * FROM milestones WHERE project_id=? ORDER BY position', projectId);
  const byId = new Map(ms.map((m) => [m.id, m]));
  const milestones = ms.map((m) => {
    const ts = rows(db, 'SELECT id,title,state,kind,completion_evidence FROM tasks WHERE milestone_id=? ORDER BY created_at', m.id);
    const tasks = { total: ts.filter((t) => t.state !== 'canceled').length, done: ts.filter((t) => t.state === 'completed').length, open: ts.filter((t) => !['completed', 'canceled'].includes(t.state)).length };
    const dep = m.depends_on ? byId.get(m.depends_on) : null; const blockedBy = dep && dep.state !== 'done' ? dep.title : undefined;
    return { ...m, tasks, linked: ts, blockedBy, status: statusOf(m, { tasks, blockedBy }, at) as MStatus };
  });
  return { project, milestones, progress: summarize(milestones) };
}

export function summarize(milestones: { state: string; status: MStatus; due: number | null; title: string; evidence: string | null }[]) {
  const live = milestones.filter((m) => m.state !== 'canceled');
  const done = live.filter((m) => m.state === 'done'), open = live.filter((m) => m.state === 'open');
  const has = (s: MStatus) => open.some((m) => m.status === s);
  const health: Health = live.length === 0 ? 'no_plan' : open.length === 0 ? 'complete' : has('overdue') ? 'overdue' : has('blocked') && open.every((m) => m.status === 'blocked') ? 'blocked' : has('at_risk') ? 'at_risk' : 'on_track';
  const next = open.filter((m) => m.status !== 'blocked').sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))[0] ?? null;
  return {
    total: live.length, done: done.length, open: open.length,
    overdue: open.filter((m) => m.status === 'overdue').length, atRisk: open.filter((m) => m.status === 'at_risk').length, readyToConfirm: open.filter((m) => m.status === 'ready_to_confirm').length,
    withEvidence: done.filter((m) => m.evidence).length, health, next: next ? { title: next.title, due: next.due, status: next.status } : null,
    label: live.length === 0 ? 'No milestones defined, so progress cannot be measured yet' : `${done.length} of ${live.length} milestone${live.length === 1 ? '' : 's'} complete`,   // deliberately not a percentage
  };
}

export function listProjects(db: DB, at = Date.now()) {
  return rows(db, 'SELECT * FROM projects ORDER BY is_demo, created_at DESC').map((p) => ({ ...p, progress: projectDetail(db, p.id, at)!.progress }));
}

/**
 * Completing a milestone needs EVIDENCE: either every linked task is completed (their evidence is recorded), or Luke writes what proves it (≥ 10 chars).
 * Blocked milestones can't be completed. Only Luke (or a signed-in session acting for him) can complete one; agents cannot.
 */
export function completeMilestone(db: DB, milestoneId: string, o: { evidence?: string; by?: string }, at = Date.now()) {
  const d = (() => { const m = db.prepare('SELECT project_id FROM milestones WHERE id=?').get(milestoneId) as any; return m ? projectDetail(db, m.project_id, at) : null; })();
  const m = d?.milestones.find((x) => x.id === milestoneId); if (!m) throw new Error('milestone not found');
  if (m.state !== 'open') throw new Error(`milestone is already ${m.state}`);
  if (m.blockedBy) throw new Error(`blocked by "${m.blockedBy}"`);
  const allTasksDone = m.tasks.total > 0 && m.tasks.open === 0;
  const note = (o.evidence ?? '').trim();
  if (!allTasksDone && note.length < 10) throw new Error('Evidence required: finish the linked tasks, or describe what proves this milestone is done (10+ characters).');
  const evidence = [allTasksDone ? `All ${m.tasks.total} linked task(s) completed: ${m.linked.filter((t: any) => t.state === 'completed').map((t: any) => t.title).join('; ')}` : '', note].filter(Boolean).join('\n');
  db.prepare("UPDATE milestones SET state='done', evidence=?, completed_at=?, completed_by=? WHERE id=?").run(evidence, now(), o.by ?? 'luke', milestoneId);
  audit(db, o.by ?? 'luke', 'milestone.completed', milestoneId, { title: m.title, byTasks: allTasksDone, noted: !!note }); publish({ type: 'projects' });
}

export function reopenMilestone(db: DB, milestoneId: string) {
  const r = db.prepare("UPDATE milestones SET state='open', evidence=NULL, completed_at=NULL, completed_by=NULL WHERE id=? AND state IN ('done','canceled')").run(milestoneId);
  if (r.changes) { audit(db, 'luke', 'milestone.reopened', milestoneId); publish({ type: 'projects' }); } return !!r.changes;
}
export function cancelMilestone(db: DB, milestoneId: string) {
  const r = db.prepare("UPDATE milestones SET state='canceled' WHERE id=? AND state='open'").run(milestoneId);
  if (r.changes) { db.prepare('UPDATE tasks SET milestone_id=NULL WHERE milestone_id=?').run(milestoneId); audit(db, 'luke', 'milestone.canceled', milestoneId); publish({ type: 'projects' }); } return !!r.changes;
}
export function updateMilestone(db: DB, milestoneId: string, p: { title?: string; due?: number | null; dependsOn?: string | null }) {
  const m = db.prepare('SELECT * FROM milestones WHERE id=?').get(milestoneId) as any; if (!m) throw new Error('not found');
  if (p.dependsOn) { // no self- or cyclic dependencies
    let cur: string | null = p.dependsOn; for (let i = 0; cur && i < 50; i++) { if (cur === milestoneId) throw new Error('that would create a dependency loop'); cur = (db.prepare('SELECT depends_on FROM milestones WHERE id=?').get(cur) as any)?.depends_on ?? null; }
  }
  db.prepare('UPDATE milestones SET title=COALESCE(?,title), due=CASE WHEN ? THEN ? ELSE due END, depends_on=CASE WHEN ? THEN ? ELSE depends_on END WHERE id=?')
    .run(p.title ?? null, 'due' in p ? 1 : 0, p.due ?? null, 'dependsOn' in p ? 1 : 0, p.dependsOn ?? null, milestoneId);
  audit(db, 'luke', 'milestone.updated', milestoneId, p); publish({ type: 'projects' });
}
