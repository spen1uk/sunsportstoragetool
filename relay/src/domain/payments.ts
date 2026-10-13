import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, tx } from '../db/pool.js';
import { HttpError, atLeastManager, canSeeContact, type Actor } from './authz.js';
import { audit, publish } from './events.js';
import { notify } from './notifications.js';
import { openConversationFor } from './contacts.js';
import { PermanentAuthError, TransientError, getAdapter, type NormalizedPaymentEvent } from '../integrations/adapter.js';
import { assertWritable, ensureFreshToken, getCredentials, withAuth, type ConnRow } from '../integrations/connections.js';
import { maskSecrets } from '../integrations/crypto.js';
import { emitEvent } from './outbound-events.js';
import { enqueue } from './queue.js';

/** Our own sanity ceiling per request ($250,000) — not a provider limit. */
export const MAX_AMOUNT_CENTS = 25_000_000;
const manager = (a: Actor) => { if (!atLeastManager(a)) throw new HttpError(403, 'manager role required for payment requests'); };
const createSchema = z.object({ contactId: z.string().uuid(), amountCents: z.number().int().min(1).max(MAX_AMOUNT_CENTS), currency: z.string().regex(/^[a-z]{3}$/).default('usd'), description: z.string().min(1).max(200), reference: z.string().max(100).optional(), expiresInHours: z.number().int().min(1).max(24 * 30).default(72) });

export async function createPaymentRequest(a: Actor, input: unknown) {
  manager(a); const b = createSchema.parse(input);
  if (!(await canSeeContact(pool, a, b.contactId))) throw new HttpError(404, 'contact not found');
  const r = await pool.query(`INSERT INTO payment_requests (workspace_id, contact_id, created_by, amount_cents, currency, description, reference, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8||' hours')::interval) RETURNING id`, [a.workspaceId, b.contactId, a.userId, b.amountCents, b.currency, b.description, b.reference ?? null, String(b.expiresInHours)]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'payment.request.create', targetType: 'payment_request', targetId: r.rows[0].id, meta: { amountCents: b.amountCents } });
  return r.rows[0].id as string;
}

