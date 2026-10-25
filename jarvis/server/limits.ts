import { type DB, id } from './db.ts';
import { audit } from './audit.ts';
import { tierOf, type Manifest } from './skills/manifest.ts';

/**
 * Stage 4: limits that live in code.
 *  1. Hand-offs between agents: at most 2 levels deep and 6 consults for one piece of work, so agents cannot pass work around in circles.
 *  2. The narrow lane for temporary and Foundry agents: public information only, read-only skills, nothing that writes, sends or spends.
 */
export const MAX_DEPTH = 2, MAX_CONSULTS = 6;

export class ConsultLimit extends Error {}
/** An agent asking another agent to do work. `parentId` is the delegation it is working under. Throws a plain-words refusal over either limit. */
export function beginConsult(db: DB, o: { parentId: string; from: string; to: string; kind: string }, now = Date.now()): { rootId: string; depth: number; consultId: string } {
  const p = db.prepare('SELECT id, root_id, depth FROM delegations WHERE id=?').get(o.parentId) as { id: string; root_id: string | null; depth: number } | undefined;
  if (!p) throw new ConsultLimit('An agent can only hand work on as part of work it was given.');
  const rootId = p.root_id ?? p.id, depth = p.depth + 1;
  if (depth > MAX_DEPTH) throw new ConsultLimit(`That is ${MAX_DEPTH} hand-offs deep already, so it stops here and comes back to you.`);
  const used = (db.prepare('SELECT COUNT(*) c FROM consults WHERE root_id=?').get(rootId) as { c: number }).c;
  if (used >= MAX_CONSULTS) throw new ConsultLimit(`This piece of work has already used its ${MAX_CONSULTS} consults, so it stops here and comes back to you.`);
  const cid = id(); db.prepare('INSERT INTO consults(id,root_id,parent_id,depth,from_agent,to_agent,kind,at) VALUES(?,?,?,?,?,?,?,?)').run(cid, rootId, o.parentId, depth, o.from.slice(0, 40), o.to.slice(0, 40), o.kind.slice(0, 30), now);
  audit(db, 'system', 'consult.begun', cid, { root: rootId, depth, from: o.from, to: o.to }); return { rootId, depth, consultId: cid };
}
export const consultsUsed = (db: DB, rootId: string) => (db.prepare('SELECT COUNT(*) c FROM consults WHERE root_id=?').get(rootId) as { c: number }).c;

/** Why a skill is outside the narrow lane (empty list = inside). Same test for temporary agents, Foundry agents and the checks the Skills page shows. */
export function outsideNarrowLane(m: Pick<Manifest, 'permissions' | 'sideEffects' | 'dataSensitivity' | 'runPath'>): string[] {
  const why: string[] = [];
  if (tierOf(m) > 1) why.push('it can do more than read or make small internal notes');
  if (!['none', 'external_read'].includes(m.sideEffects)) why.push(`its side effects are "${m.sideEffects}"`);
  if (m.dataSensitivity !== 'public') why.push(`it handles ${m.dataSensitivity} data`);
  if (m.runPath !== 'direct') why.push('it does not run directly through the registry');
  return why;
}
