import { pool } from '../db/pool.js';
import { enqueue } from './queue.js';
import { sign } from '../integrations/signing.js';
import { safeRequest, UnsafeUrlError } from '../integrations/ssrf.js';
import { webhookSecretOf } from './service-identities.js';
import { webhookTransport } from './webhooks.js';
import { pullEvents } from './service-events.js';
import { ackEvents } from './service-events.js';

const backoff = (n: number) => Math.min(15 * 2 ** (n - 1), 1800);

/**
 * Optional push of the event feed to the assistant's own endpoint. Same contract as pulling: the batch is redelivered until the endpoint
 * answers 2xx (which counts as the acknowledgement). Pull remains available at all times, so push is only ever a latency optimisation.
 */
export async function pushEventsOnce(identityId: string): Promise<'delivered' | 'retry' | 'idle' | 'disabled'> {
  const row = (await pool.query(`SELECT * FROM service_identities WHERE id=$1`, [identityId])).rows[0];
  if (!row || row.status !== 'active' || !row.webhook_url || !row.webhook_secret_enc) return 'disabled';
  const ctx = { identityId: row.id, keyId: '', workspaceId: row.workspace_id, name: row.name, scopes: new Set<string>(row.scopes), autonomy: row.autonomy, departmentIds: row.department_ids, rateLimitPerMin: row.rate_limit_per_min,
    actor: { userId: row.id, workspaceId: row.workspace_id, role: 'staff' as const, departmentIds: row.department_ids } };
  if (!ctx.scopes.has('events:read')) return 'disabled';
  const batch = await pullEvents(ctx, { limit: 50 });
  if (!batch.events.length) { await ackEvents(ctx, batch.head); return 'idle'; }   // nothing visible to this identity: advance past invisible events
  const body = JSON.stringify({ identity: row.name, events: batch.events });
  const attempt = row.push_attempts + 1;
  try {
    const res = await safeRequest(row.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Relay-Assistant-Events/1', 'x-relay-signature': sign(webhookSecretOf(row), Math.floor(Date.now() / 1000), body), 'x-relay-delivery-attempt': String(attempt) }, body, ...webhookTransport.opts });
    if (res.status >= 200 && res.status < 300) {
      await ackEvents(ctx, batch.events[batch.events.length - 1].seq);
      if (batch.hasMore) await enqueue(pool, 'service_event_push', { identityId }, { workspaceId: row.workspace_id, dedupeKey: `${identityId}:more:${Date.now()}` });
      return 'delivered';
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const permanent = e instanceof UnsafeUrlError;
    await pool.query('UPDATE service_identities SET push_attempts=$2, push_last_error=$3 WHERE id=$1', [identityId, attempt, (permanent ? 'blocked: ' : '') + (e as Error).message.slice(0, 300)]);
    if (!permanent) await enqueue(pool, 'service_event_push', { identityId }, { workspaceId: row.workspace_id, runAt: new Date(Date.now() + backoff(attempt) * 1000), dedupeKey: `${identityId}:retry:${attempt}` });
    return 'retry';
  }
}
