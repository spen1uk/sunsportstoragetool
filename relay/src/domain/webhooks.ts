import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from './authz.js';
import { audit } from './events.js';
import { enqueue } from './queue.js';
import { notify } from './notifications.js';
import { normalizePhone } from './phone.js';
import { recordConsent } from './consent.js';
import { decryptJson, encryptJson } from '../integrations/crypto.js';
import { sign, verify } from '../integrations/signing.js';
import { assertSafeUrl, safeRequest, UnsafeUrlError, type SafeRequestOptions } from '../integrations/ssrf.js';
import { EVENT_TYPES, emitEvent } from './outbound-events.js';

const admin = (a: Actor) => { if (!isAdmin(a)) throw new HttpError(403, 'owner or admin required to manage webhooks'); };
const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;
/** Test seam: replace DNS/transport. Production uses the real resolver and a pinned-address HTTPS transport. */
export const webhookTransport: { opts: Pick<SafeRequestOptions, 'resolve' | 'transport'> } = { opts: {} };

// ---------- outbound subscriptions ----------
const subSchema = z.object({ url: z.string().url().max(500), events: z.array(z.enum([...EVENT_TYPES, '*'] as [string, ...string[]])).min(1), includeContent: z.boolean().default(false) });
export async function createSubscription(a: Actor, input: unknown) {
  admin(a); const b = subSchema.parse(input);
  try { await assertSafeUrl(b.url, webhookTransport.opts.resolve); } catch (e) { if (e instanceof UnsafeUrlError) throw new HttpError(400, `destination rejected: ${e.message}`); throw e; }
  const id = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id as string; const secret = newSecret('whsec'); const { enc, keyVersion } = encryptJson({ secret }, `wh:${id}`);
  await pool.query(`INSERT INTO webhook_subscriptions (id, workspace_id, url, secret_enc, key_version, events, include_content, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, a.workspaceId, b.url, enc, keyVersion, b.events, b.includeContent, a.userId]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'webhook.subscription.create', targetType: 'webhook_subscription', targetId: id, meta: { host: new URL(b.url).host, events: b.events, includeContent: b.includeContent } });
  return { id, secret, note: 'Store this signing secret now — it is shown only once.' };
}
export async function listSubscriptions(a: Actor) {
  admin(a); return (await pool.query(`SELECT s.id, s.url, s.events, s.include_content, s.active, s.disabled_reason, s.created_at, (SELECT count(*)::int FROM webhook_deliveries d WHERE d.subscription_id=s.id AND d.status IN ('pending','failed')) AS pending, (SELECT count(*)::int FROM webhook_deliveries d WHERE d.subscription_id=s.id AND d.status='dead') AS dead FROM webhook_subscriptions s WHERE s.workspace_id=$1 ORDER BY s.created_at DESC`, [a.workspaceId])).rows;
}
export async function setSubscriptionActive(a: Actor, id: string, active: boolean) { admin(a); const r = await pool.query(`UPDATE webhook_subscriptions SET active=$3, disabled_reason=CASE WHEN $3 THEN NULL ELSE 'disabled by an admin' END WHERE id=$1 AND workspace_id=$2 RETURNING id`, [id, a.workspaceId, active]); if (!r.rowCount) throw new HttpError(404, 'subscription not found'); }
export async function deleteSubscription(a: Actor, id: string) { admin(a); await pool.query('DELETE FROM webhook_subscriptions WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId]); await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'webhook.subscription.delete', targetType: 'webhook_subscription', targetId: id }); }
export async function rotateSubscriptionSecret(a: Actor, id: string) {
  admin(a); const secret = newSecret('whsec'); const { enc, keyVersion } = encryptJson({ secret }, `wh:${id}`);
  const r = await pool.query('UPDATE webhook_subscriptions SET secret_enc=$3, key_version=$4 WHERE id=$1 AND workspace_id=$2 RETURNING id', [id, a.workspaceId, enc, keyVersion]); if (!r.rowCount) throw new HttpError(404, 'subscription not found'); return { secret };
}
export async function sendPing(a: Actor, id: string) {
  admin(a); const s = (await pool.query('SELECT id FROM webhook_subscriptions WHERE id=$1 AND workspace_id=$2 AND active', [id, a.workspaceId])).rows[0]; if (!s) throw new HttpError(404, 'active subscription not found');
  await tx(async (c) => { await c.query(`UPDATE webhook_subscriptions SET events = CASE WHEN 'ping' = ANY(events) THEN events ELSE events END WHERE id=$1`, [id]); const eid = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id; const payload = { id: eid, type: 'ping', createdAt: new Date().toISOString(), data: { message: 'Test delivery from Relay' } };
    const d = (await c.query(`INSERT INTO webhook_deliveries (subscription_id, event_id, event_type, payload) VALUES ($1,$2,'ping',$3) RETURNING id`, [id, eid, JSON.stringify(payload)])).rows[0]; await enqueue(c, 'webhook_delivery', { deliveryId: d.id }, { dedupeKey: `${d.id}:0` }); });
}
export async function listDeliveries(a: Actor, subscriptionId: string) { admin(a); return (await pool.query(`SELECT d.id, d.event_type, d.status, d.attempts, d.response_status, d.last_error, d.next_attempt_at, d.delivered_at, d.created_at FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE s.id=$1 AND s.workspace_id=$2 ORDER BY d.created_at DESC LIMIT 100`, [subscriptionId, a.workspaceId])).rows; }
export async function redeliver(a: Actor, deliveryId: string) {
  admin(a); const r = await pool.query(`UPDATE webhook_deliveries d SET status='pending', attempts=0, next_attempt_at=now(), last_error=NULL FROM webhook_subscriptions s WHERE d.id=$1 AND s.id=d.subscription_id AND s.workspace_id=$2 AND d.status='dead' RETURNING d.id`, [deliveryId, a.workspaceId]);
  if (!r.rowCount) throw new HttpError(404, 'no dead delivery with that id'); await enqueue(pool, 'webhook_delivery', { deliveryId }, { dedupeKey: `${deliveryId}:redeliver:${Date.now()}` });
}

export const MAX_ATTEMPTS = 8;
const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 6 * 3600);
/** One delivery attempt. Retries (5xx, network, 408/429) are re-enqueued with exponential backoff; other 4xx are permanent; unsafe destinations disable the subscription. */
export async function deliverOnce(deliveryId: string): Promise<'delivered' | 'retry' | 'dead' | 'skipped'> {
  const d = (await pool.query(`SELECT d.*, s.url, s.secret_enc, s.active, s.workspace_id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=$1`, [deliveryId])).rows[0];
  if (!d || !['pending', 'failed'].includes(d.status)) return 'skipped';
  if (!d.active) { await pool.query(`UPDATE webhook_deliveries SET status='dead', last_error='subscription is disabled' WHERE id=$1`, [deliveryId]); return 'dead'; }
  const attempt = d.attempts + 1; const body = JSON.stringify(d.payload); const secret = decryptJson<{ secret: string }>(d.secret_enc, `wh:${d.subscription_id}`).secret;
  const headers = { 'content-type': 'application/json', 'user-agent': 'Relay-Webhooks/1', 'x-relay-event-id': d.event_id, 'x-relay-event-type': d.event_type, 'x-relay-delivery-attempt': String(attempt), 'x-relay-signature': sign(secret, Math.floor(Date.now() / 1000), body) };
  const finish = async (status: string, resp: number | null, err: string | null) => pool.query(`UPDATE webhook_deliveries SET status=$2, attempts=$3, response_status=$4, last_error=$5, delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END, next_attempt_at=CASE WHEN $2='failed' THEN now() + ($6||' seconds')::interval ELSE next_attempt_at END WHERE id=$1`, [deliveryId, status, attempt, resp, err, String(backoffSeconds(attempt))]);
  try {
    const res = await safeRequest(d.url, { method: 'POST', headers, body, ...webhookTransport.opts });
    if (res.status >= 200 && res.status < 300) { await finish('delivered', res.status, null); return 'delivered'; }
    if (res.status === 410) { await finish('dead', res.status, 'destination says it is gone (410)'); await pool.query(`UPDATE webhook_subscriptions SET active=false, disabled_reason='destination returned 410 Gone' WHERE id=$1`, [d.subscription_id]); return 'dead'; }
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    if (!retryable || attempt >= MAX_ATTEMPTS) { await finish('dead', res.status, `HTTP ${res.status}${retryable ? ' (gave up after retries)' : ' (not retryable)'}`); return 'dead'; }
    await finish('failed', res.status, `HTTP ${res.status}`);
  } catch (e) {
    if (e instanceof UnsafeUrlError) { await finish('dead', null, `blocked: ${e.message}`); await pool.query(`UPDATE webhook_subscriptions SET active=false, disabled_reason=$2 WHERE id=$1`, [d.subscription_id, `destination is no longer considered safe: ${e.message}`]); return 'dead'; }
    if (attempt >= MAX_ATTEMPTS) { await finish('dead', null, `${(e as Error).message} (gave up after retries)`); return 'dead'; }
    await finish('failed', null, (e as Error).message.slice(0, 300));
  }
  await enqueue(pool, 'webhook_delivery', { deliveryId }, { runAt: new Date(Date.now() + backoffSeconds(attempt) * 1000), dedupeKey: `${deliveryId}:${attempt}` });
  return 'retry';
}

// ---------- inbound lead endpoints (website forms etc.). They create/update CONTACTS only; they can never send a message. ----------
export async function createInboundEndpoint(a: Actor, name: string, defaultTags: string[] = []) {
  admin(a); const id = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id as string; const secret = newSecret('inhook'); const { enc, keyVersion } = encryptJson({ secret }, `in:${id}`);
  await pool.query(`INSERT INTO inbound_endpoints (id, workspace_id, name, secret_enc, key_version, default_tags, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, a.workspaceId, name.slice(0, 80), enc, keyVersion, defaultTags.slice(0, 10), a.userId]);
  return { id, url: `/hooks/inbound/${id}`, secret, note: 'Store this signing secret now — it is shown only once. Sign each request body as described in docs/WEBHOOKS.md.' };
}
export async function listInboundEndpoints(a: Actor) { admin(a); return (await pool.query('SELECT id, name, default_tags, active, created_at FROM inbound_endpoints WHERE workspace_id=$1 ORDER BY created_at DESC', [a.workspaceId])).rows; }
export async function setInboundActive(a: Actor, id: string, active: boolean) { admin(a); await pool.query('UPDATE inbound_endpoints SET active=$3 WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId, active]); }

const leadSchema = z.object({ eventId: z.string().min(8).max(100), firstName: z.string().max(60).optional(), lastName: z.string().max(60).optional(), phone: z.string().max(30).optional(), email: z.string().email().max(120).optional(), message: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(40)).max(5).optional(),
  consent: z.object({ marketing: z.object({ granted: z.literal(true), evidence: z.string().min(3).max(300), occurredAt: z.string().optional() }).optional() }).optional() });

export async function handleInboundLead(endpointId: string, headers: Record<string, string | string[] | undefined>, raw: string) {
  const ep = (await pool.query('SELECT * FROM inbound_endpoints WHERE id=$1', [endpointId])).rows[0];
  if (!ep || !ep.active) throw new HttpError(404, 'unknown endpoint');
  const sig = headers['x-relay-signature']; try { verify(decryptJson<{ secret: string }>(ep.secret_enc, `in:${ep.id}`).secret, Array.isArray(sig) ? sig[0] : sig, raw); } catch (e) { throw new HttpError(401, `signature rejected: ${(e as Error).message}`); }
  let body; try { body = leadSchema.parse(JSON.parse(raw)); } catch (e) { throw new HttpError(400, e instanceof z.ZodError ? `invalid lead: ${e.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}` : 'body must be JSON'); }
  if (!body.phone && !body.email) throw new HttpError(400, 'invalid lead: phone or email is required');
  const phone = body.phone ? normalizePhone(body.phone) : null; if (body.phone && !phone) throw new HttpError(400, 'invalid lead: phone is not a valid number');
  return tx(async (c) => {
    const fresh = await c.query('INSERT INTO inbound_events (endpoint_id, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [ep.id, body.eventId]);
    if (!fresh.rowCount) return { duplicate: true as const };                                                       // replay / retry: no second contact, no second note
    const tags = [...new Set(['web-lead', ...ep.default_tags, ...(body.tags ?? [])])];
    let contactId: string; let outcome: 'created' | 'matched' | 'created_needs_review';
    const matches = phone ? (await c.query(`SELECT DISTINCT ci.contact_id FROM contact_identities ci JOIN contacts ct ON ct.id=ci.contact_id WHERE ci.workspace_id=$1 AND ci.kind='phone' AND ci.normalized=$2 AND ct.merged_into IS NULL`, [ep.workspace_id, phone])).rows : [];
    if (matches.length === 1) { contactId = matches[0].contact_id; outcome = 'matched'; await c.query(`UPDATE contacts SET tags = (SELECT array_agg(DISTINCT t) FROM unnest(tags || $2::text[]) t), email=COALESCE(email,$3), updated_at=now() WHERE id=$1`, [contactId, tags, body.email ?? null]); }
    else {
      // 0 matches → new contact. 2+ matches means different people share this number: we DO NOT guess/merge — create a separate contact flagged for a human to review.
      outcome = matches.length === 0 ? 'created' : 'created_needs_review';
      contactId = (await c.query(`INSERT INTO contacts (workspace_id, first_name, last_name, email, tags) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ep.workspace_id, body.firstName ?? null, body.lastName ?? null, body.email ?? null, matches.length ? [...tags, 'needs-review'] : tags])).rows[0].id;
      if (phone) await c.query(`INSERT INTO contact_identities (workspace_id, contact_id, kind, original_value, normalized, is_primary) VALUES ($1,$2,'phone',$3,$4,true)`, [ep.workspace_id, contactId, body.phone, phone]);
    }
    if (body.message) await c.query(`INSERT INTO notes (workspace_id, contact_id, body) VALUES ($1,$2,$3)`, [ep.workspace_id, contactId, `Web form lead (${ep.name}) — customer wrote: ${body.message}`]);
    await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, type, summary) VALUES ($1,$2,'lead',$3)`, [ep.workspace_id, contactId, `Web lead received via “${ep.name}” (${outcome.replaceAll('_', ' ')})`]);
    // Marketing consent is recorded ONLY with explicit evidence from the form. A phone number alone is never consent.
    if (body.consent?.marketing) await recordConsent(c, { workspaceId: ep.workspace_id, contactId, type: 'marketing_opt_in', source: 'web_form', evidence: `${ep.name}: ${body.consent.marketing.evidence}`, occurredAt: body.consent.marketing.occurredAt ? new Date(body.consent.marketing.occurredAt) : undefined });
    const admins = (await c.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','admin')`, [ep.workspace_id])).rows.map((r) => r.user_id);
    await notify(c, { workspaceId: ep.workspace_id, userIds: admins, type: 'web_lead', title: `New web lead: ${[body.firstName, body.lastName].filter(Boolean).join(' ') || body.email || phone}` });
    return { duplicate: false as const, contactId, outcome };
  });
}
export { emitEvent };
