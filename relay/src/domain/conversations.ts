import type { PoolClient } from 'pg';
import { tx, pool } from '../db/pool.js';
import { type Actor, HttpError, requireConversation, visibilitySql, isAdmin, atLeastManager } from './authz.js';
import { publish, audit } from './events.js';

export const RESPONSIBILITIES = ['needs_our_reply', 'waiting_on_customer', 'waiting_on_staff', 'scheduled', 'closed'] as const;
export const HANDLING_MODES = ['human', 'sandra', 'draft_only', 'paused'] as const;

/** Allowed manual responsibility corrections (authorized staff). 'closed' is only reachable via close/reopen to keep status in sync. */
const MANUAL_RESPONSIBILITY = new Set(['needs_our_reply', 'waiting_on_customer', 'waiting_on_staff']);

export async function listConversations(a: Actor, q: { status?: string; responsibility?: string; assignee?: string; department?: string; search?: string; unreadOnly?: boolean; limit?: number }) {
  const params: unknown[] = [a.workspaceId, a.userId];
  const where: string[] = ['c.workspace_id=$1'];
  const v = visibilitySql(a, 'c', 3); params.push(...v.params); where.push(v.sql);
  const add = (cond: string, val: unknown) => { params.push(val); where.push(cond.replace('?', `$${params.length}`)); };
  if (q.status) add('c.status=?', q.status);
  if (q.responsibility) add('c.responsibility=?', q.responsibility);
  if (q.assignee === 'me') add('c.assignee_user_id=?', a.userId);
  else if (q.assignee === 'unassigned') where.push('c.assignee_user_id IS NULL');
  else if (q.assignee) add('c.assignee_user_id=?', q.assignee);
  if (q.department) add('c.department_id=?', q.department);
  if (q.search) {
    params.push(`%${q.search}%`);
    const i = params.length;
    where.push(`(ct.first_name ILIKE $${i} OR ct.last_name ILIKE $${i} OR ct.company ILIKE $${i} OR c.last_preview ILIKE $${i} OR EXISTS (SELECT 1 FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.original_value ILIKE $${i}) OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.body ILIKE $${i}))`);
  }
  const unread = `COALESCE((SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.seq > COALESCE(cr.last_read_seq,0)),0)`;
  if (q.unreadOnly) where.push(`${unread} > 0`);
  params.push(Math.min(q.limit ?? 100, 200));
  const r = await pool.query(
    `SELECT c.id, c.contact_id, c.status, c.responsibility, c.handling_mode, c.assignee_user_id, c.department_id, c.tags, c.revision,
            c.last_message_at, c.last_preview, c.last_inbound_at, c.last_outbound_at, ch.kind AS channel, ch.is_simulated,
            ct.first_name, ct.last_name, ct.company, ci.original_value AS phone, d.name AS department_name, u.name AS assignee_name,
            ${unread}::int AS unread
     FROM conversations c JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id
     LEFT JOIN contact_identities ci ON ci.id=c.contact_identity_id LEFT JOIN departments d ON d.id=c.department_id
     LEFT JOIN users u ON u.id=c.assignee_user_id LEFT JOIN conversation_reads cr ON cr.conversation_id=c.id AND cr.user_id=$2
     WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC NULLS LAST LIMIT $${params.length}`, params);
  return r.rows;
}

export async function getThread(a: Actor, conversationId: string) {
  await requireConversation(pool, a, conversationId);
  const conv = (await pool.query(
    `SELECT c.*, ch.is_simulated, ch.provider, ch.address AS channel_address FROM conversations c JOIN channels ch ON ch.id=c.channel_id WHERE c.id=$1`, [conversationId])).rows[0];
  const messages = (await pool.query(
    `SELECT m.id, m.seq, m.direction, m.sender_type, m.sender_user_id, u.name AS sender_name, m.purpose, m.body, m.status, m.status_detail, m.created_at, m.source_ts
     FROM messages m LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.conversation_id=$1 ORDER BY m.seq`, [conversationId])).rows;
  const notes = (await pool.query(
    `SELECT n.id, n.body, n.created_at, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id=n.author_user_id WHERE n.contact_id=$1 ORDER BY n.created_at DESC`, [conv.contact_id])).rows;
  return { conversation: conv, messages, notes };
}

