import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from '../domain/authz.js';
import * as svc from '../domain/service-identities.js';
import * as sandra from '../domain/sandra.js';
import { ackEvents, pullEvents } from '../domain/service-events.js';
import { eraseContact, exportContact } from '../domain/privacy.js';

declare module 'fastify' { interface FastifyRequest { svc?: svc.ServiceContext; correlationId?: string } }

const uuid = z.string().uuid();

/** Machine API for the assistant (Sandra). Bearer key only: no cookies, no CSRF header, no browser session can reach it, and its keys can reach nothing else. */
export function registerSandraApi(app: FastifyInstance) {
  const NO_IP_LIMIT = { config: { rateLimit: false as const } };
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    req.correlationId = String(req.headers['x-correlation-id'] ?? '').slice(0, 100) || randomUUID();
    reply.header('x-correlation-id', req.correlationId);
    const ctx = await svc.authenticateKey(req.headers.authorization);
    if (!ctx) { reply.header('www-authenticate', 'Bearer realm="relay"'); throw new HttpError(401, 'invalid, expired or revoked API key'); }
    const rl = svc.rateCheck(ctx);
    if (!rl.ok) { reply.header('retry-after', String(rl.retryAfter)); throw new HttpError(429, 'rate limit exceeded', { code: 'rate_limited', retryAfter: rl.retryAfter }); }
    req.svc = ctx;
  });
  const S = (req: FastifyRequest) => req.svc!;
  const id = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);
  const path = (req: FastifyRequest) => req.url.split('?')[0];

  app.get('/api/v1/me', NO_IP_LIMIT, async (req) => { const c = S(req); return { identity: { id: c.identityId, name: c.name }, scopes: [...c.scopes].sort(), autonomy: c.autonomy, departmentIds: c.departmentIds, rateLimitPerMin: c.rateLimitPerMin, apiVersion: 1 }; });

  app.get('/api/v1/events', NO_IP_LIMIT, async (req) => {
    const c = S(req); sandra.need(c, 'events:read');
    const q = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query);
    return pullEvents(c, q);
  });
  app.post('/api/v1/events/ack', NO_IP_LIMIT, async (req) => {
    const c = S(req); sandra.need(c, 'events:read');
    return ackEvents(c, z.object({ seq: z.number().int().min(0) }).strict().parse(req.body).seq);
  });

  app.get('/api/v1/conversations', NO_IP_LIMIT, async (req) => sandra.listConversationsFor(S(req), z.object({ handlingMode: z.enum(['human', 'sandra', 'draft_only', 'paused']).optional(), responsibility: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query)));
  app.get('/api/v1/conversations/:id', NO_IP_LIMIT, async (req) => sandra.getConversationFor(S(req), id(req), z.object({ messageLimit: z.coerce.number().int().min(1).max(200).optional(), beforeSeq: z.coerce.number().int().optional() }).parse(req.query)));
  app.get('/api/v1/contacts/:id', NO_IP_LIMIT, async (req) => sandra.getContactFor(S(req), id(req)));
  app.get('/api/v1/contacts/:id/summary', NO_IP_LIMIT, async (req) => sandra.getSummaryFor(S(req), id(req)));
  app.get('/api/v1/contacts/:id/matches', NO_IP_LIMIT, async (req) => sandra.getMatchesFor(S(req), id(req)));
  app.get('/api/v1/inventory', NO_IP_LIMIT, async (req) => sandra.listInventoryFor(S(req)));
  app.get('/api/v1/business', NO_IP_LIMIT, async (req) => sandra.businessInfoFor(S(req)));

  // Writes: validate first (400s are never stored), then run exactly once per Idempotency-Key.
  const write = <T>(sub: string, schema: z.ZodType<T> | null, run: (ctx: svc.ServiceContext, c: import('pg').PoolClient, convId: string, body: T, key: string, corr?: string) => Promise<{ status: number; body: unknown }>) =>
    app.post(`/api/v1/conversations/:id/${sub}`, NO_IP_LIMIT, async (req, reply) => {
      const ctx = S(req); const convId = id(req);
      const body = (schema ? schema.parse(req.body ?? {}) : {}) as T;
      const key = req.headers['idempotency-key'] as string | undefined;
      const r = await sandra.idempotent(ctx, key, 'POST', path(req), body, req.correlationId, (c) => run(ctx, c, convId, body, key!, req.correlationId));
      if (r.replay) reply.header('idempotent-replay', 'true');
      return reply.status(r.status).send(r.body);
    });
  write('messages', sandra.sendSchema, (ctx, c, cid, b, key, corr) => sandra.sendFor(ctx, c, cid, b, key, corr));
  write('drafts', sandra.draftSchema, (ctx, c, cid, b, _k, corr) => sandra.createDraftFor(ctx, c, cid, b, corr));
  write('tags', sandra.tagsSchema, (ctx, c, cid, b, _k, corr) => sandra.tagsFor(ctx, c, cid, b, corr));
  write('handoff', sandra.handoffSchema, (ctx, c, cid, b, _k, corr) => sandra.handoffFor(ctx, c, cid, b, corr));
  write('pause', null, (ctx, c, cid, _b, _k, corr) => sandra.pauseFor(ctx, c, cid, corr));
  write('tasks', sandra.taskSchema, (ctx, c, cid, b, _k, corr) => sandra.taskFor(ctx, c, cid, b, corr));
}

