import type { PoolClient } from 'pg';
import { tx } from '../db/pool.js';
import { normalizePhone } from './phone.js';
import { classifyKeyword, recordConsent } from './consent.js';
import { publish } from './events.js';
import { queueOutbound } from './messaging.js';
import type { NormalizedWebhook } from '../providers/sms.js';
import { saveMedia } from './media.js';
import { notify, recipientsForConversation } from './notifications.js';
import { HttpError } from './authz.js';
import { touchSummary } from './summary.js';
import { enqueue } from './queue.js';
import { emitEvent } from './outbound-events.js';

const RANK: Record<string, number> = { queued: 0, sending: 1, unknown: 1, provider_accepted: 2, delivered: 3, failed: 3 };

/**
 * Process a verified provider event exactly-once (ledger on (provider,event_id)); duplicates / retries are no-ops.
 * Out-of-order status events never regress a message.
 */
export async function processWebhookEvent(provider: string, ev: NormalizedWebhook): Promise<{ duplicate: boolean }> {
  const post: (() => Promise<unknown>)[] = [];
  const result = await tx(async (c) => {
    const ins = await c.query(`INSERT INTO webhook_events (provider, event_id, payload) VALUES ($1,$2,$3) ON CONFLICT (provider,event_id) DO NOTHING RETURNING id`, [provider, ev.eventId, JSON.stringify(ev)]);
    if (!ins.rowCount) return { duplicate: true };
    if (ev.type === 'inbound') await handleInbound(c, provider, ev, post);
    else await handleStatus(c, provider, ev);
    await c.query('UPDATE webhook_events SET processed_at=now() WHERE id=$1', [ins.rows[0].id]);
    return { duplicate: false };
  });
  for (const p of post) await p();   // compliance acknowledgments, after commit
  return result;
}