async function load(a: Actor, id: string) { const r = (await pool.query('SELECT * FROM payment_requests WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0]; if (!r) throw new HttpError(404, 'payment request not found'); if (!(await canSeeContact(pool, a, r.contact_id))) throw new HttpError(404, 'payment request not found'); return r; }

/** Create the provider-hosted link. Idempotent per request (the request id is the idempotency key), so retrying an uncertain create cannot produce a second link. */
export async function createLink(a: Actor, id: string, connectionId?: string) {
  manager(a); const r = await load(a, id); if (r.status !== 'draft') throw new HttpError(409, `payment request is ${r.status}`);
  const conn = (await pool.query(`SELECT * FROM connections WHERE workspace_id=$1 AND status='connected' AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at`, [a.workspaceId, connectionId ?? null])).rows.find((c) => getAdapter(c.provider)?.createPaymentLink) as ConnRow | undefined;
  if (!conn) throw new HttpError(409, 'No payments provider is connected. Connect one under Connections (or use the sandbox provider to try the flow).');
  assertWritable(conn); const ad = getAdapter(conn.provider)!;
  const claim = await pool.query(`UPDATE payment_requests SET status_detail='creating', updated_at=now() WHERE id=$1 AND status='draft' AND (status_detail IS DISTINCT FROM 'creating' OR updated_at < now() - interval '5 minutes') RETURNING id`, [id]);
  if (!claim.rowCount) throw new HttpError(409, 'a link is already being created for this request');
  let creds; try {
    const out = await withAuth(conn, (cr) => { creds = cr; return ad.createPaymentLink!(cr, { amountCents: Number(r.amount_cents), currency: r.currency, description: r.description, idempotencyKey: id, expiresAt: r.expires_at, reference: r.reference ?? undefined }); });
    await pool.query(`UPDATE payment_requests SET status='open', status_detail=NULL, connection_id=$2, provider=$3, provider_ref=$4, pay_url=$5, updated_at=now() WHERE id=$1`, [id, conn.id, conn.provider, out.providerRef, out.url]);
    await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'payment.link.created', targetType: 'payment_request', targetId: id, meta: { provider: conn.provider } });
    return { status: 'open', url: out.url };
  } catch (e) {
    const err = e as Error, msg = maskSecrets(err.message, creds ?? {});
    if (err instanceof TransientError) { await pool.query(`UPDATE payment_requests SET status_detail=NULL WHERE id=$1`, [id]); throw new HttpError(503, `no link was created (temporary problem); you can retry: ${msg}`); }
    if (/^ambiguous:/i.test(err.message)) { await pool.query(`UPDATE payment_requests SET status_detail='creation_outcome_unknown: retry is safe (same idempotency key)' WHERE id=$1`, [id]); throw new HttpError(502, 'the provider may or may not have created the link; retrying is safe and will not create a second one'); }
    await pool.query(`UPDATE payment_requests SET status_detail=$2 WHERE id=$1`, [id, `provider refused: ${msg}`.slice(0, 300)]); throw new HttpError(err instanceof PermanentAuthError ? 409 : 502, `the provider did not create the link: ${msg}`);
  }
}

/** Draft text for the composer. NOTHING is sent: a person reviews it and presses Send. */
export async function linkMessageDraft(a: Actor, id: string) {
  const r = await load(a, id); if (r.status !== 'open' || !r.pay_url) throw new HttpError(409, 'create the payment link first (status must be open)');
  const conversationId = await openConversationFor(a, r.contact_id);
  return { conversationId, body: `Here is your secure payment link for ${r.description} ($${(Number(r.amount_cents) / 100).toFixed(2)}): ${r.pay_url}` };
}

// ---------- status is DERIVED from verified events ----------
/**
 * paid/refunded are CUMULATIVE totals: the larger of (sum of signed webhook events) and (latest authenticated provider snapshot).
 * Both measure the same thing, so overlap between a late webhook and a reconciliation can never double-count, and either one alone is enough.
 */
export function deriveStatus(req: { amount_cents: number | string; status: string; cancelled_locally: boolean; snap_paid_cents?: number | string; snap_refunded_cents?: number | string; snap_expired?: boolean }, ev: { type: string; amount_cents: number | string | null; terminal: boolean }[]) {
  const amt = Number(req.amount_cents); const sum = (t: string) => ev.filter((e) => e.type === t).reduce((n, e) => n + Number(e.amount_cents ?? 0), 0);
  const paid = Math.max(sum('succeeded'), Number(req.snap_paid_cents ?? 0)), refunded = Math.max(sum('refunded'), Number(req.snap_refunded_cents ?? 0)); let status = 'open'; let detail: string | null = null;
  if (refunded > 0 && paid === 0) { status = req.status; detail = 'refund reported before the payment event; waiting for the payment event'; }       // out-of-order: never conclude from a refund alone
  else if (refunded > 0) { status = refunded >= paid ? 'refunded' : 'partially_refunded'; if (refunded > paid) detail = 'refunded amount exceeds paid amount: check with the provider'; }
  else if (paid >= amt) { status = 'paid'; if (paid > amt) detail = 'customer paid more than the requested amount'; }
  else if (paid > 0) status = 'partially_paid';
  else if (ev.some((e) => e.type === 'failed' && e.terminal)) status = 'failed';
  else if (ev.some((e) => e.type === 'expired') || req.snap_expired) status = 'expired';
  else if (ev.some((e) => e.type === 'cancelled') || req.cancelled_locally) { status = 'cancelled'; if (req.cancelled_locally && !ev.some((e) => e.type === 'cancelled')) detail = 'cancelled in Relay; the provider link may still be payable'; }
  return { status, paid, refunded, detail };
}

async function recompute(c: PoolClient, requestId: string) {
  const req = (await c.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0]; const ev = (await c.query('SELECT type, amount_cents, terminal, receipt_url, occurred_at FROM payment_events WHERE payment_request_id=$1 ORDER BY occurred_at NULLS LAST, received_at', [requestId])).rows;
  const d = deriveStatus(req, ev); const receipt = [...ev].reverse().find((e) => e.receipt_url)?.receipt_url ?? req.receipt_url;
  if (d.status === req.status && d.paid === Number(req.paid_cents) && d.refunded === Number(req.refunded_cents) && receipt === req.receipt_url) { if (d.detail !== req.status_detail && req.status_detail !== 'creating') await c.query('UPDATE payment_requests SET status_detail=$2 WHERE id=$1', [requestId, d.detail]); return false; }
  await c.query(`UPDATE payment_requests SET status=$2, paid_cents=$3, refunded_cents=$4, receipt_url=$5, status_detail=$6, updated_at=now() WHERE id=$1`, [requestId, d.status, d.paid, d.refunded, receipt, d.detail]);
  await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, type, summary, origin_table, origin_id) VALUES ($1,$2,'payment',$3,'payment_requests',$4)`, [req.workspace_id, req.contact_id, `Payment “${req.description}” is now ${d.status.replaceAll('_', ' ')} (verified by the provider)`, requestId]);
  await notify(c, { workspaceId: req.workspace_id, userIds: [req.created_by], type: 'payment', title: `Payment “${req.description}”: ${d.status.replaceAll('_', ' ')}` });
  await emitEvent(c, req.workspace_id, 'payment.updated', { paymentRequestId: requestId, status: d.status, paidCents: d.paid, refundedCents: d.refunded, amountCents: Number(req.amount_cents), currency: req.currency });
  await publish(c, req.workspace_id, 'payment.updated', { paymentRequestId: requestId });
  return true;
}

export async function recordEvent(conn: ConnRow, ev: NormalizedPaymentEvent, source: 'signed_webhook' | 'provider_api' = 'signed_webhook'): Promise<'recorded' | 'duplicate' | 'unmatched'> {
  return tx(async (c) => {
    const req = (await c.query('SELECT id FROM payment_requests WHERE workspace_id=$1 AND provider=$2 AND provider_ref=$3', [conn.workspace_id, conn.provider, ev.providerRef])).rows[0];
    if (!req) { await audit(c, { workspaceId: conn.workspace_id, actorType: 'system', action: 'payment.event.unmatched', targetType: 'connection', targetId: conn.id, meta: { providerRef: ev.providerRef, type: ev.type } }); return 'unmatched' as const; }
    const ins = await c.query(`INSERT INTO payment_events (payment_request_id, provider, provider_event_id, type, amount_cents, terminal, receipt_url, source, occurred_at, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [req.id, conn.provider, ev.providerEventId, ev.type, ev.amountCents ?? null, !!ev.terminal, ev.receiptUrl ?? null, source, ev.occurredAt, JSON.stringify(ev)]);
    if (!ins.rowCount) return 'duplicate' as const;
    await recompute(c, req.id); return 'recorded' as const;
  });
}

