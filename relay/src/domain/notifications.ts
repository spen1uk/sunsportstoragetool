import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';
import { publish } from './events.js';
import type { Actor } from './authz.js';

export async function notify(db: Db, n: { workspaceId: string; userIds: string[]; type: string; title: string; conversationId?: string | null; refId?: string | null }) {
  for (const uid of new Set(n.userIds)) {
    await db.query(`INSERT INTO notifications (workspace_id, user_id, type, title, conversation_id, ref_id) VALUES ($1,$2,$3,$4,$5,$6)`, [n.workspaceId, uid, n.type, n.title, n.conversationId ?? null, n.refId ?? null]);
    await publish(db, n.workspaceId, 'notification', { userId: uid, type: n.type });
  }
}

/** Who should hear about new customer activity: the assignee; otherwise the department's members; otherwise owners/admins. */
export async function recipientsForConversation(db: Db, conversationId: string): Promise<string[]> {
  const c = (await db.query('SELECT workspace_id, assignee_user_id, department_id FROM conversations WHERE id=$1', [conversationId])).rows[0];
  if (!c) return [];
  if (c.assignee_user_id) return [c.assignee_user_id];
  if (c.department_id) {
    const r = await db.query(`SELECT m.user_id FROM membership_departments md JOIN memberships m ON m.id=md.membership_id WHERE md.department_id=$1`, [c.department_id]);
    if (r.rowCount) return r.rows.map((x) => x.user_id);
  }
  return (await db.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','admin')`, [c.workspace_id])).rows.map((x) => x.user_id);
}

export async function listNotifications(a: Actor) {
  const items = (await pool.query(`SELECT id, type, title, conversation_id, read_at, created_at FROM notifications WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 50`, [a.userId, a.workspaceId])).rows;
  const unread = (await pool.query(`SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND workspace_id=$2 AND read_at IS NULL`, [a.userId, a.workspaceId])).rows[0].n;
  return { items, unread };
}
export async function markNotificationsRead(a: Actor, id?: string) {
  await pool.query(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND workspace_id=$2 AND read_at IS NULL AND ($3::uuid IS NULL OR id=$3)`, [a.userId, a.workspaceId, id ?? null]);
}
