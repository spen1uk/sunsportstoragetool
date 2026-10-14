import type { PoolClient } from 'pg';
import { pool, tx } from '../db/pool.js';
import { checkSmsAllowed, type Purpose } from './consent.js';
import { enqueue } from './queue.js';
import { publish } from './events.js';
import { getProvider } from '../providers/sms.js';
import { HttpError } from './authz.js';
import { validateAttachments, signedMediaUrls } from './media.js';
import { verifyPackageFresh, recordPackageSent } from './outreach.js';
import { touchSummary } from './summary.js';
import { emitServiceEvent } from './service-events.js';

export type SenderType = 'staff' | 'sandra' | 'automation' | 'system';
export interface OutboundRequest {
  workspaceId: string; conversationId: string; body: string;
  senderType: SenderType; senderUserId?: string | null; purpose?: Purpose;
  idempotencyKey: string;
  /** Fencing token the sender observed (required for sandra/automation). Rejected if conversation.revision moved. */
  expectedRevision?: number;
  /** Human concurrent-reply guard: reject if messages newer than this seq exist from someone else, unless force. */
  ifLastSeq?: number; force?: boolean;
  mediaIds?: string[];
  /** Marks automation-originated traffic for analytics and cadence rules. */
  autoKind?: 'first_contact' | 'after_hours' | 'holiday' | 'follow_up' | 'workflow' | 'broadcast';
  /** Passive sends (auto-acknowledgments, broadcasts) don't change who owes the next move, don't bump the fence, and don't reopen closed threads. */
  passive?: boolean;
  /** Outreach package snapshot id: boat price/availability are re-verified immediately before queueing. */
  packageId?: string;
  /** Set for messages sent through the assistant API (audit + emergency-stop suppression). */
  serviceIdentityId?: string;
}
export type OutboundResult =
  | { ok: true; messageId: string; duplicate: boolean; status: string }
  | { ok: false; reason: string; messageId?: string };

/**
 * THE one send pipeline for staff, scheduled, broadcast, automation and Sandra messages.
 * Order: idempotency → lock conversation → fencing/mode → consent → persist (outbox row) → enqueue job.
 */
export async function queueOutbound(req: OutboundRequest): Promise<OutboundResult> {
  return tx((c) => queueOutboundTx(c, req));
}