/** Provider → Relay. Authenticated ONLY by the provider's signature; the browser success URL has no effect on status. */
export async function handlePaymentWebhook(connectionId: string, headers: Record<string, string | string[] | undefined>, raw: string) {
  const conn = (await pool.query('SELECT * FROM connections WHERE id=$1', [connectionId])).rows[0] as ConnRow | undefined;
  if (!conn || conn.status !== 'connected' || !conn.credentials_enc) throw new HttpError(401, 'connection is not active');
  const ad = getAdapter(conn.provider); if (!ad?.verifyWebhook) throw new HttpError(404, 'this connection does not accept payment webhooks');
  let events: NormalizedPaymentEvent[]; try { events = ad.verifyWebhook(headers, raw, getCredentials(conn)); } catch (e) { throw new HttpError(401, `signature rejected: ${(e as Error).message}`); }
  const out = { recorded: 0, duplicate: 0, unmatched: 0 }; for (const ev of events) out[await recordEvent(conn, ev, 'signed_webhook')]++;
  return out;
}

/** Catch missed webhooks: compare provider TOTALS with ours and record only the difference. A provider that reports LESS than us is flagged, never auto-corrected. */
export async function reconcileOne(id: string): Promise<'ok' | 'filled' | 'mismatch' | 'skipped'> {
  const r = (await pool.query('SELECT * FROM payment_requests WHERE id=$1', [id])).rows[0]; if (!r?.connection_id || !r.provider_ref) return 'skipped';
  const conn = (await pool.query('SELECT * FROM connections WHERE id=$1', [r.connection_id])).rows[0] as ConnRow; const ad = getAdapter(conn.provider);
  if (conn.status !== 'connected' || !ad?.getPaymentSnapshot) return 'skipped';
  let snap; try { snap = await ad.getPaymentSnapshot(await ensureFreshToken(conn), r.provider_ref); } catch { return 'skipped'; }
  if (!snap) return 'skipped';
  return tx(async (c) => {
    const cur = (await c.query('SELECT * FROM payment_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const effPaid = Math.max(Number(cur.paid_cents), 0), effRef = Math.max(Number(cur.refunded_cents), 0);
    if (snap.paidCents < effPaid || snap.refundedCents < effRef) {                                  // provider reports LESS than our verified events: flag, never auto-correct
      await c.query(`UPDATE payment_requests SET status_detail='MISMATCH: provider totals are lower than Relay''s verified events; check with the provider', snap_at=now() WHERE id=$1`, [id]);
      await audit(c, { workspaceId: cur.workspace_id, actorType: 'system', action: 'payment.reconcile.mismatch', targetType: 'payment_request', targetId: id, meta: { providerPaid: snap.paidCents, relayPaid: effPaid, providerRefunded: snap.refundedCents, relayRefunded: effRef } });
      return 'mismatch' as const;
    }
    await c.query(`UPDATE payment_requests SET snap_paid_cents=GREATEST(snap_paid_cents,$2), snap_refunded_cents=GREATEST(snap_refunded_cents,$3), snap_expired=snap_expired OR $4, snap_at=now(), receipt_url=COALESCE($5, receipt_url) WHERE id=$1`, [id, snap.paidCents, snap.refundedCents, snap.state === 'expired' && effPaid === 0, snap.receiptUrl ?? null]);
    const changed = await recompute(c, id);
    if (changed) await audit(c, { workspaceId: cur.workspace_id, actorType: 'system', action: 'payment.reconcile.filled', targetType: 'payment_request', targetId: id, meta: { providerPaid: snap.paidCents, providerRefunded: snap.refundedCents } });
    return changed ? 'filled' as const : 'ok' as const;
  });
}
export async function reconcileOpen(): Promise<number> { let n = 0; for (const r of (await pool.query(`SELECT id FROM payment_requests WHERE status IN ('open','partially_paid') AND provider_ref IS NOT NULL AND updated_at < now() - interval '2 minutes'`)).rows) if ((await reconcileOne(r.id)) === 'filled') n++; return n; }
export const schedulePaymentReconcile = () => enqueue(pool, 'payment_reconcile', {}, { runAt: new Date(Date.now() + 600_000), dedupeKey: 'scan' });

export async function refund(a: Actor, id: string, amountCents: number) {
  manager(a); const r = await load(a, id); if (!r.connection_id) throw new HttpError(409, 'no provider payment to refund');
  const remaining = Number(r.paid_cents) - Number(r.refunded_cents); if (!Number.isInteger(amountCents) || amountCents < 1 || amountCents > remaining) throw new HttpError(400, `refund must be between 1 and ${remaining} cents`);
  const conn = (await pool.query('SELECT * FROM connections WHERE id=$1', [r.connection_id])).rows[0] as ConnRow; assertWritable(conn); const ad = getAdapter(conn.provider);
  if (!ad?.refundPayment) throw new HttpError(409, 'this provider integration cannot issue refunds');
  const key = `refund:${id}:${Number(r.refunded_cents)}:${amountCents}`;
  await withAuth(conn, (cr) => ad.refundPayment!(cr, r.provider_ref, amountCents, key));
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'payment.refund.requested', targetType: 'payment_request', targetId: id, meta: { amountCents } });
  return { requested: true, note: 'Relay will show the refund only when the provider confirms it (signed webhook or reconciliation).' };       // local state is NOT changed here
}
export async function cancelRequest(a: Actor, id: string) {
  manager(a); const r = await load(a, id); if (!['draft', 'open'].includes(r.status)) throw new HttpError(409, `cannot cancel a ${r.status} request`);
  await tx(async (c) => { await c.query('UPDATE payment_requests SET cancelled_locally=true WHERE id=$1', [id]); await recompute(c, id); });
}
export async function setAccountingRef(a: Actor, id: string, ref: string | null, note: string | null) { manager(a); await load(a, id); await pool.query('UPDATE payment_requests SET accounting_ref=$2, accounting_note=$3 WHERE id=$1', [id, ref, note]); }

