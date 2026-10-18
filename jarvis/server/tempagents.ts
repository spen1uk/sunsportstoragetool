import type { DB } from './db.ts';
import { id } from './db.ts';
import { audit } from './audit.ts';
import { access } from './skills/registry.ts';
import { spentOn } from './missionbudget.ts';

/**
 * Temporary specialist agents. One is created for one mission step with: a charter, a small list of read-only registry skills (each of which the
 * Prometheus agent itself could use: a temporary agent can never hold more than its parent), its own spending allowance, and a hard expiry.
 * It is torn down automatically when the mission ends, when it expires, or when its allowance is used up, and by "Stop everything".
 * Teardown deletes its skill grants, so its principal stops working at once.
 */
export const MAX_ACTIVE = 3, MAX_TTL_MS = 24 * 3_600_000, MAX_BUDGET = 2_000_000;
export const principalOf = (agentId: string) => `temp:${agentId}`;

export function spawn(db: DB, o: { name: string; charter: string; missionId: string; skills?: string[]; budgetMicro: number; ttlMs?: number }, now = Date.now()): string {
  if ((db.prepare("SELECT COUNT(*) c FROM temp_agents WHERE status='active'").get() as any).c >= MAX_ACTIVE) throw new Error(`Only ${MAX_ACTIVE} temporary agents can be active at once.`);
  const ttl = Math.min(o.ttlMs ?? 6 * 3_600_000, MAX_TTL_MS), budget = Math.min(Math.max(0, Math.round(o.budgetMicro)), MAX_BUDGET); if (budget < 10_000) throw new Error('A temporary agent needs at least $0.01.');
  const skills = [...new Set(o.skills ?? [])];
  for (const s of skills) { const a = access(db, 'prometheus', s); if (!a.allowed) throw new Error(`Prometheus may not use "${s}" (${a.reasons.join('; ')}), so a temporary agent cannot either.`); }
  const aid = id();
  db.prepare('INSERT INTO temp_agents(id,name,charter,mission_id,skills,budget_micro_usd,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(aid, o.name.slice(0, 60), o.charter.slice(0, 300), o.missionId, JSON.stringify(skills), budget, now, now + ttl);
  const g = db.prepare('INSERT INTO skill_grants(principal,skill_id,granted_at,granted_by) VALUES(?,?,?,?)'); for (const s of skills) g.run(principalOf(aid), s, now, 'system:spawn');
  audit(db, 'system', 'tempagent.spawned', aid, { mission: o.missionId, skills, budget, ttlMin: Math.round(ttl / 60_000) }); return aid;
}
export const get = (db: DB, aid: string) => db.prepare('SELECT * FROM temp_agents WHERE id=?').get(aid) as any;
export const isLive = (db: DB, aid: string, now = Date.now()) => { const r = get(db, aid); return !!r && r.status === 'active' && r.expires_at > now; };
export function teardown(db: DB, aid: string, reason: string, now = Date.now()) {
  const r = db.prepare("UPDATE temp_agents SET status='torn_down', torn_down_at=?, teardown_reason=? WHERE id=? AND status='active'").run(now, reason.slice(0, 120), aid);
  if (!r.changes) return false; db.prepare('DELETE FROM skill_grants WHERE principal=?').run(principalOf(aid)); audit(db, 'system', 'tempagent.torn_down', aid, { reason }); return true;
}
export function teardownAll(db: DB, reason: string, now = Date.now()) { let n = 0; for (const a of db.prepare("SELECT id FROM temp_agents WHERE status='active'").all() as { id: string }[]) if (teardown(db, a.id, reason, now)) n++; return n; }
/** Tear down every agent that has expired, whose mission is over, or that used up its allowance. Safe to call often. */
export function sweep(db: DB, now = Date.now()): number {
  let n = 0;
  for (const a of db.prepare("SELECT * FROM temp_agents WHERE status='active'").all() as any[]) {
    const m = db.prepare('SELECT status FROM missions WHERE id=?').get(a.mission_id) as { status: string } | undefined;
    const taskIds = (db.prepare('SELECT task_id FROM mission_steps WHERE agent_id=? AND task_id IS NOT NULL').all(a.id) as { task_id: string }[]).map((x) => x.task_id);
    const spent = taskIds.reduce((s, t) => s + spentOn(db, t), 0);
    const why = a.expires_at <= now ? 'expired' : !m || ['done', 'stopped', 'failed'].includes(m.status) ? 'mission ended' : spent >= a.budget_micro_usd ? 'allowance used up' : null;
    if (why && teardown(db, a.id, why, now)) n++;
  }
  return n;
}
export const list = (db: DB, now = Date.now()) => (db.prepare('SELECT * FROM temp_agents ORDER BY created_at DESC LIMIT 30').all() as any[]).map((a) => ({ id: a.id, name: a.name, charter: a.charter, missionId: a.mission_id, skills: JSON.parse(a.skills), budgetMicroUsd: a.budget_micro_usd, createdAt: a.created_at, expiresAt: a.expires_at, status: a.status, tornDownAt: a.torn_down_at, reason: a.teardown_reason, live: a.status === 'active' && a.expires_at > now }));
