import type { DB } from './db.ts';
import { claimNext, failOrRetry, heartbeat, setState, logEvent } from './tasks.ts';
import { reserve, settle, releaseReservation } from './budget.ts';
import { runResearch, runRevision, type Deps } from './research.ts';
import { audit } from './audit.ts';
import { bus } from './events.ts';

const EST_MICRO_USD = { research: 2_000, revision: 500 } as const; // conservative nominal estimate (egress/compute); no model spend yet

/** Process at most one task. Returns true if work was attempted. */
export async function tick(db: DB, workerId: string, deps: Deps = {}): Promise<boolean> {
  const task = claimNext(db, workerId);
  if (!task) return false;
  const est = EST_MICRO_USD[task.kind as 'research' | 'revision'] ?? 0;
  const res = reserve(db, est, `task:${task.kind}`, { optional: !!task.optional_work, ref: task.id });
  if (!res.ok) { setState(db, task.id, 'waiting_input', { reason: `Budget: ${res.reason}` }); audit(db, 'system', 'budget.blocked', task.id, { reason: res.reason }); return true; }
  const hb = setInterval(() => heartbeat(db, task.id, workerId), 15_000);
  try {
    if (task.kind === 'research') await runResearch(db, task, deps);
    else if (task.kind === 'revision') runRevision(db, task);
    settle(db, res.id, est);
  } catch (e) {
    releaseReservation(db, res.id);
    const msg = (e as Error).message;
    logEvent(db, task.id, 'error', msg);
    failOrRetry(db, task, msg);
  } finally { clearInterval(hb); }
  return true;
}

export function startWorker(db: DB, workerId = `worker-${process.pid}`, deps: Deps = {}) {
  let stopped = false, busy = false;
  const loop = async () => {
    if (busy || stopped) return; busy = true;
    try { while (!stopped && (await tick(db, workerId, deps))) { /* drain */ } } finally { busy = false; }
  };
  const iv = setInterval(loop, 3000);
  const onEvent = (e: { type: string }) => { if (e.type === 'tasks') void loop(); };
  bus.on('event', onEvent);
  void loop();
  return () => { stopped = true; clearInterval(iv); bus.off('event', onEvent); };
}
