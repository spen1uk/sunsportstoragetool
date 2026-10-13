import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { enqueue } from './queue.js';

export const EVENT_TYPES = ['message.received', 'message.status_changed', 'payment.updated', 'review.created', 'ping'] as const;

/**
 * Fan an internal event out to matching webhook subscriptions (one delivery row per subscription, enqueued durably in the same transaction).
 * `data` is metadata only (IDs, statuses). `content` (message text, review text) is attached ONLY for subscriptions an admin explicitly marked include_content.
 */
export async function emitEvent(db: Db, workspaceId: string, type: string, data: Record<string, unknown>, content?: Record<string, unknown>) {
  const subs = (await db.query(`SELECT id, include_content FROM webhook_subscriptions WHERE workspace_id=$1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`, [workspaceId, type])).rows;
  for (const s of subs) {
    const eventId = randomUUID();
    const payload = { id: eventId, type, createdAt: new Date().toISOString(), data: { ...data, ...(s.include_content && content ? content : {}) } };
    const d = (await db.query(`INSERT INTO webhook_deliveries (subscription_id, event_id, event_type, payload) VALUES ($1,$2,$3,$4) RETURNING id`, [s.id, eventId, type, JSON.stringify(payload)])).rows[0];
    await enqueue(db, 'webhook_delivery', { deliveryId: d.id }, { workspaceId, dedupeKey: `${d.id}:0` });
  }
}
