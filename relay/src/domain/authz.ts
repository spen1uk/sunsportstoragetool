import type { Db } from '../db/pool.js';

export type Role = 'owner' | 'admin' | 'manager' | 'staff';
export interface Actor { userId: string; workspaceId: string; role: Role; departmentIds: string[]; name?: string }

export const isAdmin = (a: Actor) => a.role === 'owner' || a.role === 'admin';
export const atLeastManager = (a: Actor) => isAdmin(a) || a.role === 'manager';

export class HttpError extends Error { constructor(public status: number, message: string, public extra?: object) { super(message); } }

/**
 * Conversation/contact visibility rules (enforced in SQL for lists and via canSee for single reads):
 *  - owner/admin: everything
 *  - unrouted conversations (no department): everyone (triage)
 *  - department member: that department
 *  - manager: any NON-restricted department
 *  - assignee: conversations assigned to them
 * Restricted departments (e.g. Financing) require explicit membership (owner/admin exempt).
 */
export function visibilitySql(a: Actor, alias: string, paramStart: number): { sql: string; params: unknown[] } {
  if (isAdmin(a)) return { sql: 'TRUE', params: [] };
  const sql = `(${alias}.department_id IS NULL OR ${alias}.department_id = ANY($${paramStart}::uuid[]) OR ${alias}.assignee_user_id = $${paramStart + 1}
    ${a.role === 'manager' ? `OR EXISTS (SELECT 1 FROM departments d WHERE d.id=${alias}.department_id AND NOT d.restricted)` : ''})`;
  return { sql, params: [a.departmentIds, a.userId] };
}

export async function canSeeConversation(db: Db, a: Actor, conversationId: string): Promise<boolean> {
  const v = visibilitySql(a, 'c', 3);
  const r = await db.query(`SELECT 1 FROM conversations c WHERE c.id=$1 AND c.workspace_id=$2 AND ${v.sql}`, [conversationId, a.workspaceId, ...v.params]);
  return r.rowCount === 1;
}

export async function requireConversation(db: Db, a: Actor, conversationId: string) {
  if (!(await canSeeConversation(db, a, conversationId))) throw new HttpError(404, 'conversation not found');
}

/** A contact is visible if any of its conversations is visible, or it has none (new contact). */
export async function canSeeContact(db: Db, a: Actor, contactId: string): Promise<boolean> {
  if (isAdmin(a)) return (await db.query('SELECT 1 FROM contacts WHERE id=$1 AND workspace_id=$2', [contactId, a.workspaceId])).rowCount === 1;
  const v = visibilitySql(a, 'c', 3);
  const r = await db.query(
    `SELECT 1 FROM contacts ct WHERE ct.id=$1 AND ct.workspace_id=$2 AND (
       NOT EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id=ct.id)
       OR EXISTS (SELECT 1 FROM conversations c WHERE c.contact_id=ct.id AND ${v.sql}))`, [contactId, a.workspaceId, ...v.params]);
  return r.rowCount === 1;
}
