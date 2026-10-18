import crypto from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db.ts';
import { audit } from '../audit.ts';
import { isPaused } from '../pause.ts';
import { canonicalJson } from '../db.ts';
import { ALL_BUILTIN, type Entry } from './catalog.ts';
import { PRINCIPALS, SENS_RANK, tierOf, isPrincipal, type Manifest } from './manifest.ts';

/**
 * The skills registry: the ONE place that says which skills exist, which version is live, who may use each, and what ran.
 * Rules enforced here, in code (not in any prompt):
 *  - a skill's manifest lives in the codebase (reviewed, versioned, tested); the database only holds on/off, the live version, grants and history;
 *  - a skill cannot grant itself or anyone a permission; only Luke (with step-up, in the HTTP layer) grants, enables, activates or rolls back;
 *  - an agent can use a skill only if the skill's permissions and data sensitivity are within that agent's fixed ceilings (Prometheus never gets private data);
 *  - tier 3+ skills (anything that sends, spends, deletes or widens access) never run through `invoke`; they only exist as approval requests;
 *  - results from untrusted places (web) are flagged so they can never steer a skill that has side effects.
 */
const extra: Entry[] = [];
/** TEST ONLY: add skills (e.g. a second version) to exercise rollback and composition. Never wired to config or requests. */
export const _testEntries = { add: (...e: Entry[]) => { extra.push(...e); synced = new WeakSet(); }, clear: () => { extra.length = 0; synced = new WeakSet(); } };
export const entries = (): Entry[] => [...ALL_BUILTIN, ...extra];
const semverCmp = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
export const versionsOf = (id: string) => entries().filter((e) => e.manifest.id === id).sort((a, b) => semverCmp(a.manifest.version, b.manifest.version));
export const ids = () => [...new Set(entries().map((e) => e.manifest.id))].sort();
const sha = (v: unknown) => crypto.createHash('sha256').update(canonicalJson(v)).digest('hex');

let synced = new WeakSet<DB>();
/** Record every code-defined skill version; first sight of a skill makes its newest version live, later versions wait staged for your activation. Manifest edits to an existing version are flagged as drift. */
export function sync(db: DB, now = Date.now()) {
  if (synced.has(db)) return; synced.add(db);
  const seen = new Set<string>();
  for (const e of entries()) {
    const m = e.manifest, h = sha(m); const k = `${m.id}@${m.version}`; if (seen.has(k)) throw new Error(`duplicate skill version ${k}`); seen.add(k);
    const row = db.prepare('SELECT manifest_sha256 h FROM skill_versions WHERE skill_id=? AND version=?').get(m.id, m.version) as { h: string } | undefined;
    if (!row) db.prepare("INSERT INTO skill_versions(skill_id,version,manifest_sha256,registered_at,status) VALUES(?,?,?,?, 'staged')").run(m.id, m.version, h, now);
    else if (row.h !== h) { db.prepare('UPDATE skill_versions SET manifest_sha256=? WHERE skill_id=? AND version=?').run(h, m.id, m.version); audit(db, 'system', 'skill.manifest_drift', m.id, { version: m.version }); }
  }
  for (const id of ids()) {
    if (db.prepare('SELECT 1 FROM skill_state WHERE skill_id=?').get(id)) continue;
    const top = versionsOf(id).at(-1)!.manifest.version;
    db.prepare("INSERT INTO skill_state(skill_id,status,active_version,updated_at,updated_by) VALUES(?, 'active', ?, ?, 'system')").run(id, top, now);
    db.prepare("UPDATE skill_versions SET status='active' WHERE skill_id=? AND version=?").run(id, top);
  }
}
export type State = { status: 'active' | 'disabled'; active_version: string };
export const stateOf = (db: DB, id: string) => { sync(db); return db.prepare('SELECT status, active_version FROM skill_state WHERE skill_id=?').get(id) as State | undefined; };
export function resolve(db: DB, id: string): { entry: Entry; state: State } | null {
  const st = stateOf(db, id); if (!st) return null; const entry = versionsOf(id).find((e) => e.manifest.version === st.active_version); return entry ? { entry, state: st } : null;
}

