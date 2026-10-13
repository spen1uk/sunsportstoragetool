import { pool, tx } from '../db/pool.js';
import { normalizePhone } from './phone.js';
import { recordConsent } from './consent.js';
import { HttpError, type Actor, canSeeContact, isAdmin, visibilitySql } from './authz.js';
import { publish, audit } from './events.js';

export interface ContactInput { firstName?: string; lastName?: string; company?: string; email?: string; phone?: string; secondaryPhone?: string; tags?: string[] }

export async function createContact(a: Actor, i: ContactInput) {
  return tx(async (c) => {
    const ct = (await c.query(`INSERT INTO contacts (workspace_id, first_name, last_name, company, email, tags, assigned_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [a.workspaceId, i.firstName ?? null, i.lastName ?? null, i.company ?? null, i.email ?? null, i.tags ?? [], null])).rows[0];
    let primary = true;
    for (const raw of [i.phone, i.secondaryPhone]) {
      if (!raw) continue;
      const n = normalizePhone(raw);
      if (!n) throw new HttpError(400, `invalid phone number: ${raw}`);
      await c.query(`INSERT INTO contact_identities (workspace_id, contact_id, kind, original_value, normalized, is_primary) VALUES ($1,$2,'phone',$3,$4,$5)`, [a.workspaceId, ct.id, raw, n, primary]);
      primary = false;
    }
    await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, type, summary, actor_user_id) VALUES ($1,$2,'contact','Contact created',$3)`, [a.workspaceId, ct.id, a.userId]);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'contact.create', targetType: 'contact', targetId: ct.id });
    return ct.id as string;
  });
}

/** Start (or reuse) an SMS conversation with a contact's primary number. Does NOT send anything. */
export async function openConversationFor(a: Actor, contactId: string, departmentId?: string | null) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  return tx(async (c) => {
    const ident = (await c.query(`SELECT id FROM contact_identities WHERE contact_id=$1 AND kind='phone' ORDER BY is_primary DESC, created_at LIMIT 1`, [contactId])).rows[0];
    if (!ident) throw new HttpError(400, 'contact has no phone number');
    const ch = (await c.query(`SELECT id FROM channels WHERE workspace_id=$1 AND kind='sms' ORDER BY is_simulated DESC LIMIT 1`, [a.workspaceId])).rows[0];
    if (!ch) throw new HttpError(409, 'no SMS channel configured');
    const conv = (await c.query(
      `INSERT INTO conversations (workspace_id, contact_id, channel_id, contact_identity_id, department_id, responsibility) VALUES ($1,$2,$3,$4,$5,'waiting_on_staff')
       ON CONFLICT (workspace_id, contact_id, channel_id) DO UPDATE SET contact_identity_id=COALESCE(conversations.contact_identity_id, EXCLUDED.contact_identity_id) RETURNING id`,
      [a.workspaceId, contactId, ch.id, ident.id, departmentId ?? null])).rows[0];
    await publish(c, a.workspaceId, 'conversation.updated', { conversationId: conv.id });
    return conv.id as string;
  });
}

export async function listContacts(a: Actor, q: { search?: string; tag?: string; limit?: number }) {
  const params: unknown[] = [a.workspaceId];
  const where = ['ct.workspace_id=$1', 'ct.merged_into IS NULL'];
  if (!isAdmin(a)) {
    const v = visibilitySql(a, 'cv', 2); params.push(...v.params);
    where.push(`(NOT EXISTS (SELECT 1 FROM conversations x WHERE x.contact_id=ct.id) OR EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id=ct.id AND ${v.sql}))`);
  }
  if (q.search) { params.push(`%${q.search}%`); const i = params.length;
    where.push(`(ct.first_name ILIKE $${i} OR ct.last_name ILIKE $${i} OR ct.company ILIKE $${i} OR ct.email ILIKE $${i} OR EXISTS (SELECT 1 FROM contact_identities ci WHERE ci.contact_id=ct.id AND (ci.original_value ILIKE $${i} OR ci.normalized ILIKE $${i})))`); }
  if (q.tag) { params.push(q.tag); where.push(`$${params.length} = ANY(ct.tags)`); }
  params.push(Math.min(q.limit ?? 100, 500));
  return (await pool.query(
    `SELECT ct.id, ct.first_name, ct.last_name, ct.company, ct.email, ct.tags, ct.sms_opted_out, ct.do_not_text, ct.marketing_status, ct.outbound_blocked, ct.inbound_blocked,
            (SELECT original_value FROM contact_identities ci WHERE ci.contact_id=ct.id AND ci.kind='phone' ORDER BY is_primary DESC LIMIT 1) AS phone
     FROM contacts ct WHERE ${where.join(' AND ')} ORDER BY ct.updated_at DESC LIMIT $${params.length}`, params)).rows;
}

