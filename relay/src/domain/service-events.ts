import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { visibilitySql } from './authz.js';
import { enqueue } from './queue.js';
import type { ServiceContext } from './service-identities.js';

/**
 * Append to the workspace event log read by assistant identities. Metadata only (ids, revision, status) — never message text.
 * Written in the caller's transaction so an event exists iff the change committed. No-ops when the workspace has no assistant identity.
 */
export async function emitServiceEvent(db: Db, workspaceId: string, type: string, e: { conversationId?: string | null; contactId?: string | null; payload?: Record<string, unknown> } = {}) {
  const has = await db.query(`SELECT 1 FROM service_identities WHERE workspace_id=$1 AND status='active' LIMIT 1`, [workspaceId]);
  if (!has.rowCount) return;
  const rev = e.conversationId ? (await db.query('SELECT revision FROM conversations WHERE id=$1', [e.conversationId])).rows[0]?.revision ?? null : null;
  await db.query(`INSERT INTO service_events (workspace_id, type, conversation_id, contact_id, revision, payload) VALUES ($1,$2,$3,$4,$5,$6)`,
    [workspaceId, type, e.conversationId ?? null, e.contactId ?? null, rev, JSON.stringify(e.payload ?? {})]);
  const hooks = await db.query(`SELECT id FROM service_identities WHERE workspace_id=$1 AND status='active' AND webhook_url IS NOT NULL AND 'events:read' = ANY(scopes)`, [workspaceId]);
  for (const h of hooks.rows) await enqueue(db, 'service_event_push', { identityId: h.id }, { workspaceId, dedupeKey: h.id });
}

export interface ServiceEventDto { seq: number; id: string; type: string; createdAt: string; conversationId: string | null; contactId: string | null; revision: number | null; data: Record<string, unknown> }
const dto = (r: any): ServiceEventDto => ({ seq: r.seq, id: r.id, type: r.type, createdAt: new Date(r.created_at).toISOString(), conversationId: r.conversation_id, contactId: r.contact_id, revision: r.revision, data: r.payload });

/** Events after `after` (default: this identity's ack cursor) that the identity is allowed to see. Re-delivered until acknowledged. */
export async function pullEvents(ctx: ServiceContext, opts: { after?: number; limit?: number }) {
  const cursor = Number((await pool.query('SELECT ack_cursor FROM service_identities WHERE id=$1', [ctx.identityId])).rows[0].ack_cursor);
  const after = Math.max(opts.after ?? 0, cursor);
  const v = visibilitySql(ctx.actor, 'c', 4);
  const rows = (await pool.query(
    `SELECT e.* FROM service_events e LEFT JOIN conversations c ON c.id=e.conversation_id
     WHERE e.workspace_id=$1 AND e.seq>$2 AND (e.conversation_id IS NULL OR ${v.sql}) ORDER BY e.seq LIMIT $3`, [ctx.workspaceId, after, Math.min(opts.limit ?? 100, 500), ...v.params])).rows;
  const head = Number((await pool.query('SELECT coalesce(max(seq),0) m FROM service_events WHERE workspace_id=$1', [ctx.workspaceId])).rows[0].m);
  return { events: rows.map(dto), cursor, head, hasMore: rows.length > 0 && rows[rows.length - 1].seq < head };
}
/** Cumulative, monotonic acknowledgement: everything up to and including `seq` is considered handled. */
export async function ackEvents(ctx: ServiceContext, seq: number) {
  const head = Number((await pool.query('SELECT coalesce(max(seq),0) m FROM service_events WHERE workspace_id=$1', [ctx.workspaceId])).rows[0].m);
  const s = Math.min(seq, head);
  const r = await pool.query(`UPDATE service_identities SET ack_cursor=GREATEST(ack_cursor,$2), push_attempts=0, push_last_error=NULL WHERE id=$1 RETURNING ack_cursor`, [ctx.identityId, s]);
  return { cursor: Number(r.rows[0].ack_cursor) };
}

export async function pruneServiceEvents(retentionDays = 30) {
  // Only prune what every active identity has acknowledged (an unacked consumer keeps its backlog), and never anything newer than the retention window.
  const r = await pool.query(`DELETE FROM service_events e WHERE e.created_at < now() - ($1||' days')::interval
    AND NOT EXISTS (SELECT 1 FROM service_identities i WHERE i.workspace_id=e.workspace_id AND i.status='active' AND i.ack_cursor < e.seq)`, [String(retentionDays)]);
  return r.rowCount ?? 0;
}
