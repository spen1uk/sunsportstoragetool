import { type DB, getMeta, setMeta } from '../db.ts';
import { audit } from '../audit.ts';
import { publish } from '../events.ts';
import * as workflow from '../skills/workflow.ts';
import { get, event, generate, MAX_OPEN } from './candidates.ts';
import { evaluate } from './sandbox.ts';
import { scan, list as listGaps } from './gaps.ts';

/**
 * Staged rollout. Nothing here promotes itself:
 *   proposed → (sandbox checks) → passed → staged (a saved but switched-off workflow) → active (only Luke, with step-up, after the checks are re-run)
 * and a rollout is watched: if the live workflow starts failing, it is switched off automatically (taking away power needs no approval)
 * and the workflow it replaced, which Luke had already approved, is switched back on.
 */
export const MIN_RUNS = 3, FAIL_RATE = 0.34, WATCH_DAYS = 14;

export function stage(db: DB, iid: string, now = Date.now()) {
  const imp = get(db, iid); if (!imp || imp.kind !== 'workflow') throw new Error('Only a workflow can be staged.'); if (imp.status !== 'passed') throw new Error('It has to pass its checks first.');
  const wid = workflow.save(db, `${imp.title} (improvement)`.slice(0, 50).replace(/[^A-Za-z0-9 _-]/g, ''), imp.spec.steps, 'jarvis', now);
  db.prepare("UPDATE improvements SET status='staged', workflow_id=?, updated_at=? WHERE id=?").run(wid, now, iid); event(db, iid, 'staged', wid); audit(db, 'luke', 'improve.staged', iid, { workflow: wid }); publish({ type: 'improve' }); return get(db, iid);
}
/** Only Luke, and the HTTP layer demands a fresh step-up. The checks are run again first: things may have changed since the first time. */
export async function promote(db: DB, iid: string, now = Date.now()) {
  const imp = get(db, iid); if (!imp || imp.status !== 'staged' || !imp.workflow_id) throw new Error('Stage it first.');
  const rep = await evaluate(db, iid, now); if (!rep.passed) throw new Error(`It no longer passes its checks (${rep.checks.filter((c) => !c.passed).map((c) => c.title).join('; ')}), so it was not switched on.`);
  const old = imp.replaces_workflow_id ? (db.prepare("SELECT id,status FROM skill_workflows WHERE id=?").get(imp.replaces_workflow_id) as { id: string; status: string } | undefined) : undefined;
  const wasActive = old?.status === 'active';
  workflow.setStatus(db, imp.workflow_id, 'active', 'luke', now);
  if (old && wasActive) db.prepare("UPDATE skill_workflows SET status='disabled' WHERE id=?").run(old.id);
  db.prepare("UPDATE improvements SET status='active', promoted_at=?, updated_at=?, spec=? WHERE id=?").run(now, now, JSON.stringify({ ...imp.spec, restoreWorkflowId: wasActive ? old!.id : null }), iid);
  event(db, iid, 'promoted', wasActive ? 'replaced the earlier workflow, which can be restored' : ''); audit(db, 'luke', 'improve.promoted', iid, { workflow: imp.workflow_id, replaced: wasActive ? old!.id : null }); publish({ type: 'improve' }); return get(db, iid);
}
function back(db: DB, iid: string, by: 'luke' | 'system', why: string, now: number) {
  const imp = get(db, iid); if (!imp || imp.status !== 'active') throw new Error('It is not switched on.');
  if (imp.workflow_id) db.prepare("UPDATE skill_workflows SET status='disabled' WHERE id=?").run(imp.workflow_id);
  const rid = imp.spec.restoreWorkflowId as string | null | undefined; let restored = false;
  if (rid) { const o = db.prepare('SELECT steps FROM skill_workflows WHERE id=?').get(rid) as { steps: string } | undefined; if (o && workflow.validate(db, JSON.parse(o.steps)).ok) { db.prepare("UPDATE skill_workflows SET status='active' WHERE id=?").run(rid); restored = true; } }
  db.prepare("UPDATE improvements SET status='rolled_back', updated_at=? WHERE id=?").run(now, iid); event(db, iid, 'rolled_back', `${why}${restored ? '; the earlier workflow is back on' : ''}`);
  audit(db, by, 'improve.rolled_back', iid, { why, restored }); publish({ type: 'improve' }); return { restored };
}
export const rollback = (db: DB, iid: string, now = Date.now()) => back(db, iid, 'luke', 'rolled back by you', now);

/** Called from the 30-second tick. A rollout that fails too often is switched off at once. */
export function monitor(db: DB, now = Date.now()): string[] {
  const done: string[] = [];
  for (const imp of (db.prepare("SELECT id FROM improvements WHERE status='active'").all() as { id: string }[])) {
    const i = get(db, imp.id); if (!i?.workflow_id || !i.promoted_at) continue;
    const r = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END),0) f FROM workflow_runs WHERE workflow_id=? AND at>=? AND at>?').get(i.workflow_id, i.promoted_at, now - WATCH_DAYS * 86_400_000) as { c: number; f: number };
    if (Number(r.c) >= MIN_RUNS && Number(r.f) / Number(r.c) > FAIL_RATE) { back(db, imp.id, 'system', `switched off automatically: ${r.f} of ${r.c} runs failed`, now); done.push(imp.id); }
  }
  return done;
}

// ---- the daily rhythm: look for gaps; optionally (off by default) draft one fix a week ----
const K_AUTO = 'improve:auto', K_LAST_SCAN = 'improve:last_scan', K_LAST_DRAFT = 'improve:last_draft';
export const autoDraft = (db: DB) => getMeta(db, K_AUTO) === '1';
export function setAutoDraft(db: DB, on: boolean) { setMeta(db, K_AUTO, on ? '1' : '0'); audit(db, 'luke', 'improve.auto', '', { on }); publish({ type: 'improve' }); }
export async function daily(db: DB, now = Date.now()) {
  if (Number(getMeta(db, K_LAST_SCAN) ?? 0) > now - 86_400_000) return null; setMeta(db, K_LAST_SCAN, String(now)); const found = scan(db, now);
  let drafted: string | null = null;
  if (autoDraft(db) && Number(getMeta(db, K_LAST_DRAFT) ?? 0) < now - 7 * 86_400_000) {
    const open = (db.prepare("SELECT COUNT(*) c FROM improvements WHERE status IN ('proposed','passed','staged','active')").get() as any).c;
    const gap = open < MAX_OPEN ? listGaps(db).find((g) => g.status === 'open' && g.severity >= 2 && !db.prepare('SELECT 1 FROM improvements WHERE gap_id=?').get(g.id)) : undefined;
    if (gap) { setMeta(db, K_LAST_DRAFT, String(now)); try { const imp = await generate(db, gap.id, { by: 'prometheus', now }); if (imp) { await evaluate(db, imp.id, now); drafted = imp.id; } } catch { /* try again next week */ } }
  }
  return { found, drafted };
}
export function briefingItems(db: DB) {
  const items: { text: string; link: string }[] = [];
  const ready = (db.prepare("SELECT COUNT(*) c FROM improvements WHERE status='passed'").get() as any).c; if (ready) items.push({ text: `${ready} tested improvement${ready === 1 ? ' is' : 's are'} waiting for your decision.`, link: '#/improve' });
  for (const r of db.prepare("SELECT title FROM improvements WHERE status='rolled_back' AND updated_at>?").all(Date.now() - 2 * 86_400_000) as { title: string }[]) items.push({ text: `An improvement was switched off: ${r.title}.`, link: '#/improve' });
  return items;
}
