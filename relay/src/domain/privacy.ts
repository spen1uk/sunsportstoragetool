import { pool, tx } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from './authz.js';
import { audit, publish } from './events.js';
import { deleteMedia } from './media.js';

const admin = (a: Actor) => { if (!isAdmin(a)) throw new HttpError(403, 'owner or admin required'); };

/** Everything Relay holds about one contact, as JSON (for a customer's access request). Audited. Does NOT include other people's data or credentials. */
export async function exportContact(a: Actor, contactId: string) {
  admin(a);
  const contact = (await pool.query('SELECT id, first_name, last_name, company, email, tags, preferred_channel, created_at, erased_at, sms_opted_out, do_not_text, marketing_status FROM contacts WHERE id=$1 AND workspace_id=$2', [contactId, a.workspaceId])).rows[0];
  if (!contact) throw new HttpError(404, 'contact not found');
  const q = async (sql: string) => (await pool.query(sql, [contactId])).rows;
  const out = {
    exportedAt: new Date().toISOString(), contact,
    identities: await q(`SELECT kind, original_value, normalized, created_at FROM contact_identities WHERE contact_id=$1`),
    consentHistory: await q(`SELECT type, scope, source, evidence, occurred_at FROM consent_events WHERE contact_id=$1 ORDER BY occurred_at`),
    conversations: await q(`SELECT id, status, responsibility, handling_mode, created_at, last_message_at FROM conversations WHERE contact_id=$1`),
    messages: await q(`SELECT m.created_at, m.direction, m.sender_type, m.purpose, m.body, m.status FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.contact_id=$1 AND m.redacted_at IS NULL ORDER BY m.seq`),
    notes: await q(`SELECT created_at, body FROM notes WHERE contact_id=$1 ORDER BY created_at`),
    boats: await q(`SELECT relation, year, make, model, hull_id FROM customer_boats WHERE contact_id=$1`),
    preferences: (await q(`SELECT * FROM contact_preferences WHERE contact_id=$1`))[0] ?? null,
    tasks: await q(`SELECT title, status, due_at, created_at FROM tasks WHERE contact_id=$1`),
    payments: await q(`SELECT amount_cents, currency, description, status, paid_cents, refunded_cents, created_at FROM payment_requests WHERE contact_id=$1`),
    timeline: await q(`SELECT occurred_at, type, summary FROM timeline_events WHERE contact_id=$1 ORDER BY occurred_at`),
    attachments: await q(`SELECT filename, content_type, size_bytes, created_at FROM media_assets WHERE contact_id=$1 AND deleted_at IS NULL`),
  };
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'contact.export', targetType: 'contact', targetId: contactId, meta: { messages: out.messages.length } });
  return out;
}

/**
 * Anonymize a contact in place. Deliberately NOT a hard delete: foreign keys, analytics counts and the audit trail keep working, but no personal content remains.
 *  - removed: name/company/email/tags, all message text, notes, boats, preferences, summaries/facts, voice transcripts, drafts, attachments (files deleted), free text on tasks/timeline/payments
 *  - kept (data minimisation, legal/safety reasons): consent & opt-out history (proof we honoured STOP), financial amounts/status of payment requests, audit log, message metadata (times, status, provider ids)
 *  - the phone number is kept ONLY if the person had opted out / was marked do-not-text, as a suppression record so a later text from them cannot silently re-enable messaging
 *  - the contact is permanently outbound-blocked
 * NOT covered (listed in docs/DATA_RETENTION.md): team-chat messages that mention the person, backups taken before the erase (they age out by backup retention), and copies at third parties.
 */
