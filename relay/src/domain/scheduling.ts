import { pool, tx } from '../db/pool.js';
import { HttpError, atLeastManager, requireConversation, type Actor } from './authz.js';
import { queueOutboundTx } from './messaging.js';
import { enqueue } from './queue.js';
import { publish } from './events.js';
import { assertTimezone, zonedToUtc } from './time.js';
import { notify } from './notifications.js';

export async function createScheduled(a: Actor, conversationId: string, i: { body: string; localTime: string; timezone?: string; mediaIds?: string[] }) {
  await requireConversation(pool, a, conversationId);
  const tz = i.timezone ?? (await pool.query('SELECT timezone FROM workspaces WHERE id=$1', [a.workspaceId])).rows[0].timezone;
  try { assertTimezone(tz); } catch { throw new HttpError(400, 'unknown timezone'); }
  let z; try { z = zonedToUtc(i.localTime, tz); } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (z.utc.getTime() < Date.now() + 30_000) throw new HttpError(400, 'scheduled time must be in the future');
  if (!i.body.trim() && !i.mediaIds?.length) throw new HttpError(400, 'message is empty');
  return tx(async (c) => {
    const conv = (await c.query('SELECT responsibility FROM conversations WHERE id=$1 FOR UPDATE', [conversationId])).rows[0];
    const s = (await c.query(
      `INSERT INTO scheduled_sends (workspace_id, conversation_id, created_by, body, media_ids, timezone, local_time, run_at, prev_responsibility) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [a.workspaceId, conversationId, a.userId, i.body, i.mediaIds ?? [], tz, i.localTime, z.utc, conv.responsibility])).rows[0];
    await c.query(`INSERT INTO scheduled_send_events (scheduled_send_id, event, detail, actor_user_id) VALUES ($1,'created',$2,$3)`, [s.id, `${i.localTime} ${tz}${z.dst !== 'none' ? ` (${z.dst})` : ''}`, a.userId]);
    await c.query(`UPDATE conversations SET responsibility='scheduled' WHERE id=$1 AND status='open'`, [conversationId]);
    await enqueue(c, 'scheduled_send', { id: s.id }, { runAt: z.utc, workspaceId: a.workspaceId, dedupeKey: s.id });
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
    return { id: s.id as string, runAt: z.utc, dst: z.dst };
  });
}

export async function listScheduled(a: Actor, conversationId: string) {
  await requireConversation(pool, a, conversationId);
  const rows = (await pool.query(`SELECT s.id, s.body, s.timezone, s.local_time, s.run_at, s.status, s.status_detail, s.created_by, u.name AS created_by_name, s.message_id FROM scheduled_sends s JOIN users u ON u.id=s.created_by WHERE s.conversation_id=$1 ORDER BY s.run_at DESC`, [conversationId])).rows;
  return rows;
}
export async function scheduledHistory(a: Actor, id: string) {
  const s = (await pool.query('SELECT conversation_id FROM scheduled_sends WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0];
  if (!s) throw new HttpError(404, 'not found');
  await requireConversation(pool, a, s.conversation_id);
  return (await pool.query('SELECT event, detail, at FROM scheduled_send_events WHERE scheduled_send_id=$1 ORDER BY id', [id])).rows;
}

export async function cancelScheduled(a: Actor, id: string) {
  return tx(async (c) => {
    const s = (await c.query('SELECT * FROM scheduled_sends WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [id, a.workspaceId])).rows[0];
    if (!s) throw new HttpError(404, 'not found');
    await requireConversation(c, a, s.conversation_id);
    if (s.created_by !== a.userId && !atLeastManager(a)) throw new HttpError(403, 'only the creator or a manager can cancel');
    if (s.status !== 'pending') throw new HttpError(409, `already ${s.status}; cannot cancel`);
    await c.query(`UPDATE scheduled_sends SET status='cancelled', status_detail='cancelled by user' WHERE id=$1`, [id]);
    await c.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE kind='scheduled_send' AND dedupe_key=$1 AND status='pending'`, [id]);
    await c.query(`INSERT INTO scheduled_send_events (scheduled_send_id, event, actor_user_id) VALUES ($1,'cancelled',$2)`, [id, a.userId]);
    await restoreResponsibility(c, s);
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId: s.conversation_id });
  });
}

async function restoreResponsibility(c: import('pg').PoolClient, s: { conversation_id: string; id: string; prev_responsibility: string | null }) {
  const other = await c.query(`SELECT 1 FROM scheduled_sends WHERE conversation_id=$1 AND status='pending' AND id<>$2 LIMIT 1`, [s.conversation_id, s.id]);
  if (!other.rowCount) await c.query(`UPDATE conversations SET responsibility=CASE WHEN $2='waiting_on_customer' THEN 'waiting_on_customer' ELSE 'waiting_on_staff' END WHERE id=$1 AND responsibility='scheduled'`, [s.conversation_id, s.prev_responsibility]);
}

/**
 * Worker handler. Everything is re-evaluated at execution time, inside the same transaction that locks the schedule row,
 * so a concurrent cancel either wins before we start or sees 'sent' afterwards.
 */
export async function executeScheduled(id: string) {
  await tx(async (c) => {
    const s = (await c.query('SELECT * FROM scheduled_sends WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!s || s.status !== 'pending') return;
    const finish = async (status: string, detail: string, messageId?: string) => {
      await c.query('UPDATE scheduled_sends SET status=$2, status_detail=$3, message_id=$4 WHERE id=$1', [id, status, detail, messageId ?? null]);
      await c.query(`INSERT INTO scheduled_send_events (scheduled_send_id, event, detail) VALUES ($1,$2,$3)`, [id, status, detail]);
      if (status !== 'sent') {
        await restoreResponsibility(c, s);
        await notify(c, { workspaceId: s.workspace_id, userIds: [s.created_by], type: 'scheduled_review', title: `Scheduled message not sent: ${detail}`, conversationId: s.conversation_id, refId: id });
      }
      await publish(c, s.workspace_id, 'conversation.updated', { conversationId: s.conversation_id });
    };
    const conv = (await c.query('SELECT status, last_inbound_at FROM conversations WHERE id=$1', [s.conversation_id])).rows[0];
    if (conv.status === 'closed') return finish('suppressed', 'conversation_closed');
    // The customer wrote since this was scheduled: the context changed, so a human must re-confirm rather than us sending a stale message.
    if (conv.last_inbound_at && conv.last_inbound_at > s.created_at) return finish('needs_review', 'customer_replied_since_scheduling');
    const r = await queueOutboundTx(c, { workspaceId: s.workspace_id, conversationId: s.conversation_id, body: s.body, senderType: 'staff', senderUserId: s.created_by, idempotencyKey: `sched:${id}`, mediaIds: s.media_ids });
    if (!r.ok) return finish('suppressed', r.reason, r.messageId);
    await finish('sent', 'queued for delivery', r.messageId);
  });
}
