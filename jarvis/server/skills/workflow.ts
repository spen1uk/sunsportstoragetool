import { z } from 'zod';
import { type DB, id } from '../db.ts';
import { audit } from '../audit.ts';
import { resolve, access, invoke, sync } from './registry.ts';
import { tierOf, SENS_RANK, EFFECT_RANK, SENSITIVITY, SIDE_EFFECTS, type Capability } from './manifest.ts';

/**
 * Workflows: a saved chain of registry skills. Combining skills can never loosen anything:
 *  - the workflow's permissions are the UNION of what its steps need, its tier/side effects/data sensitivity the HIGHEST of its steps,
 *    and whoever runs it must be allowed to use EVERY step (so a workflow cannot reach something its owner could not);
 *  - data from an untrusted source (web) may only flow into steps that have no side effects;
 *  - a chain containing any step that is not a plain read/compute registry skill (tier 3+, or another run path) is saved but cannot be run by the workflow runner;
 *  - an agent may only stage a workflow; Luke activates it (with step-up, in the HTTP layer), and it is re-checked against the live skills on every run.
 */
const ref = z.object({ $step: z.number().int().min(0).max(7), path: z.string().max(60).regex(/^[A-Za-z0-9_.]*$/).default('') }).strict();
export const stepSchema = z.object({ skill: z.string().max(60), input: z.record(z.string().max(40), z.union([z.string().max(2000), z.number(), z.boolean(), ref])).default({}) }).strict();
export const stepsSchema = z.array(stepSchema).min(1).max(8);
export type Step = z.infer<typeof stepSchema>;

export type Effective = { permissions: Capability[]; tier: number; sideEffects: string; dataSensitivity: string; untrusted: boolean; runnable: boolean };
export function validate(db: DB, stepsRaw: unknown, principal?: string): { ok: boolean; violations: string[]; effective: Effective | null } {
  sync(db); const p = stepsSchema.safeParse(stepsRaw); if (!p.success) return { ok: false, violations: [`invalid steps: ${p.error.issues[0]?.message}`], effective: null };
  const steps = p.data, violations: string[] = [], perms = new Set<Capability>(); let tier = 0, eff = 0, sens = 0, untrusted = false, runnable = true;
  const ms = steps.map((s, i) => { const r = resolve(db, s.skill); if (!r) { violations.push(`step ${i + 1}: no such skill "${s.skill}"`); return null; } return r.entry.manifest; });
  steps.forEach((s, i) => {
    const m = ms[i]; if (!m) return;
    m.permissions.forEach((x) => perms.add(x)); tier = Math.max(tier, tierOf(m)); eff = Math.max(eff, EFFECT_RANK[m.sideEffects]); sens = Math.max(sens, SENS_RANK[m.dataSensitivity]); if (m.untrustedOutput) untrusted = true;
    if (m.runPath !== 'direct' || tierOf(m) >= 3) runnable = false;
    if (principal) { const a = access(db, principal, s.skill); if (!a.allowed && m.runPath === 'direct') violations.push(`step ${i + 1} (${s.skill}): ${principal} may not use it (${a.reasons.join('; ')})`); }
    for (const v of Object.values(s.input)) if (typeof v === 'object' && v) {
      if (v.$step >= i) { violations.push(`step ${i + 1}: can only use the output of an EARLIER step`); continue; }
      const src = ms[v.$step]; if (src?.untrustedOutput && m.sideEffects !== 'none') violations.push(`step ${i + 1} (${s.skill}): output from the web (step ${v.$step + 1}) cannot feed a skill that has side effects`);
    }
  });
  const effective: Effective = { permissions: [...perms], tier, sideEffects: SIDE_EFFECTS[eff], dataSensitivity: SENSITIVITY[sens], untrusted, runnable };
  return { ok: violations.length === 0, violations, effective };
}