export type Access = { allowed: boolean; via?: 'grant' | 'auto' | 'human'; reasons: string[] };
/** Everything that decides whether `principal` may use `skillId`. Pure reads; the reasons are what the Skills page shows. */
export function access(db: DB, principal: string, skillId: string): Access {
  const r = resolve(db, skillId); if (!r) return { allowed: false, reasons: ['no such skill'] };
  const m = r.entry.manifest, why: string[] = [];
  if (r.state.status !== 'active') why.push('switched off');
  const tier = tierOf(m); if (tier >= 3) why.push(`tier ${tier}: can only ever be an approval request, never run by an agent`);
  const human = principal === 'luke-test';
  const ceil = human ? PRINCIPALS.jarvis : isPrincipal(principal) ? PRINCIPALS[principal] : null;
  if (!ceil) return { allowed: false, reasons: ['unknown agent'] };
  const missing = m.permissions.filter((p) => !(ceil.capabilities as string[]).includes(p)); if (missing.length) why.push(`${human ? 'test runs' : PRINCIPALS[principal as 'jarvis'].label} cannot hold: ${missing.join(', ')}`);
  if (SENS_RANK[m.dataSensitivity] > SENS_RANK[ceil.maxSensitivity]) why.push(`handles ${m.dataSensitivity} data, above this agent's ${ceil.maxSensitivity} ceiling`);
  if (why.length) return { allowed: false, reasons: why };
  if (human) return { allowed: true, via: 'human', reasons: [] };
  if (db.prepare('SELECT 1 FROM skill_grants WHERE principal=? AND skill_id=?').get(principal, skillId)) return { allowed: true, via: 'grant', reasons: [] };
  if (m.autoShare && tier === 0 && m.sideEffects === 'none' && m.dataSensitivity === 'public' && m.cost.perCallMicroUsd === 0) return { allowed: true, via: 'auto', reasons: [] };
  return { allowed: false, reasons: ['not granted to this agent'] };
}

export function grant(db: DB, principal: string, skillId: string, by: string, now = Date.now()) {
  if (by !== 'luke') throw new Error('Only you can grant a skill.');
  if (!isPrincipal(principal)) throw new Error('unknown agent');
  const r = resolve(db, skillId); if (!r) throw new Error('no such skill');
  const m = r.entry.manifest, ceil = PRINCIPALS[principal];
  if (tierOf(m) >= 3) throw new Error('Skills that send, spend, delete or widen access can never be granted to an agent.');
  const missing = m.permissions.filter((p) => !(ceil.capabilities as string[]).includes(p)); if (missing.length) throw new Error(`${ceil.label} can never hold: ${missing.join(', ')}`);
  if (SENS_RANK[m.dataSensitivity] > SENS_RANK[ceil.maxSensitivity]) throw new Error(`${ceil.label} may not use skills that handle ${m.dataSensitivity} data.`);
  db.prepare('INSERT OR REPLACE INTO skill_grants(principal,skill_id,granted_at,granted_by) VALUES(?,?,?,?)').run(principal, skillId, now, by); audit(db, by, 'skill.granted', skillId, { principal });
}
export function revoke(db: DB, principal: string, skillId: string) { const r = db.prepare('DELETE FROM skill_grants WHERE principal=? AND skill_id=?').run(principal, skillId); if (r.changes) audit(db, 'luke', 'skill.revoked', skillId, { principal }); return Number(r.changes) > 0; }
export function setStatus(db: DB, skillId: string, status: 'active' | 'disabled', now = Date.now()) {
  if (!stateOf(db, skillId)) throw new Error('no such skill'); db.prepare('UPDATE skill_state SET status=?, updated_at=?, updated_by=? WHERE skill_id=?').run(status, now, 'luke', skillId); audit(db, 'luke', status === 'active' ? 'skill.enabled' : 'skill.disabled', skillId);
}
/** Make a specific registered version the live one. Going to an older version is a rollback and is recorded as such. */
export function activate(db: DB, skillId: string, version: string, now = Date.now()) {
  const st = stateOf(db, skillId); if (!st) throw new Error('no such skill'); if (!versionsOf(skillId).some((e) => e.manifest.version === version)) throw new Error('that version is not in the codebase');
  if (version === st.active_version) return { rolledBack: false };
  const back = semverCmp(version, st.active_version) < 0;
  db.prepare("UPDATE skill_versions SET status=? WHERE skill_id=? AND version=?").run(back ? 'rolled_back' : 'superseded', skillId, st.active_version);
  db.prepare("UPDATE skill_versions SET status='active' WHERE skill_id=? AND version=?").run(skillId, version);
  db.prepare('UPDATE skill_state SET active_version=?, updated_at=?, updated_by=? WHERE skill_id=?').run(version, now, 'luke', skillId);
  audit(db, 'luke', back ? 'skill.rolled_back' : 'skill.activated', skillId, { from: st.active_version, to: version }); return { rolledBack: back };
}

export type Invoked = { ok: true; result: unknown; version: string; untrusted: boolean; ms: number } | { ok: false; refused: string };
const logRun = (db: DB, skillId: string, version: string, principal: string, ok: boolean, ms: number, input: unknown, error: string | null, refused: string | null, cost = 0, now = Date.now()) =>
  db.prepare('INSERT INTO skill_runs(skill_id,version,principal,at,ok,ms,cost_micro_usd,error,input_sha256,refused) VALUES(?,?,?,?,?,?,?,?,?,?)').run(skillId, version, principal, now, ok ? 1 : 0, ms, cost, error?.slice(0, 200) ?? null, sha(input ?? null), refused);
