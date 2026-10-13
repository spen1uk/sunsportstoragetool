import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from '../domain/authz.js';
import { enqueue } from '../domain/queue.js';
import * as cx from '../integrations/connections.js';
import * as pay from '../domain/payments.js';
import * as rv from '../domain/reviews.js';
import * as wh from '../domain/webhooks.js';
import { fakePayServer, fakeReviewServer } from '../integrations/demo/fakeServers.js';
import { getAdapter } from '../integrations/adapter.js';

export function registerPhase5(app: FastifyInstance, A: (r: FastifyRequest) => Actor) {
  const id = (r: FastifyRequest) => z.string().uuid().parse((r.params as any).id);
  const uuid = z.string().uuid();

  // ----- connections -----
  app.get('/api/integrations', async (r) => cx.listIntegrations(A(r)));
  app.post('/api/integrations/:provider/connect', async (r) => { const b = z.object({ credentials: z.record(z.string(), z.any()), writeEnabled: z.boolean().optional() }).parse(r.body); return { id: await cx.connect(A(r), z.string().parse((r.params as any).provider), b.credentials, { writeEnabled: b.writeEnabled }) }; });
  app.post('/api/connections/:id/permissions', async (r) => { await cx.setPermissions(A(r), id(r), z.object({ read: z.boolean().optional(), write: z.boolean().optional() }).parse(r.body)); return { ok: true }; });
  app.post('/api/connections/:id/disconnect', async (r) => cx.disconnect(A(r), id(r)));
  app.post('/api/connections/:id/reauthorize', async (r) => { await cx.reauthorize(A(r), id(r), z.object({ credentials: z.record(z.string(), z.any()) }).parse(r.body).credentials); return { ok: true }; });
  app.post('/api/connections/:id/sync', async (r) => { const a = A(r); if (!isAdmin(a)) throw new HttpError(403, 'admin required'); const c = await cx.getConnection(a, id(r)); const ad = getAdapter(c.provider); for (const res of ad?.syncResources ?? []) await enqueue(pool, 'connection_sync', { connectionId: c.id, resource: res }, { workspaceId: a.workspaceId, dedupeKey: `${c.id}:${res}:manual:${Date.now()}` }); return { queued: true }; });
  app.get('/api/connections/:id/runs', async (r) => { const a = A(r); await cx.getConnection(a, id(r)); return (await pool.query('SELECT id, resource, started_at, finished_at, status, fetched, created, updated, skipped, error FROM sync_runs WHERE connection_id=$1 ORDER BY id DESC LIMIT 30', [id(r)])).rows; });
  app.post('/api/admin/rotate-secrets', async (r) => { if (!isAdmin(A(r))) throw new HttpError(403, 'admin required'); return cx.rotateAllSecrets(); });

  // ----- generic webhooks -----
  app.get('/api/webhooks', async (r) => wh.listSubscriptions(A(r)));
  app.post('/api/webhooks', async (r) => wh.createSubscription(A(r), r.body));
  app.post('/api/webhooks/:id/active', async (r) => { await wh.setSubscriptionActive(A(r), id(r), z.object({ active: z.boolean() }).parse(r.body).active); return { ok: true }; });
  app.post('/api/webhooks/:id/rotate-secret', async (r) => wh.rotateSubscriptionSecret(A(r), id(r)));
  app.post('/api/webhooks/:id/ping', async (r) => { await wh.sendPing(A(r), id(r)); return { ok: true }; });
  app.delete('/api/webhooks/:id', async (r) => { await wh.deleteSubscription(A(r), id(r)); return { ok: true }; });
  app.get('/api/webhooks/:id/deliveries', async (r) => wh.listDeliveries(A(r), id(r)));
  app.post('/api/webhook-deliveries/:id/redeliver', async (r) => { await wh.redeliver(A(r), id(r)); return { ok: true }; });
  app.get('/api/inbound-endpoints', async (r) => wh.listInboundEndpoints(A(r)));
  app.post('/api/inbound-endpoints', async (r) => { const b = z.object({ name: z.string().min(1).max(80), defaultTags: z.array(z.string().max(40)).max(10).optional() }).parse(r.body); return wh.createInboundEndpoint(A(r), b.name, b.defaultTags); });
  app.post('/api/inbound-endpoints/:id/active', async (r) => { await wh.setInboundActive(A(r), id(r), z.object({ active: z.boolean() }).parse(r.body).active); return { ok: true }; });
  // public (signature-authenticated)
  app.post('/hooks/inbound/:id', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (r) => wh.handleInboundLead(id(r), r.headers, (r as any).rawBody ?? ''));
  app.post('/webhooks/payments/:id', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (r) => pay.handlePaymentWebhook(id(r), r.headers, (r as any).rawBody ?? ''));

  // ----- payments -----
  app.get('/api/payments', async (r) => pay.listPayments(A(r)));
  app.post('/api/payments', async (r) => ({ id: await pay.createPaymentRequest(A(r), r.body) }));
  app.get('/api/payments/:id', async (r) => pay.getPayment(A(r), id(r)));
  app.post('/api/payments/:id/link', async (r) => pay.createLink(A(r), id(r), z.object({ connectionId: uuid.optional() }).parse(r.body ?? {}).connectionId));
  app.get('/api/payments/:id/message-draft', async (r) => pay.linkMessageDraft(A(r), id(r)));
  app.post('/api/payments/:id/refund', async (r) => pay.refund(A(r), id(r), z.object({ amountCents: z.number().int() }).parse(r.body).amountCents));
  app.post('/api/payments/:id/cancel', async (r) => { await pay.cancelRequest(A(r), id(r)); return { ok: true }; });
  app.post('/api/payments/:id/accounting', async (r) => { const b = z.object({ ref: z.string().max(100).nullable(), note: z.string().max(300).nullable() }).parse(r.body); await pay.setAccountingRef(A(r), id(r), b.ref, b.note); return { ok: true }; });
  app.get('/payments/return/:id', async (r, reply) => reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(await pay.returnPageHtml((r.params as any).id)));

  // ----- reviews -----
  app.get('/api/reviews', async (r) => { const q = z.object({ source: z.string().optional(), rating: z.coerce.number().int().min(1).max(5).optional(), replied: z.enum(['yes', 'no']).optional(), search: z.string().max(100).optional(), from: z.string().optional(), to: z.string().optional() }).parse(r.query); return rv.listReviews(A(r), q); });
  app.get('/api/reviews/summary', async (r) => rv.reviewSummary(A(r)));
  app.post('/api/reviews/import', async (r) => rv.importReviews(A(r), (r.body as any)?.reviews));
  app.post('/api/reviews/:id/drafts', async (r) => rv.draftReply(A(r), id(r), z.object({ body: z.string().max(4000).optional() }).parse(r.body ?? {}).body));
  app.patch('/api/review-replies/:id', async (r) => { await rv.editReply(A(r), id(r), z.object({ body: z.string().min(1).max(4000) }).parse(r.body).body); return { ok: true }; });
  app.post('/api/review-replies/:id/approve', async (r) => { await rv.approveReply(A(r), id(r)); return { ok: true }; });
  app.post('/api/review-replies/:id/post', async (r) => rv.postReply(A(r), id(r)));
  app.post('/api/reviews/:id/mark-replied', async (r) => { await rv.markRepliedManually(A(r), id(r), z.object({ text: z.string().min(1).max(4000) }).parse(r.body).text); return { ok: true }; });
  app.post('/api/review-requests', async (r) => rv.createReviewRequest(A(r), r.body));

  // ----- SANDBOX ONLY: drive the in-process fake providers through the real code paths (disabled in production) -----
  const dev = (a: Actor) => { if (config.env === 'production') throw new HttpError(404, 'not found'); if (!isAdmin(a)) throw new HttpError(403, 'admin required'); };
  app.post('/api/dev/sandbox/reviews', async (r) => { dev(A(r)); const n = z.object({ count: z.number().int().min(1).max(20).default(3) }).parse(r.body ?? {}).count; const start = fakeReviewServer.reviews.length; for (let i = 0; i < n; i++) fakeReviewServer.reviews.push({ externalId: `S${start + i + 1}`, rating: [5, 4, 2, 5, 3][(start + i) % 5], authorName: ['Pat Lee', 'Dana Ruiz', 'Sam Ortiz', 'Kim Young', 'Alex Kerr'][(start + i) % 5], body: `Sandbox review #${start + i + 1} (fabricated demo text).`, reviewedAt: new Date(Date.now() - (n - i) * 86400_000).toISOString(), replyText: null, repliedAt: null }); return { total: fakeReviewServer.reviews.length }; });
  app.post('/api/dev/sandbox/sync', async (r) => { const a = A(r); dev(a); const b = z.object({ connectionId: uuid }).parse(r.body); const c = await cx.getConnection(a, b.connectionId); return cx.runSync(c.id, 'reviews'); });
  app.post('/api/dev/sandbox/payment', async (r) => {
    const a = A(r); dev(a); const b = z.object({ paymentRequestId: uuid, kind: z.enum(['pay', 'partial', 'refund', 'expire']), amountCents: z.number().int().optional() }).parse(r.body);
    const p = (await pool.query('SELECT * FROM payment_requests WHERE id=$1 AND workspace_id=$2', [b.paymentRequestId, a.workspaceId])).rows[0]; if (!p?.provider_ref || p.provider !== 'demo_pay') throw new HttpError(409, 'not a sandbox payment with a link');
    const s = fakePayServer.sessions.get(p.provider_ref); if (!s) throw new HttpError(409, 'sandbox provider has no such session (the sandbox lives in the server process memory)');
    const ev = b.kind === 'pay' ? fakePayServer.pay(p.provider_ref) : b.kind === 'partial' ? fakePayServer.pay(p.provider_ref, b.amountCents ?? Math.floor(Number(p.amount_cents) / 2)) : b.kind === 'refund' ? fakePayServer.refund(p.provider_ref, b.amountCents ?? Number(p.paid_cents)) : (() => { s.status = 'expired'; return { providerEventId: `evt_exp_${Date.now()}`, providerRef: p.provider_ref, type: 'expired' as const, terminal: true, occurredAt: new Date().toISOString() }; })();
    const conn = await cx.getConnection(a, p.connection_id); const creds = cx.getCredentials(conn); const sig = fakePayServer.webhook(creds.webhookSecret, [ev]);
    const res = await app.inject({ method: 'POST', url: `/webhooks/payments/${conn.id}`, headers: { 'content-type': 'application/json', ...sig.headers }, payload: sig.raw });   // the REAL signed-webhook path
    return { status: res.statusCode, result: res.json() };
  });
  app.post('/api/dev/sandbox/reconcile', async (r) => { const a = A(r); dev(a); await pay.reconcileOne(z.object({ paymentRequestId: uuid }).parse(r.body).paymentRequestId); return { ok: true }; });
}
