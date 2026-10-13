import type { Db } from '../db/pool.js';

/** Realtime fan-out: NOTIFY on a single channel; SSE servers LISTEN and filter by workspace. Payload is metadata only (no message bodies). */
export async function publish(db: Db, workspaceId: string, type: string, data: Record<string, unknown> = {}) {
  await db.query('SELECT pg_notify($1, $2)', ['relay_events', JSON.stringify({ workspaceId, type, data })]);
}

export async function audit(db: Db, a: { workspaceId?: string | null; actorUserId?: string | null; actorType?: string; action: string; targetType?: string; targetId?: string; meta?: object; ip?: string }) {
  await db.query(
    `INSERT INTO audit_events (workspace_id, actor_user_id, actor_type, action, target_type, target_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.workspaceId ?? null, a.actorUserId ?? null, a.actorType ?? 'user', a.action, a.targetType ?? null, a.targetId ?? null, JSON.stringify(a.meta ?? {}), a.ip ?? null],
  );
}