async function handleStatus(c: PoolClient, provider: string, ev: Extract<NormalizedWebhook, { type: 'status' }>) {
  const m = (await c.query(`SELECT id, workspace_id, conversation_id, status FROM messages WHERE provider=$1 AND provider_message_id=$2 FOR UPDATE`, [provider, ev.providerMessageId])).rows[0];
  if (!m) {
    // Status arrived before we recorded the provider id (race): keep ledger entry; reconciliation job can re-apply. Not an error.
    return;
  }
  await c.query(`INSERT INTO message_delivery_events (workspace_id, message_id, status, provider_event_id, occurred_at, raw) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [m.workspace_id, m.id, ev.status, ev.eventId, ev.occurredAt, JSON.stringify(ev)]);
  const terminal = m.status === 'delivered' || m.status === 'failed';
  if (!terminal && (RANK[ev.status] ?? 0) > (RANK[m.status] ?? 0)) {
    await c.query(`UPDATE messages SET status=$2, status_detail=$3 WHERE id=$1`, [m.id, ev.status, ev.error ?? null]);
    await publish(c, m.workspace_id, 'message.updated', { conversationId: m.conversation_id, messageId: m.id });
    await emitEvent(c, m.workspace_id, 'message.status_changed', { messageId: m.id, conversationId: m.conversation_id, status: ev.status });
  }
}

async function handleInbound(c: PoolClient, provider: string, ev: Extract<NormalizedWebhook, { type: 'inbound' }>, post: (() => Promise<unknown>)[]) {
  const ch = (await c.query(`SELECT * FROM channels WHERE provider=$1 AND address=$2`, [provider, normalizePhone(ev.to) ?? ev.to])).rows[0];
  if (!ch) throw new Error(`no channel for ${ev.to}`);   // unknown destination: fail loudly, ledger rolls back so provider retries
  const ws = ch.workspace_id as string;
  const e164 = normalizePhone(ev.from);
  if (!e164) throw new Error(`unparseable sender ${ev.from}`);

  // Find the contact owning this number. Shared numbers are NOT merged: pick the most recently active contact, never auto-merge.
  let ident = (await c.query(
    `SELECT ci.id, ci.contact_id FROM contact_identities ci JOIN contacts ct ON ct.id=ci.contact_id
     LEFT JOIN conversations cv ON cv.contact_id=ct.id
     WHERE ci.workspace_id=$1 AND ci.kind='phone' AND ci.normalized=$2 AND ct.merged_into IS NULL
     ORDER BY cv.last_message_at DESC NULLS LAST, ci.created_at LIMIT 1`, [ws, e164])).rows[0];
  if (!ident) {
    const ct = (await c.query(`INSERT INTO contacts (workspace_id, first_name, tags) VALUES ($1,$2,'{new-lead}') RETURNING id`, [ws, e164])).rows[0];
    ident = (await c.query(`INSERT INTO contact_identities (workspace_id, contact_id, kind, original_value, normalized, is_primary) VALUES ($1,$2,'phone',$3,$4,true) RETURNING id, contact_id`, [ws, ct.id, ev.from, e164])).rows[0];
  }
  const contact = (await c.query('SELECT * FROM contacts WHERE id=$1', [ident.contact_id])).rows[0];
  if (contact.inbound_blocked) return;   // administratively blocked: ledger records receipt, nothing surfaces

  const conv = (await c.query(
    `INSERT INTO conversations (workspace_id, contact_id, channel_id, contact_identity_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, contact_id, channel_id) DO UPDATE SET contact_identity_id=COALESCE(conversations.contact_identity_id, EXCLUDED.contact_identity_id)
     RETURNING id`, [ws, contact.id, ch.id, ident.id])).rows[0];

  await c.query(`SELECT 1 FROM conversations WHERE id=$1 FOR UPDATE`, [conv.id]);
  const msg = await c.query(
    `INSERT INTO messages (workspace_id, conversation_id, direction, sender_type, body, status, provider, provider_message_id, from_original, to_original, source_ts)
     VALUES ($1,$2,'inbound','customer',$3,'received',$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING id`,
    [ws, conv.id, ev.body, provider, ev.providerMessageId, ev.from, ev.to, ev.occurredAt]);
  if (!msg.rowCount) return;   // same provider message id seen under a different event id

  // Inbound reopens the thread, flips responsibility to us, and bumps the fence so stale queued automation cannot reply.
  await c.query(
    `UPDATE conversations SET status='open', responsibility='needs_our_reply', last_inbound_at=$2, last_message_at=GREATEST(COALESCE(last_message_at,$2),$2), last_preview=$3, revision=revision+1 WHERE id=$1`,
    [conv.id, ev.occurredAt, ev.body.slice(0, 140)]);

  await touchSummary(c, ws, contact.id);
  // Inbound MMS: only inline content is stored here. URL-only attachments need an authenticated, SSRF-safe provider fetch adapter (not built).
  for (const m of ev.media ?? []) {
    if (!m.dataBase64) { await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'message','Inbound attachment not fetched: provider media fetch is not implemented')`, [ws, contact.id, conv.id]); continue; }
    try {
      const saved = await saveMedia({ workspaceId: ws }, { filename: `mms-${ev.providerMessageId}`, data: Buffer.from(m.dataBase64, 'base64'), origin: 'inbound_mms', contactId: contact.id }, c);
      await c.query('INSERT INTO message_attachments (message_id, media_id) VALUES ($1,$2)', [msg.rows[0].id, saved.id]);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'message',$4)`, [ws, contact.id, conv.id, `Inbound attachment rejected: ${e.message}`]);
    }
  }
  const who = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || e164;
  await notify(c, { workspaceId: ws, userIds: await recipientsForConversation(c, conv.id), type: 'inbound_message', title: `New text from ${who}`, conversationId: conv.id });

  // A reply to a review request is PRIVATE FEEDBACK: tag it so staff handle it as such (it is never auto-published or filtered).
  const rr = await c.query(`SELECT 1 FROM messages m JOIN broadcast_recipients r ON r.message_id=m.id JOIN broadcasts b ON b.id=r.broadcast_id WHERE m.conversation_id=$1 AND b.kind='review_request' AND m.created_at > now() - interval '7 days' LIMIT 1`, [conv.id]);
  if (rr.rowCount) { await c.query(`UPDATE conversations SET tags = CASE WHEN 'review-feedback' = ANY(tags) THEN tags ELSE array_append(tags,'review-feedback') END WHERE id=$1`, [conv.id]); await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary) VALUES ($1,$2,$3,'message','Reply to a review request (private feedback)')`, [ws, contact.id, conv.id]); }
  const kw = classifyKeyword(ev.body);
  if (!kw) {   // automation reacts only to real conversation, never to STOP/START/HELP
    await enqueue(c, 'auto_respond', { conversationId: conv.id, messageId: msg.rows[0].id }, { workspaceId: ws, dedupeKey: msg.rows[0].id });
    await enqueue(c, 'workflow_event', { type: 'inbound_message', conversationId: conv.id, messageId: msg.rows[0].id }, { workspaceId: ws, dedupeKey: `wf:${msg.rows[0].id}` });
  }
  if (kw === 'stop') {
    await recordConsent(c, { workspaceId: ws, contactId: contact.id, type: 'sms_stop', source: 'inbound_keyword', evidence: ev.body, occurredAt: ev.occurredAt });
    // Cancel anything still queued for this contact (except compliance) — opt-out wins over pending sends.
    await c.query(`UPDATE messages SET status='suppressed', status_detail='sms_opted_out' WHERE conversation_id=$1 AND status='queued' AND purpose<>'compliance'`, [conv.id]);
    await c.query(`UPDATE conversations SET responsibility='closed', status='closed' WHERE id=$1`, [conv.id]);
  } else if (kw === 'start' && contact.sms_opted_out) {
    await recordConsent(c, { workspaceId: ws, contactId: contact.id, type: 'sms_start', source: 'inbound_keyword', evidence: ev.body, occurredAt: ev.occurredAt });
  } else if (kw === 'help') {
    await recordConsent(c, { workspaceId: ws, contactId: contact.id, type: 'sms_help', source: 'inbound_keyword', evidence: ev.body, occurredAt: ev.occurredAt });
  }
  // Provider-level auto replies (e.g. carriers answering STOP) would double-acknowledge; only ack ourselves if the channel says the provider doesn't.
  if (kw && !ch.provider_auto_replies && (kw !== 'start' || contact.sms_opted_out)) {
    const text = kw === 'stop' ? 'Sun Sport Marine: You are unsubscribed and will receive no more texts. Reply START to resubscribe.'
      : kw === 'start' ? 'Sun Sport Marine: You are resubscribed. Reply STOP to opt out, HELP for help.'
      : 'Sun Sport Marine: Reply STOP to opt out. For help call the dealership. Msg&data rates may apply.';
    const convId = conv.id as string;
    post.push(() => queueOutbound({ workspaceId: ws, conversationId: convId, body: text, senderType: 'system', purpose: 'compliance', idempotencyKey: `ack:${provider}:${ev.eventId}` }));
  }
  await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, conversation_id, type, summary, origin_table, origin_id, occurred_at) VALUES ($1,$2,$3,'message','Inbound text received','messages',$4,$5)`,
    [ws, contact.id, conv.id, msg.rows[0].id, ev.occurredAt]);
  await emitEvent(c, ws, 'message.received', { conversationId: conv.id, messageId: msg.rows[0].id, contactId: contact.id, channel: 'sms' }, { body: ev.body, from: e164 });
  await publish(c, ws, 'message.created', { conversationId: conv.id, inbound: true });
}