export async function getContact(a: Actor, id: string) {
  if (!(await canSeeContact(pool, a, id))) throw new HttpError(404, 'contact not found');
  const ct = (await pool.query('SELECT * FROM contacts WHERE id=$1', [id])).rows[0];
  const [identities, boats, consent, timeline] = await Promise.all([
    pool.query('SELECT * FROM contact_identities WHERE contact_id=$1 ORDER BY is_primary DESC', [id]),
    pool.query('SELECT * FROM customer_boats WHERE contact_id=$1 ORDER BY created_at', [id]),
    pool.query('SELECT type, scope, source, evidence, occurred_at FROM consent_events WHERE contact_id=$1 ORDER BY occurred_at DESC LIMIT 50', [id]),
    pool.query('SELECT type, summary, occurred_at, conversation_id FROM timeline_events WHERE contact_id=$1 ORDER BY occurred_at DESC LIMIT 100', [id]),
  ]);
  return { contact: ct, identities: identities.rows, boats: boats.rows, consent: consent.rows, timeline: timeline.rows };
}

export async function updateContact(a: Actor, id: string, patch: Partial<ContactInput> & { tags?: string[] }) {
  if (!(await canSeeContact(pool, a, id))) throw new HttpError(404, 'contact not found');
  await pool.query(
    `UPDATE contacts SET first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name), company=COALESCE($4,company), email=COALESCE($5,email), tags=COALESCE($6,tags), updated_at=now() WHERE id=$1`,
    [id, patch.firstName ?? null, patch.lastName ?? null, patch.company ?? null, patch.email ?? null, patch.tags ?? null]);
  await publish(pool, a.workspaceId, 'contact.updated', { contactId: id });
}

export async function addBoat(a: Actor, contactId: string, b: { relation: 'owned' | 'interested' | 'trade_in'; year?: number; make?: string; model?: string; hullId?: string; provenance?: string; confirmed?: boolean; notes?: string }) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  const r = await pool.query(`INSERT INTO customer_boats (workspace_id, contact_id, relation, year, make, model, hull_id, provenance, confirmed, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'staff_entered'),COALESCE($9,false),$10) RETURNING id`,
    [a.workspaceId, contactId, b.relation, b.year ?? null, b.make ?? null, b.model ?? null, b.hullId ?? null, b.provenance ?? null, b.confirmed ?? null, b.notes ?? null]);
  return r.rows[0].id as string;
}

/** Staff-initiated restriction/consent changes (manager+ for blocks; any staff may set do-not-text/opt-out on a customer's request). */
export async function changeConsent(a: Actor, contactId: string, type: string, evidence?: string, source = 'staff') {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  const managerOnly = ['inbound_block', 'inbound_unblock', 'outbound_block', 'outbound_unblock'];
  if (managerOnly.includes(type) && a.role === 'staff') throw new HttpError(403, 'manager role required');
  await tx(async (c) => {
    await recordConsent(c, { workspaceId: a.workspaceId, contactId, type, source, evidence, actorUserId: a.userId });
    if (['sms_stop', 'do_not_text_set', 'outbound_block'].includes(type))
      await c.query(`UPDATE messages SET status='suppressed', status_detail=$2 WHERE status='queued' AND purpose<>'compliance' AND conversation_id IN (SELECT id FROM conversations WHERE contact_id=$1)`, [contactId, type]);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: `consent.${type}`, targetType: 'contact', targetId: contactId });
  });
  await publish(pool, a.workspaceId, 'contact.updated', { contactId });
}
