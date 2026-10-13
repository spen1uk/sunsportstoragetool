/**
 * Internal team chat. ISOLATION RULE: this module must never import the messaging/send pipeline or the job queue.
 * (Enforced by a test that scans this file.) Internal text has its own tables and no route to any customer channel.
 */
import { pool, tx } from '../db/pool.js';
import { HttpError, canSeeContact, isAdmin, type Actor } from './authz.js';
import { publish } from './events.js';
import { notify } from './notifications.js';

interface Channel { id: string; workspace_id: string; kind: 'department' | 'dm' | 'group' | 'customer'; name: string | null; department_id: string | null; contact_id: string | null; dm_key: string | null }

export async function canAccessChannel(a: Actor, ch: Channel): Promise<boolean> {
  if (ch.workspace_id !== a.workspaceId) return false;
  switch (ch.kind) {
    case 'department': return isAdmin(a) || a.departmentIds.includes(ch.department_id!);
    case 'dm': case 'group': return (await pool.query('SELECT 1 FROM chat_members WHERE channel_id=$1 AND user_id=$2', [ch.id, a.userId])).rowCount === 1;
    case 'customer': return canSeeContact(pool, a, ch.contact_id!);      // same visibility as the customer record: financing stays financing
  }
}
async function requireChannel(a: Actor, id: string): Promise<Channel> {
  const ch = (await pool.query('SELECT * FROM chat_channels WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0];
  if (!ch || !(await canAccessChannel(a, ch))) throw new HttpError(404, 'channel not found');   // 404, never confirm existence
  return ch;
}
/** Who may be mentioned / assigned inside a channel (they must be able to read it). */
async function usersWithAccess(ch: Channel, userIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const uid of new Set(userIds)) {
    const m = (await pool.query(`SELECT m.role, COALESCE((SELECT array_agg(md.department_id) FROM membership_departments md WHERE md.membership_id=m.id),'{}') AS deps FROM memberships m WHERE m.workspace_id=$1 AND m.user_id=$2`, [ch.workspace_id, uid])).rows[0];
    if (!m) continue;
    const u: Actor = { userId: uid, workspaceId: ch.workspace_id, role: m.role, departmentIds: m.deps };
    if (await canAccessChannel(u, ch)) out.push(uid);
  }
  return out;
}

export async function ensureDepartmentChannels(a: Actor) {
  await pool.query(`INSERT INTO chat_channels (workspace_id, kind, name, department_id) SELECT workspace_id, 'department', name, id FROM departments WHERE workspace_id=$1 ON CONFLICT DO NOTHING`, [a.workspaceId]);
}

export async function listChannels(a: Actor) {
  await ensureDepartmentChannels(a);
  const rows = (await pool.query(
    `SELECT c.*, d.name AS department_name, ct.first_name, ct.last_name,
       (SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM chat_members cm JOIN users u ON u.id=cm.user_id WHERE cm.channel_id=c.id AND cm.user_id<>$2) AS other_members,
       (SELECT count(*)::int FROM chat_messages m WHERE m.channel_id=c.id AND m.deleted_at IS NULL AND m.author_id<>$2 AND m.seq > COALESCE((SELECT last_read_seq FROM chat_reads r WHERE r.channel_id=c.id AND r.user_id=$2),0)) AS unread,
       (SELECT max(created_at) FROM chat_messages m WHERE m.channel_id=c.id) AS last_activity
     FROM chat_channels c LEFT JOIN departments d ON d.id=c.department_id LEFT JOIN contacts ct ON ct.id=c.contact_id
     WHERE c.workspace_id=$1 ORDER BY last_activity DESC NULLS LAST, c.created_at`, [a.workspaceId, a.userId])).rows;
  const out = [];
  for (const r of rows) if (await canAccessChannel(a, r)) out.push({ id: r.id, kind: r.kind, name: r.kind === 'department' ? r.department_name : r.kind === 'dm' ? r.other_members : r.kind === 'customer' ? [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Customer' : r.name, contactId: r.contact_id, unread: r.unread, lastActivity: r.last_activity });
  return out;
}

export async function openDm(a: Actor, otherUserId: string) {
  if (otherUserId === a.userId) throw new HttpError(400, 'cannot DM yourself');
  const other = await pool.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2', [a.workspaceId, otherUserId]);
  if (!other.rowCount) throw new HttpError(404, 'user not found');
  const key = [a.userId, otherUserId].sort().join(':');
  return tx(async (c) => {
    const ex = (await c.query(`SELECT id FROM chat_channels WHERE workspace_id=$1 AND dm_key=$2`, [a.workspaceId, key])).rows[0];
    if (ex) return ex.id as string;
    const ch = (await c.query(`INSERT INTO chat_channels (workspace_id, kind, dm_key, created_by) VALUES ($1,'dm',$2,$3) RETURNING id`, [a.workspaceId, key, a.userId])).rows[0];
    await c.query('INSERT INTO chat_members VALUES ($1,$2),($1,$3)', [ch.id, a.userId, otherUserId]);
    return ch.id as string;
  });
}

export async function createGroup(a: Actor, name: string, memberIds: string[]) {
  const ids = [...new Set([a.userId, ...memberIds])];
  const ok = await pool.query('SELECT user_id FROM memberships WHERE workspace_id=$1 AND user_id = ANY($2::uuid[])', [a.workspaceId, ids]);
  if (ok.rowCount !== ids.length) throw new HttpError(400, 'unknown member');
  return tx(async (c) => {
    const ch = (await c.query(`INSERT INTO chat_channels (workspace_id, kind, name, created_by) VALUES ($1,'group',$2,$3) RETURNING id`, [a.workspaceId, name, a.userId])).rows[0];
    for (const u of ids) await c.query('INSERT INTO chat_members VALUES ($1,$2)', [ch.id, u]);
    return ch.id as string;
  });
}

/** Private discussion linked to a customer. Visible exactly to people who can see that customer's record. */
export async function openCustomerChannel(a: Actor, contactId: string) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  const r = await pool.query(`INSERT INTO chat_channels (workspace_id, kind, contact_id, created_by) VALUES ($1,'customer',$2,$3) ON CONFLICT (workspace_id, contact_id) WHERE kind='customer' DO UPDATE SET workspace_id=EXCLUDED.workspace_id RETURNING id`, [a.workspaceId, contactId, a.userId]);
  return r.rows[0].id as string;
}

export async function postMessage(a: Actor, channelId: string, i: { body: string; parentId?: string | null; mentions?: string[]; mediaIds?: string[] }) {
  const ch = await requireChannel(a, channelId);
  if (!i.body.trim() && !i.mediaIds?.length) throw new HttpError(400, 'message is empty');
  if (i.parentId) {
    const p = (await pool.query('SELECT parent_id FROM chat_messages WHERE id=$1 AND channel_id=$2', [i.parentId, channelId])).rows[0];
    if (!p) throw new HttpError(404, 'thread not found');
    if (p.parent_id) throw new HttpError(400, 'replies attach to the thread root');
  }
  const mentioned = (await usersWithAccess(ch, i.mentions ?? [])).filter((u) => u !== a.userId);
  if ((i.mentions ?? []).filter((u) => u !== a.userId).length !== mentioned.length) throw new HttpError(400, 'cannot mention someone who cannot access this channel');
  return tx(async (c) => {
    for (const mid of i.mediaIds ?? []) {
      const m = (await c.query(`SELECT 1 FROM media_assets WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [mid, a.workspaceId])).rowCount;
      if (!m) throw new HttpError(400, 'attachment not found');
    }
    const m = (await c.query(`INSERT INTO chat_messages (workspace_id, channel_id, parent_id, author_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING id, seq`, [a.workspaceId, channelId, i.parentId ?? null, a.userId, i.body])).rows[0];
    for (const u of mentioned) await c.query('INSERT INTO chat_mentions VALUES ($1,$2)', [m.id, u]);
    for (const mid of i.mediaIds ?? []) await c.query('INSERT INTO chat_attachments VALUES ($1,$2)', [m.id, mid]);
    await c.query(`INSERT INTO chat_reads (channel_id, user_id, last_read_seq) VALUES ($1,$2,$3) ON CONFLICT (channel_id,user_id) DO UPDATE SET last_read_seq=GREATEST(chat_reads.last_read_seq, EXCLUDED.last_read_seq)`, [channelId, a.userId, m.seq]);
    if (mentioned.length) await notify(c, { workspaceId: a.workspaceId, userIds: mentioned, type: 'mention', title: `${a.name ?? 'A teammate'} mentioned you in team chat`, refId: channelId });
    await publish(c, a.workspaceId, 'chat.message', { channelId });
    return m.id as string;
  });
}

export async function getMessages(a: Actor, channelId: string, opts: { threadRootId?: string } = {}) {
  await requireChannel(a, channelId);
  const rows = (await pool.query(
    `SELECT m.id, m.seq, m.parent_id, m.author_id, u.name AS author_name, CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body, m.edited_at, m.deleted_at, m.created_at,
       (SELECT count(*)::int FROM chat_messages r WHERE r.parent_id=m.id AND r.deleted_at IS NULL) AS reply_count,
       COALESCE((SELECT json_agg(json_build_object('id', cm.user_id, 'name', mu.name)) FROM chat_mentions cm JOIN users mu ON mu.id=cm.user_id WHERE cm.message_id=m.id), '[]'::json) AS mentions,
       COALESCE((SELECT json_agg(json_build_object('id', x.id, 'filename', x.filename, 'content_type', x.content_type)) FROM chat_attachments ca JOIN media_assets x ON x.id=ca.media_id WHERE ca.message_id=m.id), '[]'::json) AS attachments,
       (SELECT t.id FROM tasks t WHERE t.source_chat_message_id=m.id LIMIT 1) AS task_id
     FROM chat_messages m JOIN users u ON u.id=m.author_id
     WHERE m.channel_id=$1 AND ${opts.threadRootId ? '(m.id=$2 OR m.parent_id=$2)' : 'm.parent_id IS NULL'} ORDER BY m.seq`, opts.threadRootId ? [channelId, opts.threadRootId] : [channelId])).rows;
  return rows;
}

export async function markChannelRead(a: Actor, channelId: string) {
  await requireChannel(a, channelId);
  await pool.query(`INSERT INTO chat_reads (channel_id, user_id, last_read_seq) SELECT $1,$2,COALESCE(max(seq),0) FROM chat_messages WHERE channel_id=$1 ON CONFLICT (channel_id,user_id) DO UPDATE SET last_read_seq=GREATEST(chat_reads.last_read_seq, EXCLUDED.last_read_seq)`, [channelId, a.userId]);
}

export async function editMessage(a: Actor, messageId: string, body: string) {
  const m = (await pool.query('SELECT channel_id, author_id FROM chat_messages WHERE id=$1 AND deleted_at IS NULL', [messageId])).rows[0];
  if (!m) throw new HttpError(404, 'message not found');
  await requireChannel(a, m.channel_id);
  if (m.author_id !== a.userId) throw new HttpError(403, 'only the author can edit');
  await pool.query('UPDATE chat_messages SET body=$2, edited_at=now() WHERE id=$1', [messageId, body]);
  await publish(pool, a.workspaceId, 'chat.message', { channelId: m.channel_id });
}
export async function deleteMessage(a: Actor, messageId: string) {
  const m = (await pool.query('SELECT channel_id, author_id FROM chat_messages WHERE id=$1 AND deleted_at IS NULL', [messageId])).rows[0];
  if (!m) throw new HttpError(404, 'message not found');
  await requireChannel(a, m.channel_id);
  if (m.author_id !== a.userId && !isAdmin(a)) throw new HttpError(403, 'only the author or an admin can delete');
  await pool.query('UPDATE chat_messages SET deleted_at=now() WHERE id=$1', [messageId]);
  await publish(pool, a.workspaceId, 'chat.message', { channelId: m.channel_id });
}

/** Search only inside channels the caller can read. */
export async function searchMessages(a: Actor, q: string) {
  if (q.trim().length < 2) return [];
  const rows = (await pool.query(
    `SELECT m.id, m.channel_id, m.body, m.created_at, u.name AS author_name, c.*
     FROM chat_messages m JOIN chat_channels c ON c.id=m.channel_id JOIN users u ON u.id=m.author_id
     WHERE m.workspace_id=$1 AND m.deleted_at IS NULL AND m.body ILIKE $2 ORDER BY m.created_at DESC LIMIT 100`, [a.workspaceId, `%${q}%`])).rows;
  const cache = new Map<string, boolean>(); const out = [];
  for (const r of rows) {
    if (!cache.has(r.channel_id)) cache.set(r.channel_id, await canAccessChannel(a, { ...r, id: r.channel_id }));
    if (cache.get(r.channel_id)) out.push({ id: r.id, channelId: r.channel_id, body: r.body, authorName: r.author_name, createdAt: r.created_at });
  }
  return out;
}

// ---------- tasks ----------
export async function messageToTask(a: Actor, messageId: string, i: { assigneeId: string; dueAt?: string | null; title?: string }) {
  const m = (await pool.query('SELECT m.channel_id, m.body FROM chat_messages m WHERE m.id=$1 AND m.deleted_at IS NULL', [messageId])).rows[0];
  if (!m) throw new HttpError(404, 'message not found');
  const ch = await requireChannel(a, m.channel_id);
  if (!(await usersWithAccess(ch, [i.assigneeId])).length) throw new HttpError(400, 'assignee cannot access this channel');
  let due: Date | null = null;
  if (i.dueAt) { due = new Date(i.dueAt); if (isNaN(due.getTime())) throw new HttpError(400, 'invalid due date'); }
  return tx(async (c) => {
    let conversationId: string | null = null;
    if (ch.contact_id) conversationId = (await c.query('SELECT id FROM conversations WHERE contact_id=$1 ORDER BY last_message_at DESC NULLS LAST LIMIT 1', [ch.contact_id])).rows[0]?.id ?? null;
    const t = (await c.query(
      `INSERT INTO tasks (workspace_id, title, description, assignee_user_id, created_by, due_at, contact_id, conversation_id, source_chat_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [a.workspaceId, (i.title ?? m.body).slice(0, 200), m.body, i.assigneeId, a.userId, due, ch.contact_id, conversationId, messageId])).rows[0];
    await notify(c, { workspaceId: a.workspaceId, userIds: [i.assigneeId], type: 'task_assigned', title: `New task: ${(i.title ?? m.body).slice(0, 80)}`, conversationId, refId: t.id });
    return t.id as string;
  });
}

export async function listTasks(a: Actor, q: { scope?: 'mine' | 'created' | 'all'; status?: string }) {
  const scope = q.scope ?? 'mine';
  if (scope === 'all' && !isAdmin(a) && a.role !== 'manager') throw new HttpError(403, 'manager role required');
  const rows = (await pool.query(
    `SELECT t.*, u.name AS assignee_name, ct.first_name, ct.last_name, (t.status='open' AND t.due_at IS NOT NULL AND t.due_at < now()) AS overdue
     FROM tasks t JOIN users u ON u.id=t.assignee_user_id LEFT JOIN contacts ct ON ct.id=t.contact_id
     WHERE t.workspace_id=$1 AND ($2<>'mine' OR t.assignee_user_id=$3) AND ($2<>'created' OR t.created_by=$3) AND ($4::text IS NULL OR t.status=$4)
     ORDER BY t.due_at NULLS LAST, t.created_at DESC LIMIT 200`, [a.workspaceId, scope, a.userId, q.status ?? null])).rows;
  // A task linked to a customer the viewer cannot see is hidden (except from its assignee/creator, who already know of it).
  const out = [];
  for (const r of rows) if (!r.contact_id || r.assignee_user_id === a.userId || r.created_by === a.userId || await canSeeContact(pool, a, r.contact_id)) out.push(r);
  return out;
}
export async function updateTask(a: Actor, id: string, patch: { status?: 'open' | 'done' | 'cancelled'; dueAt?: string | null; assigneeId?: string }) {
  const t = (await pool.query('SELECT * FROM tasks WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0];
  if (!t) throw new HttpError(404, 'task not found');
  if (t.assignee_user_id !== a.userId && t.created_by !== a.userId && !isAdmin(a) && a.role !== 'manager') throw new HttpError(403, 'not your task');
  if (patch.assigneeId && patch.assigneeId !== t.assignee_user_id) {
    if (t.contact_id) { const m = (await pool.query(`SELECT m.role, COALESCE((SELECT array_agg(md.department_id) FROM membership_departments md WHERE md.membership_id=m.id),'{}') AS deps FROM memberships m WHERE m.workspace_id=$1 AND m.user_id=$2`, [a.workspaceId, patch.assigneeId])).rows[0];
      if (!m || !(await canSeeContact(pool, { userId: patch.assigneeId, workspaceId: a.workspaceId, role: m.role, departmentIds: m.deps }, t.contact_id))) throw new HttpError(400, 'assignee cannot access this customer'); }
  }
  await pool.query(`UPDATE tasks SET status=COALESCE($2,status), completed_at=CASE WHEN $2='done' THEN now() WHEN $2 IN ('open','cancelled') THEN NULL ELSE completed_at END, due_at=CASE WHEN $3::boolean THEN $4::timestamptz ELSE due_at END, assignee_user_id=COALESCE($5,assignee_user_id) WHERE id=$1`,
    [id, patch.status ?? null, patch.dueAt !== undefined, patch.dueAt ?? null, patch.assigneeId ?? null]);
}
export async function createTask(a: Actor, i: { title: string; assigneeId?: string; dueAt?: string | null; contactId?: string | null; conversationId?: string | null }) {
  if (i.contactId && !(await canSeeContact(pool, a, i.contactId))) throw new HttpError(404, 'contact not found');
  const assignee = i.assigneeId ?? a.userId;
  const r = await pool.query(`INSERT INTO tasks (workspace_id, title, assignee_user_id, created_by, due_at, contact_id, conversation_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [a.workspaceId, i.title, assignee, a.userId, i.dueAt ? new Date(i.dueAt) : null, i.contactId ?? null, i.conversationId ?? null]);
  if (assignee !== a.userId) await notify(pool, { workspaceId: a.workspaceId, userIds: [assignee], type: 'task_assigned', title: `New task: ${i.title.slice(0, 80)}`, refId: r.rows[0].id });
  return r.rows[0].id as string;
}