/** Same pipeline, inside a caller-owned transaction (used by the scheduler so cancel/send cannot race). */
export async function queueOutboundTx(c: PoolClient, req: OutboundRequest): Promise<OutboundResult> {
  const purpose = req.purpose ?? 'conversational';
  {
    const dup = await c.query('SELECT id, status FROM messages WHERE workspace_id=$1 AND idempotency_key=$2', [req.workspaceId, req.idempotencyKey]);
    if (dup.rows[0]) return { ok: true as const, messageId: dup.rows[0].id, duplicate: true, status: dup.rows[0].status };

    const conv = (await c.query(
      `SELECT c.*, ct.inbound_blocked, ct.outbound_blocked, ct.do_not_text, ct.sms_opted_out, ct.marketing_status, ct.merged_into,
              ch.address AS from_addr, ci.original_value AS to_orig, ci.normalized AS to_e164
       FROM conversations c JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id
       LEFT JOIN contact_identities ci ON ci.id=c.contact_identity_id
       WHERE c.id=$1 AND c.workspace_id=$2 FOR UPDATE OF c`, [req.conversationId, req.workspaceId])).rows[0];
    if (!conv) throw new HttpError(404, 'conversation not found');
    if (!conv.to_e164) return { ok: false as const, reason: 'no_destination_number' };
    // Never send half-filled templates to customers.
    if (/\{\{\s*[a-z0-9_]+\s*\}\}/i.test(req.body)) return { ok: false as const, reason: 'unresolved_template_variables' };
    if (!req.body.trim() && !req.mediaIds?.length) return { ok: false as const, reason: 'empty_message' };

    if (req.senderType === 'sandra' || req.senderType === 'automation') {
      if (req.expectedRevision !== conv.revision) return { ok: false as const, reason: 'stale_revision' };
      if (conv.handling_mode === 'paused') return { ok: false as const, reason: 'automation_paused' };
      if (conv.handling_mode === 'draft_only') return { ok: false as const, reason: 'draft_only_mode' };
      if (req.senderType === 'sandra' && conv.handling_mode !== 'sandra') return { ok: false as const, reason: 'not_sandra_handling' };
      if (conv.status === 'closed') return { ok: false as const, reason: 'conversation_closed' };
      const ws = await c.query('SELECT global_automation_pause FROM workspaces WHERE id=$1', [req.workspaceId]);
      if (ws.rows[0]?.global_automation_pause) return { ok: false as const, reason: 'global_pause' };
    } else if (req.senderType === 'staff' && req.ifLastSeq !== undefined && !req.force) {
      const newer = await c.query(`SELECT 1 FROM messages WHERE conversation_id=$1 AND seq>$2 AND imported_batch_id IS NULL AND (direction='inbound' OR sender_user_id IS DISTINCT FROM $3) LIMIT 1`,
        [req.conversationId, req.ifLastSeq, req.senderUserId ?? null]);
      if (newer.rowCount) return { ok: false as const, reason: 'newer_messages' };
    }

    const verdict = checkSmsAllowed(conv, purpose);
    if (!verdict.allowed) {
      // Persist the suppression so staff can see WHY nothing was sent (never silently drop).
      const m = await c.query(
        `INSERT INTO messages (workspace_id, conversation_id, direction, sender_type, sender_user_id, purpose, body, status, status_detail, idempotency_key, fence_revision, service_identity_id)
         VALUES ($1,$2,'outbound',$3,$4,$5,$6,'suppressed',$7,$8,$9,$10) RETURNING id`,
        [req.workspaceId, req.conversationId, req.senderType, req.senderUserId ?? null, purpose, req.body, verdict.reason, req.idempotencyKey, conv.revision, req.serviceIdentityId ?? null]);
      await publish(c, req.workspaceId, 'message.created', { conversationId: req.conversationId });
      return { ok: false as const, reason: verdict.reason, messageId: m.rows[0].id };
    }

    if (req.mediaIds?.length) {
      const bad = await validateAttachments(c, req.workspaceId, req.mediaIds);
      if (bad) return { ok: false as const, reason: bad };
    }
    if (req.packageId) {
      const stale = await verifyPackageFresh(c, req.workspaceId, req.packageId);
      if (stale) return { ok: false as const, reason: stale };
    }

    const m = await c.query(
      `INSERT INTO messages (workspace_id, conversation_id, direction, sender_type, sender_user_id, purpose, body, status, idempotency_key, fence_revision, from_original, to_original, auto_kind, service_identity_id)
       VALUES ($1,$2,'outbound',$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12) RETURNING id, seq`,
      [req.workspaceId, req.conversationId, req.senderType, req.senderUserId ?? null, purpose, req.body, req.idempotencyKey, req.passive ? conv.revision : conv.revision + 1, conv.from_addr, conv.to_e164, req.autoKind ?? null, req.serviceIdentityId ?? null]);
    const msgId = m.rows[0].id as string;
    for (const mid of req.mediaIds ?? []) await c.query('INSERT INTO message_attachments (message_id, media_id) VALUES ($1,$2)', [msgId, mid]);
    if (req.packageId) await recordPackageSent(c, req.packageId, msgId);

    const nextResp = purpose === 'compliance' || req.passive ? conv.responsibility : 'waiting_on_customer';
    // A human/automation/Sandra send changes the context → bump revision so other stale pending sends are fenced out.
    // Passive sends (acknowledgments, broadcasts) leave the fence, responsibility and open/closed state alone.
    // fence_revision on the message stores the revision EXPECTED at send time (after our own bump), re-checked by the worker.
    await c.query(
      `UPDATE conversations SET last_outbound_at=now(), last_message_at=now(), last_preview=$2, responsibility=$3,
         revision=revision+CASE WHEN $5 THEN 0 ELSE 1 END, status=CASE WHEN status='closed' AND $4 AND NOT $5 THEN 'open' ELSE status END WHERE id=$1`,
      [req.conversationId, req.body.slice(0, 140), nextResp, req.senderType === 'staff', !!req.passive]);
    await touchSummary(c, req.workspaceId, conv.contact_id);
    await enqueue(c, 'send_message', { messageId: msgId }, { workspaceId: req.workspaceId, dedupeKey: msgId });
    await publish(c, req.workspaceId, 'message.created', { conversationId: req.conversationId });
    return { ok: true as const, messageId: msgId, duplicate: false, status: 'queued' };
  }
}

