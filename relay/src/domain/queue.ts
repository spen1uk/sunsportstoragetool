import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { config } from '../config.js';

export async function enqueue(db: Db, kind: string, payload: object, opts: { runAt?: Date; workspaceId?: string; dedupeKey?: string; maxAttempts?: number } = {}) {
  const r = await db.query(
    `INSERT INTO jobs (workspace_id, kind, payload, run_at, dedupe_key, max_attempts) VALUES ($1,$2,$3,COALESCE($4, now()),$5,COALESCE($6,5))
     ON CONFLICT (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running') DO NOTHING RETURNING id`,
    [opts.workspaceId ?? null, kind, JSON.stringify(payload), opts.runAt ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? null],
  );
  return r.rows[0]?.id as number | undefined;
}

export type Job = { id: number; kind: string; payload: any; attempts: number; max_attempts: number; workspace_id: string | null };
export type Handler = (job: Job) => Promise<void>;
/** Thrown by handlers when the failure is terminal (do not retry). */
export class PermanentJobError extends Error {}


/** Claim one due job (also reclaims jobs whose lease expired after a worker crash). */
export async function claim(): Promise<Job | null> {
  const r = await pool.query(
    `UPDATE jobs SET status='running', attempts=attempts+1, locked_until=now()+($1||' seconds')::interval
     WHERE id = (SELECT id FROM jobs WHERE (status='pending' AND run_at<=now()) OR (status='running' AND locked_until<now())
                 ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, kind, payload, attempts, max_attempts, workspace_id`, [config.jobLeaseSeconds]);
  return r.rows[0] ?? null;
}

/** Run at most one job; returns true if one was processed. */
export async function runOne(handlers: Record<string, Handler>): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  try {
    const h = handlers[job.kind];
    if (!h) throw new PermanentJobError(`no handler for ${job.kind}`);
    await h(job);
    await pool.query(`UPDATE jobs SET status='done', finished_at=now(), locked_until=NULL WHERE id=$1`, [job.id]);
  } catch (e) {
    const msg = (e as Error).message;
    const terminal = e instanceof PermanentJobError || job.attempts >= job.max_attempts;
    if (terminal) await pool.query(`UPDATE jobs SET status='failed', last_error=$2, finished_at=now(), locked_until=NULL WHERE id=$1`, [job.id, msg]);
    else await pool.query(`UPDATE jobs SET status='pending', last_error=$2, locked_until=NULL, run_at=now()+(($3)||' seconds')::interval WHERE id=$1`, [job.id, msg, Math.min(2 ** job.attempts * 5, 600)]);
  }
  return true;
}