async function lockConv(c: PoolClient, a: Actor, id: string) {
  await requireConversation(c, a, id);
  return (await c.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE', [id])).rows[0];
}
async function timeline(c: PoolClient, a: Actor, conv: { id: string; contact_id: string }, type: string, summary: string) {
  await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary, actor_user_id) VALUES ($1,$2,$3,$4,$5,$6)`, [a.workspaceId, conv.contact_id, conv.id, type, summary, a.userId]);
}

/** Assign (or unassign with null). Assignee must be a workspace member who can see the department. Bumps the fence. */
export async function assign(a: Actor, conversationId: string, assigneeId: string | null) {
  return tx(async (c) => {
    const conv = await lockConv(c, a, conversationId);
    if (assigneeId) {
      const m = (await c.query(
        `SELECT m.role, COALESCE(array_agg(md.department_id) FILTER (WHERE md.department_id IS NOT NULL), '{}') AS deps
         FROM memberships m LEFT JOIN membership_departments md ON md.membership_id=m.id WHERE m.workspace_id=$1 AND m.user_id=$2 GROUP BY m.id`, [a.workspaceId, assigneeId])).rows[0];
      if (!m) throw new HttpError(400, 'assignee is not a member of this workspace');
      if (conv.department_id && !['owner', 'admin'].includes(m.role)) {
        const d = (await c.query('SELECT restricted FROM departments WHERE id=$1', [conv.department_id])).rows[0];
        if (!m.deps.includes(conv.department_id) && (d.restricted || m.role === 'staff')) throw new HttpError(400, 'assignee lacks access to this department');
      }
    }
    await c.query('UPDATE conversations SET assignee_user_id=$2, revision=revision+1 WHERE id=$1', [conversationId, assigneeId]);
    await timeline(c, a, conv, 'assignment', assigneeId ? 'Conversation assigned' : 'Conversation unassigned');
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'conversation.assign', targetType: 'conversation', targetId: conversationId, meta: { assigneeId } });
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
  });
}

/** Employee takeover: assigns to self, sets Human handling, bumps fence → any queued/delayed Sandra/automation send is rejected server-side. */
export async function takeover(a: Actor, conversationId: string) {
  return tx(async (c) => {
    const conv = await lockConv(c, a, conversationId);
    await c.query(`UPDATE conversations SET handling_mode='human', assignee_user_id=$2, revision=revision+1 WHERE id=$1`, [conversationId, a.userId]);
    // Anything automation/Sandra still has queued (not yet sent) is suppressed now, not just fenced later.
    await c.query(`UPDATE messages SET status='suppressed', status_detail='employee_takeover' WHERE conversation_id=$1 AND status='queued' AND sender_type IN ('sandra','automation')`, [conversationId]);
    await timeline(c, a, conv, 'handling_mode', 'Employee took over (Human handling)');
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'conversation.takeover', targetType: 'conversation', targetId: conversationId });
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
  });
}

export async function setHandlingMode(a: Actor, conversationId: string, mode: string) {
  if (!HANDLING_MODES.includes(mode as never)) throw new HttpError(400, 'invalid handling mode');
  if (mode === 'sandra' && !atLeastManager(a)) throw new HttpError(403, 'only managers/admins may hand a conversation to Sandra');
  return tx(async (c) => {
    const conv = await lockConv(c, a, conversationId);
    await c.query('UPDATE conversations SET handling_mode=$2, revision=revision+1 WHERE id=$1', [conversationId, mode]);
    if (mode !== 'sandra') await c.query(`UPDATE messages SET status='suppressed', status_detail='handling_mode_changed' WHERE conversation_id=$1 AND status='queued' AND sender_type IN ('sandra','automation')`, [conversationId]);
    await timeline(c, a, conv, 'handling_mode', `Handling mode set to ${mode}`);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'conversation.handling_mode', targetType: 'conversation', targetId: conversationId, meta: { mode } });
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
  });
}

/** Manual correction of responsibility state. */
export async function setResponsibility(a: Actor, conversationId: string, state: string) {
  if (!MANUAL_RESPONSIBILITY.has(state)) throw new HttpError(400, 'invalid responsibility state (use close/reopen for closed)');
  return tx(async (c) => {
    const conv = await lockConv(c, a, conversationId);
    if (conv.status === 'closed') throw new HttpError(409, 'conversation is closed; reopen first');
    await c.query('UPDATE conversations SET responsibility=$2 WHERE id=$1', [conversationId, state]);
    await timeline(c, a, conv, 'status_change', `Responsibility corrected to ${state}`);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'conversation.responsibility', targetType: 'conversation', targetId: conversationId, meta: { state } });
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
  });
}

export async function setOpen(a: Actor, conversationId: string, open: boolean) {
  return tx(async (c) => {
    const conv = await lockConv(c, a, conversationId);
    await c.query(`UPDATE conversations SET status=$2, responsibility=$3, revision=revision+1 WHERE id=$1`, [conversationId, open ? 'open' : 'closed', open ? 'needs_our_reply' : 'closed']);
    if (!open) await c.query(`UPDATE messages SET status='suppressed', status_detail='conversation_closed' WHERE conversation_id=$1 AND status='queued' AND sender_type IN ('sandra','automation') AND purpose<>'compliance'`, [conversationId]);
    await timeline(c, a, conv, 'status_change', open ? 'Conversation reopened' : 'Conversation closed');
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
  });
}

export async function setDepartment(a: Actor, conversationId: string, departmentId: string | null) {
  return tx(async (c) => {
    const conv = await lockConv(c, a, conversationId);
    if (departmentId) {
      const d = (await c.query('SELECT 1 FROM departments WHERE id=$1 AND workspace_id=$2', [departmentId, a.workspaceId])).rowCount;
      if (!d) throw new HttpError(400, 'unknown department');
      if (!isAdmin(a) && !a.departmentIds.includes(departmentId) && a.role === 'staff') throw new HttpError(403, 'not a member of that department');
    }
    await c.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [conversationId, departmentId]);
    await timeline(c, a, conv, 'assignment', 'Department changed');
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
  });
}

export async function markRead(a: Actor, conversationId: string) {
  await requireConversation(pool, a, conversationId);
  await pool.query(
    `INSERT INTO conversation_reads (conversation_id, user_id, last_read_seq)
     SELECT $1, $2, COALESCE(max(seq),0) FROM messages WHERE conversation_id=$1
     ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_seq = GREATEST(conversation_reads.last_read_seq, EXCLUDED.last_read_seq)`, [conversationId, a.userId]);
}

export async function addNote(a: Actor, conversationId: string, body: string) {
  if (!body.trim()) throw new HttpError(400, 'note is empty');
  return tx(async (c) => {
    const conv = await lockConv(c, a, conversationId);
    const n = await c.query(`INSERT INTO notes (workspace_id, contact_id, conversation_id, author_user_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [a.workspaceId, conv.contact_id, conversationId, a.userId, body]);
    await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary, actor_user_id, origin_table, origin_id) VALUES ($1,$2,$3,'note','Internal note added',$4,'notes',$5)`, [a.workspaceId, conv.contact_id, conversationId, a.userId, n.rows[0].id]);
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId });
    return n.rows[0].id as string;
  });
}