export function save(db: DB, name: string, stepsRaw: unknown, by: string, now = Date.now()) {
  const n = String(name).trim(); if (!/^[A-Za-z0-9 _-]{3,50}$/.test(n)) throw new Error('A workflow name needs 3 to 50 letters, numbers, spaces, - or _.');
  const v = validate(db, stepsRaw); if (!v.ok) throw new Error(v.violations.join(' ')); if ((db.prepare('SELECT COUNT(*) c FROM skill_workflows').get() as any).c >= 50) throw new Error('You can keep up to 50 workflows.');
  const wid = id(); db.prepare("INSERT INTO skill_workflows(id,name,steps,effective,status,created_by,created_at) VALUES(?,?,?,?, 'staged', ?, ?)").run(wid, n, JSON.stringify(stepsSchema.parse(stepsRaw)), JSON.stringify(v.effective), by, now);
  audit(db, by, 'skill.workflow_saved', wid, { name: n, tier: v.effective!.tier }); return wid;
}
export const list = (db: DB) => (db.prepare('SELECT * FROM skill_workflows ORDER BY created_at DESC LIMIT 50').all() as any[]).map((w) => ({ id: w.id, name: w.name, status: w.status, createdBy: w.created_by, createdAt: w.created_at, steps: JSON.parse(w.steps), effective: JSON.parse(w.effective) }));
export function setStatus(db: DB, wid: string, status: 'active' | 'disabled' | 'staged', by: string, now = Date.now()) {
  if (status === 'active' && by !== 'luke') throw new Error('Only you can activate a workflow.');
  const w = db.prepare('SELECT steps FROM skill_workflows WHERE id=?').get(wid) as { steps: string } | undefined; if (!w) throw new Error('no such workflow');
  if (status === 'active') { const v = validate(db, JSON.parse(w.steps)); if (!v.ok) throw new Error(`It no longer passes the checks: ${v.violations.join(' ')}`); }
  db.prepare('UPDATE skill_workflows SET status=?, activated_at=? WHERE id=?').run(status, status === 'active' ? now : null, wid); audit(db, by, `skill.workflow_${status}`, wid);
}
export const remove = (db: DB, wid: string) => { const r = db.prepare('DELETE FROM skill_workflows WHERE id=?').run(wid); if (r.changes) audit(db, 'luke', 'skill.workflow_removed', wid); return Number(r.changes) > 0; };

const dig = (o: unknown, path: string) => path ? path.split('.').reduce<any>((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o) : o;
export async function run(db: DB, principal: string, wid: string, now = Date.now()): Promise<{ ok: true; outputs: unknown[] } | { ok: false; error: string; outputs: unknown[] }> {
  const w = db.prepare('SELECT steps, status FROM skill_workflows WHERE id=?').get(wid) as { steps: string; status: string } | undefined;
  if (!w) return { ok: false, error: 'no such workflow', outputs: [] }; if (w.status !== 'active') return { ok: false, error: 'this workflow is not active', outputs: [] };
  const parsed = stepsSchema.safeParse(JSON.parse(w.steps)); if (!parsed.success) return { ok: false, error: `the saved steps are not valid: ${parsed.error.issues[0]?.message}`, outputs: [] };
  const logged = (r: { ok: true; outputs: unknown[] } | { ok: false; error: string; outputs: unknown[] }) => { db.prepare('INSERT INTO workflow_runs(workflow_id,principal,at,ok,error) VALUES(?,?,?,?,?)').run(wid, principal, now, r.ok ? 1 : 0, r.ok ? null : r.error.slice(0, 200)); return r; };
  const steps = parsed.data, v = validate(db, steps, principal);   // re-checked against the live skills, versions and grants every run
  if (!v.ok) return logged({ ok: false, error: v.violations.join(' '), outputs: [] }); if (!v.effective!.runnable) return logged({ ok: false, error: 'this chain includes steps that are not plain registry skills (or need approval), so the runner will not execute it', outputs: [] });
  const outputs: unknown[] = [];
  for (const [i, s] of steps.entries()) {
    const input: Record<string, unknown> = {}; for (const [k, val] of Object.entries(s.input)) input[k] = typeof val === 'object' && val ? dig(outputs[val.$step], val.path) : val;
    const r = await invoke(db, principal, s.skill, input, now); if (!r.ok) return logged({ ok: false, error: `step ${i + 1} (${s.skill}): ${r.refused}`, outputs });
    outputs.push(r.result);
  }
  return logged({ ok: true, outputs });
}