/** Worker handler. Never blindly retries an ambiguous send. */
export async function handleSendMessageJob(messageId: string) {
  // Atomically claim the message: queued → sending. Anything else means someone else handled it (or a prior attempt crashed mid-send).
  const claimed = await pool.query(`UPDATE messages SET status='sending' WHERE id=$1 AND status='queued' RETURNING id`, [messageId]);
  if (!claimed.rowCount) {
    const cur = await pool.query('SELECT status FROM messages WHERE id=$1', [messageId]);
    if (cur.rows[0]?.status === 'sending') {
      // A previous attempt died after claiming. The provider may or may not have received it → unknown, do NOT resend.
      await setStatus(messageId, 'unknown', 'worker interrupted during send; provider outcome unverified');
    }
    return;
  }
  const row = (await pool.query(
    `SELECT m.*, c.revision, c.handling_mode, c.status AS conv_status, ct.inbound_blocked, ct.outbound_blocked, ct.do_not_text, ct.sms_opted_out, ct.marketing_status,
            ch.provider, ch.is_simulated, ch.is_live_enabled, ch.address
     FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id JOIN channels ch ON ch.id=c.channel_id WHERE m.id=$1`, [messageId])).rows[0];

  // Re-evaluate at execution time (scheduled/queued sends may have gone stale).
  const verdict = checkSmsAllowed(row, row.purpose);
  if (!verdict.allowed) return setStatus(messageId, 'suppressed', verdict.reason);
  if ((row.sender_type === 'sandra' || row.sender_type === 'automation')) {
    if (row.handling_mode === 'paused' || row.handling_mode === 'draft_only') return setStatus(messageId, 'suppressed', 'handling_mode_changed');
    // fence_revision is the revision expected after our own enqueue; anything else means new context (inbound/takeover/other send).
    if (row.revision !== row.fence_revision) return setStatus(messageId, 'suppressed', 'stale_revision');
  }
  if (!row.is_simulated && !row.is_live_enabled) return setStatus(messageId, 'failed', 'live sending not enabled for this channel (owner approval required)');

  const provider = getProvider(row.provider);
  if (!provider) return setStatus(messageId, 'failed', `no adapter registered for ${row.provider}`);

  const media = await signedMediaUrls(messageId);
  const outcome = await provider.send({ from: row.address, to: row.to_original, body: row.body, idempotencyKey: row.idempotency_key ?? row.id, media }).catch((e): import('../providers/sms.js').SendOutcome => ({ kind: 'ambiguous', error: String(e?.message ?? e) }));
  switch (outcome.kind) {
    case 'accepted':
      await pool.query(`UPDATE messages SET status='provider_accepted', provider=$2, provider_message_id=$3, status_detail=NULL WHERE id=$1`, [messageId, row.provider, outcome.providerMessageId]);
      await touch(messageId); return;
    case 'rejected': return setStatus(messageId, 'failed', outcome.error);
    case 'ambiguous': return setStatus(messageId, 'unknown', outcome.error);
    case 'not_sent':
      await pool.query(`UPDATE messages SET status='queued', status_detail=$2 WHERE id=$1`, [messageId, outcome.error]);
      throw new Error(`not sent, will retry: ${outcome.error}`);
  }
}

async function setStatus(messageId: string, status: string, detail: string) {
  await pool.query(`UPDATE messages SET status=$2, status_detail=$3 WHERE id=$1`, [messageId, status, detail]);
  await touch(messageId);
}
async function touch(messageId: string) {
  const r = await pool.query('SELECT workspace_id, conversation_id, status, status_detail, sender_type FROM messages WHERE id=$1', [messageId]);
  if (r.rows[0]) {
    await publish(pool, r.rows[0].workspace_id, 'message.updated', { conversationId: r.rows[0].conversation_id, messageId });
    if (r.rows[0].sender_type === 'sandra') await emitServiceEvent(pool, r.rows[0].workspace_id, 'message.status_changed', { conversationId: r.rows[0].conversation_id, payload: { messageId, status: r.rows[0].status, detail: r.rows[0].status_detail } });
  }
}

export type Db = PoolClient;