/** The only way agent code runs a registry skill. `principal` comes from server code (never from a model or a request body). */
export async function invoke(db: DB, principal: string, skillId: string, rawInput: unknown, now = Date.now()): Promise<Invoked> {
  const r = resolve(db, skillId); const refuse = (why: string): Invoked => { logRun(db, skillId, r?.state.active_version ?? '-', principal, false, 0, rawInput, null, why, 0, now); return { ok: false, refused: why }; };
  if (!r) return { ok: false, refused: 'no such skill' };
  if (isPaused(db)) return refuse('Jarvis is paused');
  const m = r.entry.manifest; if (m.runPath !== 'direct' || !r.entry.run) return refuse(`this skill runs through its own path (${m.runPath}), not the registry`);
  const a = access(db, principal, skillId); if (!a.allowed) return refuse(a.reasons.join('; '));
  let input: unknown = rawInput ?? {}; if (r.entry.input) { const p = r.entry.input.safeParse(rawInput ?? {}); if (!p.success) return refuse(`invalid input: ${p.error.issues[0]?.message ?? 'bad'}`); input = p.data; }
  const t0 = Date.now();
  try {
    const result = await r.entry.run(input, { db, principal, now });
    const size = JSON.stringify(result ?? null).length; if (size > 100_000) throw new Error('result too large');
    const ms = Date.now() - t0; logRun(db, skillId, m.version, principal, true, ms, input, null, null, 0, now); return { ok: true, result, version: m.version, untrusted: m.untrustedOutput, ms };
  } catch (e) { const ms = Date.now() - t0; logRun(db, skillId, m.version, principal, false, ms, input, (e as Error).message, null, 0, now); return { ok: false, refused: `failed: ${(e as Error).message.slice(0, 120)}` }; }
}

export function stats(db: DB, skillId: string) {
  const s = db.prepare('SELECT COUNT(*) runs, COALESCE(SUM(ok),0) oks, COALESCE(AVG(CASE WHEN ok=1 THEN ms END),0) avg_ms, MAX(at) last_at, COALESCE(SUM(CASE WHEN refused IS NOT NULL THEN 1 ELSE 0 END),0) refused FROM skill_runs WHERE skill_id=?').get(skillId) as any;
  return { runs: Number(s.runs), ok: Number(s.oks), refused: Number(s.refused), avgMs: Math.round(s.avg_ms), lastAt: s.last_at as number | null };
}
export function summary(db: DB, now = Date.now()) {
  sync(db);
  return ids().map((id) => {
    const r = resolve(db, id)!, m = r.entry.manifest, versions = versionsOf(id).map((e) => e.manifest.version);
    const grants = (db.prepare('SELECT principal FROM skill_grants WHERE skill_id=?').all(id) as { principal: string }[]).map((g) => g.principal);
    const matrix: Record<string, { allowed: boolean; via?: string; reasons: string[] }> = {}; for (const p of Object.keys(PRINCIPALS)) matrix[p] = access(db, p, id);
    return { id, title: m.title, purpose: m.purpose, owner: m.owner, version: m.version, versions, status: r.state.status, tier: tierOf(m), permissions: m.permissions, sideEffects: m.sideEffects, dataSensitivity: m.dataSensitivity, untrustedOutput: m.untrustedOutput, trust: m.trust, runPath: m.runPath, cost: m.cost, externalServices: m.externalServices, legacyKey: m.legacyKey ?? null, modelProposable: m.modelProposable, standingEligible: m.standingEligible, autoShare: m.autoShare, tests: m.tests, docs: m.docs, outputDescription: m.outputDescription, grants, access: matrix, stats: stats(db, id), testable: m.runPath === 'direct' && tierOf(m) === 0 };
  });
}
export function detail(db: DB, id: string) {
  sync(db); const r = resolve(db, id); if (!r) return null; const e = r.entry;
  let schema: unknown = null; try { schema = e.input ? z.toJSONSchema(e.input) : { type: 'object', properties: {} }; } catch { schema = null; }
  return { manifest: e.manifest, inputSchema: schema, versions: (db.prepare('SELECT version,status,registered_at FROM skill_versions WHERE skill_id=? ORDER BY registered_at').all(id) as any[]), history: (db.prepare("SELECT at,actor,action,detail FROM audit WHERE action LIKE 'skill.%' AND target=? ORDER BY id DESC LIMIT 30").all(id) as any[]),
    recentRuns: (db.prepare('SELECT at,principal,ok,ms,error,refused FROM skill_runs WHERE skill_id=? ORDER BY id DESC LIMIT 15').all(id) as any[]) };
}