/** Staff/admin management of the assistant (cookie-authenticated like the rest of the app). */
export function registerPhase6(app: FastifyInstance, A: (r: FastifyRequest) => Actor) {
  const rid = (r: FastifyRequest, k = 'id') => uuid.parse((r.params as Record<string, string>)[k]);
  app.get('/api/assistant/catalog', async () => ({ scopes: svc.SCOPES, autonomy: svc.AUTONOMY }));
  app.get('/api/assistant/identities', async (r) => svc.listIdentities(A(r)));
  app.post('/api/assistant/identities', async (r) => svc.createIdentity(A(r), r.body));
  app.patch('/api/assistant/identities/:id', async (r) => svc.updateIdentity(A(r), rid(r), r.body));
  app.post('/api/assistant/identities/:id/keys', async (r) => svc.createKey(A(r), rid(r), r.body));
  app.delete('/api/assistant/identities/:id/keys/:keyId', async (r) => { await svc.revokeKey(A(r), rid(r), rid(r, 'keyId')); return { ok: true }; });
  app.post('/api/assistant/identities/:id/disable', async (r) => { await svc.disableIdentity(A(r), rid(r)); return { ok: true }; });
  app.post('/api/assistant/identities/:id/webhook-secret', async (r) => svc.rotateWebhookSecret(A(r), rid(r)));
  app.get('/api/assistant/rules', async (r) => svc.listRules(A(r)));
  app.put('/api/assistant/rules', async (r) => svc.upsertRule(A(r), r.body));
  app.delete('/api/assistant/rules/:id', async (r) => { await svc.deleteRule(A(r), rid(r)); return { ok: true }; });
  app.get('/api/assistant/audit', async (r) => {
    const a = A(r); if (!isAdmin(a)) throw new HttpError(403, 'owner or admin required');
    return (await pool.query(`SELECT id, action, actor_type, target_type, target_id, meta, created_at FROM audit_events WHERE workspace_id=$1 AND (actor_type='service' OR action LIKE 'assistant.%') ORDER BY id DESC LIMIT 200`, [a.workspaceId])).rows;
  });
  app.get('/api/contacts/:id/export', async (r, reply) => { const out = await exportContact(A(r), rid(r)); return reply.header('content-disposition', `attachment; filename="contact-${rid(r).slice(0, 8)}.json"`).send(out); });
  app.post('/api/contacts/:id/erase', async (r) => eraseContact(A(r), rid(r), z.object({ confirm: z.string() }).parse(r.body).confirm));
  app.get('/api/conversations/:id/assistant-drafts', async (r) => sandra.listDraftsForStaff(A(r), rid(r)));
  app.post('/api/assistant-drafts/:id/use', async (r) => sandra.decideDraft(A(r), rid(r), 'used'));
  app.post('/api/assistant-drafts/:id/dismiss', async (r) => { await sandra.decideDraft(A(r), rid(r), 'dismissed'); return { ok: true }; });
}