export async function listPayments(a: Actor) {
  const rows = (await pool.query(`SELECT p.id, p.contact_id, p.amount_cents, p.currency, p.description, p.reference, p.status, p.status_detail, p.paid_cents, p.refunded_cents, p.pay_url, p.provider, p.receipt_url, p.accounting_ref, p.accounting_note, p.expires_at, p.created_at, ct.first_name, ct.last_name, (c.sandbox_label) AS sandbox FROM payment_requests p JOIN contacts ct ON ct.id=p.contact_id LEFT JOIN LATERAL (SELECT (p.provider LIKE 'demo_%') AS sandbox_label) c ON true WHERE p.workspace_id=$1 ORDER BY p.created_at DESC LIMIT 200`, [a.workspaceId])).rows;
  const out = []; for (const r of rows) if (await canSeeContact(pool, a, r.contact_id)) out.push({ ...r, accounting: r.accounting_ref ? 'Reference recorded manually; balance NOT verified' : 'No accounting connection: invoice balances are not checked or changed by Relay' }); return out;
}
export async function getPayment(a: Actor, id: string) { const r = await load(a, id); const events = (await pool.query('SELECT type, amount_cents, terminal, source, occurred_at, received_at, provider_event_id FROM payment_events WHERE payment_request_id=$1 ORDER BY received_at', [id])).rows; return { ...r, events }; }

/** The page a customer lands on after paying. It NEVER changes status — only a verified provider event does. */
export async function returnPageHtml(id: string): Promise<string> {
  const r = /^[0-9a-f-]{36}$/i.test(id) ? (await pool.query('SELECT status, description FROM payment_requests WHERE id=$1', [id])).rows[0] : null;
  const msg = !r ? 'We could not find that payment.' : ['paid', 'partially_paid'].includes(r.status) ? 'Thank you — your payment has been confirmed by our payment provider.' : 'Thanks! We will confirm your payment as soon as our payment provider reports it. You do not need to do anything else.';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment — Sun Sport Marine</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Sun Sport Marine</h1><p>${msg.replace(/</g, '&lt;')}</p></body>`;
}
