import { z } from 'zod';
import { type DB, id } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { looksSecret } from './memory.ts';
import { isExcluded } from './exclusions.ts';

/**
 * Goals Luke cares about, linked to a project (progress comes from that project's milestones, never from a made-up percentage) and to the
 * agent responsible. Obstacles are found by counting real things (overdue tasks, milestones past due, no activity), not guessed.
 */
const body = {
  title: z.string().min(3).max(120), why: z.string().max(500).default(''), horizon: z.enum(['short', 'long']).default('long'), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  ownerAgent: z.string().max(40).default('jarvis'), projectId: z.string().max(60).nullable().default(null), notes: z.string().max(1000).default(''),
};
const createIn = z.object(body).strict();
const patchIn = z.object({ ...Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v instanceof z.ZodDefault ? v.unwrap() : v])) , status: z.enum(['active', 'done', 'dropped']) }).partial().strict();
const clean = (db: DB, g: { title?: string; why?: string; notes?: string }) => { const t = `${g.title ?? ''} ${g.why ?? ''} ${g.notes ?? ''}`; if (looksSecret(t) || isExcluded(db, t)) throw new Error('That looks like a secret or mentions something you asked me never to store.'); };
function checkLinks(db: DB, g: { ownerAgent?: string; projectId?: string | null }) {
  if (g.ownerAgent && !db.prepare('SELECT 1 FROM agents WHERE id=? OR ?=\'prometheus\'').get(g.ownerAgent, g.ownerAgent)) throw new Error('Unknown agent.');
  if (g.projectId && !db.prepare('SELECT 1 FROM projects WHERE id=?').get(g.projectId)) throw new Error('Unknown project.');
}
export function progress(db: DB, projectId: string | null) {
  if (!projectId) return { linked: false, done: 0, total: 0, next: null as string | null };
  const ms = db.prepare("SELECT title, state FROM milestones WHERE project_id=? AND state<>'canceled' ORDER BY position, rowid").all(projectId) as { title: string; state: string }[];
  return { linked: true, done: ms.filter((m) => m.state === 'done').length, total: ms.length, next: ms.find((m) => m.state === 'open')?.title ?? null };
}
export function obstacles(db: DB, g: { project_id: string | null; target_date: string | null; status: string }, now = Date.now()): string[] {
  if (g.status !== 'active') return []; const out: string[] = [];
  if (g.target_date && Date.parse(g.target_date) < now) out.push('The target date has passed.');
  if (!g.project_id) { out.push('Not linked to a project, so nothing can show progress yet.'); return out; }
  const over = Number((db.prepare("SELECT COUNT(*) c FROM tasks WHERE project_id=? AND kind='manual' AND state NOT IN ('completed','canceled','failed') AND deadline IS NOT NULL AND deadline<?").get(g.project_id, now) as any).c);
  if (over) out.push(`${over} task${over === 1 ? ' is' : 's are'} overdue.`);
  const lateMs = Number((db.prepare("SELECT COUNT(*) c FROM milestones WHERE project_id=? AND state='open' AND due IS NOT NULL AND due<?").get(g.project_id, now) as any).c); if (lateMs) out.push(`${lateMs} milestone${lateMs === 1 ? ' is' : 's are'} past due.`);
  const ms = progress(db, g.project_id); if (ms.total === 0) out.push('The project has no milestones, so progress cannot be measured.');
  const last = db.prepare("SELECT MAX(updated_at) m FROM tasks WHERE project_id=? AND kind='manual'").get(g.project_id) as { m: string | null }; if (last.m && now - Date.parse(last.m) > 14 * 86_400_000 && ms.done < ms.total) out.push('Nothing has moved on it for two weeks.');
  return out;
}
const hydrate = (db: DB, r: any, now: number) => ({ id: r.id, title: r.title, why: r.why, horizon: r.horizon, targetDate: r.target_date, status: r.status, ownerAgent: r.owner_agent, projectId: r.project_id, projectTitle: r.project_id ? (db.prepare('SELECT title FROM projects WHERE id=?').get(r.project_id) as any)?.title ?? null : null, notes: r.notes, progress: progress(db, r.project_id), obstacles: obstacles(db, r, now), createdAt: r.created_at });
export const list = (db: DB, now = Date.now()) => (db.prepare("SELECT * FROM goals ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, (target_date IS NULL), target_date, created_at DESC").all() as any[]).map((r) => hydrate(db, r, now));
export function create(db: DB, raw: unknown, now = Date.now()) {
  const v = createIn.parse(raw); clean(db, v); checkLinks(db, v); const gid = id();
  db.prepare('INSERT INTO goals(id,title,why,horizon,target_date,owner_agent,project_id,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(gid, v.title, v.why, v.horizon, v.targetDate, v.ownerAgent, v.projectId, v.notes, now, now);
  audit(db, 'luke', 'goal.created', gid); publish({ type: 'goals' }); return gid;
}
export function update(db: DB, gid: string, raw: unknown, now = Date.now()) {
  const p = patchIn.parse(raw) as Partial<z.infer<typeof createIn>> & { status?: 'active' | 'done' | 'dropped' }; const cur = db.prepare('SELECT * FROM goals WHERE id=?').get(gid) as any; if (!cur) throw new Error('not found');
  clean(db, p); checkLinks(db, p); const col: Record<string, string> = { title: 'title', why: 'why', horizon: 'horizon', targetDate: 'target_date', status: 'status', ownerAgent: 'owner_agent', projectId: 'project_id', notes: 'notes' };
  const sets = Object.keys(p).map((k) => `${col[k]}=?`); if (!sets.length) throw new Error('nothing to change');
  db.prepare(`UPDATE goals SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...Object.values(p) as any[], now, gid);
  audit(db, 'luke', 'goal.updated', gid, { before: { status: cur.status, owner: cur.owner_agent }, after: p }); publish({ type: 'goals' }); return true;
}
export function remove(db: DB, gid: string) { const r = db.prepare('DELETE FROM goals WHERE id=?').run(gid); if (r.changes) { audit(db, 'luke', 'goal.deleted', gid); publish({ type: 'goals' }); } return r.changes > 0; }