export async function eraseContact(a: Actor, contactId: string, confirm: string) {
  admin(a);
  if (confirm !== 'ERASE') throw new HttpError(400, 'confirmation required: send {"confirm":"ERASE"}');
  const media = await tx(async (c) => {
    const ct = (await c.query('SELECT * FROM contacts WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [contactId, a.workspaceId])).rows[0];
    if (!ct) throw new HttpError(404, 'contact not found');
    if (ct.erased_at) throw new HttpError(409, 'contact is already erased');
    const open = (await c.query(`SELECT count(*)::int n FROM payment_requests WHERE contact_id=$1 AND status IN ('open','partially_paid')`, [contactId])).rows[0].n;
    if (open) throw new HttpError(409, `${open} payment request(s) are still open; cancel or settle them first`);
    const convs = (await c.query('SELECT id FROM conversations WHERE contact_id=$1', [contactId])).rows.map((r) => r.id as string);
    const keepNumber = ct.sms_opted_out || ct.do_not_text;
    // Stop anything still in flight first.
    await c.query(`UPDATE messages SET status='suppressed', status_detail='contact_erased' WHERE conversation_id = ANY($1::uuid[]) AND status='queued'`, [convs]);
    await c.query(`UPDATE scheduled_sends SET status='cancelled', status_detail='contact_erased', body='[erased]' WHERE conversation_id = ANY($1::uuid[])`, [convs]);
    await c.query(`UPDATE messages SET body='[erased]', redacted_at=COALESCE(redacted_at, now()), from_original=NULL, to_original=NULL WHERE conversation_id = ANY($1::uuid[])`, [convs]);
    await c.query(`UPDATE conversations SET last_preview=NULL, tags='{}', status='closed', responsibility='closed', handling_mode='paused', assignee_user_id=NULL, revision=revision+1 WHERE contact_id=$1`, [contactId]);
    await c.query(`DELETE FROM assistant_drafts WHERE conversation_id = ANY($1::uuid[])`, [convs]);
    await c.query(`UPDATE voice_drafts SET transcript_original=NULL, cleaned_text=NULL, final_text=NULL, status='discarded' WHERE conversation_id = ANY($1::uuid[])`, [convs]);
    await c.query('DELETE FROM notes WHERE contact_id=$1', [contactId]);
    await c.query('DELETE FROM customer_boats WHERE contact_id=$1', [contactId]);
    await c.query('DELETE FROM contact_preferences WHERE contact_id=$1', [contactId]);
    await c.query('DELETE FROM match_results WHERE contact_id=$1', [contactId]);
    await c.query('DELETE FROM outreach_packages WHERE contact_id=$1', [contactId]);
    await c.query('DELETE FROM conversation_summaries WHERE contact_id=$1', [contactId]);
    await c.query('DELETE FROM summary_chunks WHERE contact_id=$1', [contactId]);
    await c.query('DELETE FROM summary_state WHERE contact_id=$1', [contactId]);
    await c.query(`UPDATE timeline_events SET summary='[erased]' WHERE contact_id=$1 AND type<>'consent'`, [contactId]);
    await c.query(`UPDATE tasks SET title='[erased]', description=NULL WHERE contact_id=$1`, [contactId]);
    await c.query(`UPDATE payment_requests SET description='[erased]', reference=NULL, pay_url=NULL, receipt_url=NULL WHERE contact_id=$1`, [contactId]);
    await c.query(`UPDATE consent_events SET evidence = CASE WHEN evidence IS NULL THEN NULL ELSE '[retained as proof of consent handling; free text removed]' END WHERE contact_id=$1`, [contactId]);
    await c.query('UPDATE conversations SET contact_identity_id=NULL WHERE contact_id=$1', [contactId]);
    if (keepNumber) await c.query(`UPDATE contact_identities SET original_value='[erased]' WHERE contact_id=$1`, [contactId]);
    else await c.query('DELETE FROM contact_identities WHERE contact_id=$1', [contactId]);
    if (keepNumber) await c.query(`UPDATE conversations SET contact_identity_id=(SELECT id FROM contact_identities WHERE contact_id=$1 LIMIT 1) WHERE contact_id=$1`, [contactId]);
    await c.query(`UPDATE contacts SET first_name='Erased', last_name=NULL, company=NULL, email=NULL, tags='{}', outbound_blocked=true, do_not_text=true, erased_at=now(), updated_at=now() WHERE id=$1`, [contactId]);
    const m = (await c.query(`SELECT id FROM media_assets WHERE contact_id=$1 AND deleted_at IS NULL`, [contactId])).rows.map((r) => r.id as string);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'contact.erase', targetType: 'contact', targetId: contactId, meta: { conversations: convs.length, mediaFiles: m.length, numberKeptAsSuppression: keepNumber } });
    for (const id of convs) await publish(c, a.workspaceId, 'conversation.updated', { conversationId: id });
    return m;
  });
  for (const id of media) await deleteMedia(a, id).catch(() => undefined);   // files are removed after the database commit; a failure leaves an orphan file, never a dangling reference
  return { ok: true, mediaDeleted: media.length };
}
