import { type DB, tx, id, now } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { isPaused } from './pause.ts';
import { config } from './config.ts';

export type TaskRow = {
  id: string; project_id: string | null; title: string; description: string; kind: 'manual' | 'research' | 'revision'; state: string;
  priority: number; owner: string; requires: 'cloud' | 'mac'; optional_work: number; input: string; lease_owner: string | null;
  lease_expires_at: number | null; attempts: number; max_attempts: number; next_run_at: number; waiting_reason: string | null;
  last_error: string | null; is_demo: number; version: number; completion_evidence: string | null; created_at: string; updated_at: string; completed_at: string | null;
};

export function logEvent(db: DB, taskId: string, kind: string, detail = '') {
  db.prepare('INSERT INTO task_events(task_id,at,kind,detail) VALUES(?,?,?,?)').run(taskId, now(), kind, detail);
}

export function createTask(db: DB, t: {
  title: string; description?: string; kind?: TaskRow['kind']; projectId?: string | null; priority?: number; owner?: string;
  requires?: 'cloud' | 'mac'; input?: object; idempotencyKey?: string; isDemo?: boolean; optional?: boolean;
}): string {
  if (t.idempotencyKey) {
    const ex = db.prepare('SELECT id FROM tasks WHERE idempotency_key=?').get(t.idempotencyKey) as { id: string } | undefined;
    if (ex) return ex.id;
  }
  const tid = id(), ts = now(), kind = t.kind ?? 'manual';
  db.prepare(`INSERT INTO tasks(id,project_id,title,description,kind,state,priority,owner,requires,optional_work,input,idempotency_key,is_demo,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tid, t.projectId ?? null, t.title.slice(0, 200), (t.description ?? '').slice(0, 4000), kind,
    'ready', t.priority ?? 3, t.owner ?? (kind === 'manual' ? 'luke' : 'jarvis'), t.requires ?? 'cloud', t.optional ? 1 : 0,
    JSON.stringify(t.input ?? {}), t.idempotencyKey ?? null, t.isDemo ? 1 : 0, ts, ts);
  logEvent(db, tid, 'created', `${kind} task`);
  audit(db, 'luke', 'task.created', tid, { kind, title: t.title });
  publish({ type: 'tasks' });
  return tid;
}

export function setState(db: DB, taskId: string, state: string, extra: { reason?: string | null; error?: string | null; nextRunAt?: number } = {}) {
  db.prepare(`UPDATE tasks SET state=?, waiting_reason=?, last_error=COALESCE(?, last_error), next_run_at=COALESCE(?, next_run_at),
              lease_owner=NULL, lease_expires_at=NULL, version=version+1, updated_at=? WHERE id=?`)
    .run(state, extra.reason ?? null, extra.error ?? null, extra.nextRunAt ?? null, now(), taskId);
  logEvent(db, taskId, `state:${state}`, extra.reason ?? extra.error ?? '');
  publish({ type: 'tasks' });
}

/**
 * Luke checks a task off, or an artifact acceptance supplies evidence. A calendar block ending is NOT evidence and has no code path here.
 */
export function completeTask(db: DB, taskId: string, completedBy: string, evidence: string) {
  const r = db.prepare("UPDATE tasks SET state='completed', completed_at=?, completion_evidence=?, waiting_reason=NULL, lease_owner=NULL, lease_expires_at=NULL, version=version+1, updated_at=? WHERE id=? AND state NOT IN ('completed','canceled')")
    .run(now(), `${completedBy}: ${evidence}`, now(), taskId);
  if (r.changes) { logEvent(db, taskId, 'completed', evidence); audit(db, completedBy, 'task.completed', taskId, { evidence }); publish({ type: 'tasks' }); }
  return !!r.changes;
}

export function reopenTask(db: DB, taskId: string) {
  const r = db.prepare("UPDATE tasks SET state='ready', completed_at=NULL, completion_evidence=NULL, version=version+1, updated_at=? WHERE id=? AND state='completed' AND kind='manual'").run(now(), taskId);
  if (r.changes) { logEvent(db, taskId, 'reopened'); publish({ type: 'tasks' }); }
}

export function cancelTask(db: DB, taskId: string) {
  const r = db.prepare("UPDATE tasks SET state='canceled', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND state NOT IN ('completed','canceled')").run(now(), taskId);
  if (r.changes) { logEvent(db, taskId, 'canceled'); audit(db, 'luke', 'task.canceled', taskId); publish({ type: 'tasks' }); }
}

/** Requeue running tasks whose lease expired (worker crash/restart). Bounded by max_attempts with exponential backoff. */
export function recoverExpired(db: DB) {
  const rows = db.prepare("SELECT id, attempts, max_attempts FROM tasks WHERE state='running' AND lease_expires_at < ?").all(Date.now()) as any[];
  for (const r of rows) {
    if (r.attempts >= r.max_attempts) setState(db, r.id, 'failed', { error: 'worker lost; attempts exhausted' });
    else setState(db, r.id, 'ready', { reason: 'recovered after worker loss', nextRunAt: Date.now() + 2000 * 2 ** r.attempts });
  }
  return rows.length;
}

/** Atomically lease the next runnable cloud task. Paused system or an offline Mac never yields work. */
export function claimNext(db: DB, workerId: string): TaskRow | null {
  if (isPaused(db)) return null;
  recoverExpired(db);
  return tx(db, () => {
    const t = db.prepare(`SELECT * FROM tasks WHERE state='ready' AND requires='cloud' AND kind IN ('research','revision') AND next_run_at <= ?
                          ORDER BY priority ASC, created_at ASC LIMIT 1`).get(Date.now()) as TaskRow | undefined;
    if (!t) return null;
    db.prepare("UPDATE tasks SET state='running', lease_owner=?, lease_expires_at=?, attempts=attempts+1, version=version+1, updated_at=? WHERE id=?")
      .run(workerId, Date.now() + config.leaseMs, now(), t.id);
    logEvent(db, t.id, 'claimed', workerId);
    publish({ type: 'tasks' });
    return { ...t, state: 'running', attempts: t.attempts + 1 };
  });
}

export function heartbeat(db: DB, taskId: string, workerId: string) {
  db.prepare("UPDATE tasks SET lease_expires_at=? WHERE id=? AND lease_owner=? AND state='running'").run(Date.now() + config.leaseMs, taskId, workerId);
}

/** Failure handling: bounded retries with backoff; the last error and attempt count stay visible. */
export function failOrRetry(db: DB, t: TaskRow, error: string) {
  if (t.attempts >= t.max_attempts) setState(db, t.id, 'failed', { error });
  else setState(db, t.id, 'ready', { error, reason: `retry after: ${error}`, nextRunAt: Date.now() + 2000 * 2 ** t.attempts });
}

export function resumeForApproval(db: DB, approvalId: string, approved: boolean) {
  const rows = db.prepare("SELECT id FROM tasks WHERE state='waiting_approval' AND waiting_reason=?").all(`approval:${approvalId}`) as { id: string }[];
  for (const r of rows) {
    if (approved) setState(db, r.id, 'ready'); else setState(db, r.id, 'waiting_input', { reason: 'Approval was denied. Edit the sources or cancel.' });
  }
}
