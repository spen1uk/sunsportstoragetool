import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { acceptInvitation, actorFromToken, createInvitation, login, logout } from '../domain/auth.js';
import { HttpError, isAdmin, requireConversation, type Actor } from '../domain/authz.js';
import * as conv from '../domain/conversations.js';
import * as contacts from '../domain/contacts.js';
import { queueOutbound } from '../domain/messaging.js';
import { processWebhookEvent } from '../domain/inbound.js';
import { publish } from '../domain/events.js';
import { getProvider, signWebhook } from '../providers/sms.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import multipart from '@fastify/multipart';
import { registerPhase2 } from './phase2.js';
import { registerPhase3 } from './phase3.js';
import { registerPhase4 } from './phase4.js';
import { registerPhase5 } from './phase5.js';
import { registerPhase6, registerSandraApi } from './phase6.js';
import { registerPhase7 } from './phase7.js';
import { httpStats, metricsText, readiness, sseStats, systemStatus } from '../domain/ops.js';
import type { Writable } from 'node:stream';

declare module 'fastify' { interface FastifyRequest { actor?: Actor } }
const COOKIE = 'relay_session';

/** Keep secrets out of logs: bearer keys, session cookies, webhook signatures, and signed-URL query tokens. */
const SCRUB_Q = /([?&](?:sig|signature|token|key|secret|code)=)[^&]*/gi;
export const scrubUrl = (u: string) => u.replace(SCRUB_Q, '$1[redacted]');
const loggerOptions = (stream?: Writable) => ({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-relay-signature"]', 'req.headers["x-relay-csrf"]', 'res.headers["set-cookie"]'], censor: '[redacted]' },
  serializers: { req: (r: any) => ({ method: r.method, url: scrubUrl(r.url), remoteAddress: r.ip }), res: (r: any) => ({ statusCode: r.statusCode }) },
  ...(stream ? { stream } : {}),
});

export async function buildApp(opts: { logger?: boolean; logStream?: Writable } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger || opts.logStream ? loggerOptions(opts.logStream) : false, bodyLimit: 1_000_000, trustProxy: typeof config.trustProxy === 'number' ? ((_addr: string, hop: number) => hop <= (config.trustProxy as number)) : config.trustProxy });
  await app.register(cookie);
  await app.register(multipart, { limits: { files: 1, fields: 10 } });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, ...(err.extra ?? {}) });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: 'invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err); return reply.status(500).send({ error: 'internal error' });
  });

  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff').header('x-frame-options', 'DENY').header('referrer-policy', 'no-referrer').header('permissions-policy', 'camera=(), geolocation=(), payment=(), microphone=(self)').header('cross-origin-opener-policy', 'same-origin');
    if (config.env === 'production') reply.header('strict-transport-security', 'max-age=31536000');
    const ct = String(reply.getHeader('content-type') ?? '');
    if (ct.startsWith('text/html')) reply.header('content-security-policy', CSP);
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.addHook('onResponse', async (_req, reply) => { httpStats.total++; httpStats.byClass[`${Math.floor(reply.statusCode / 100)}xx`] = (httpStats.byClass[`${Math.floor(reply.statusCode / 100)}xx`] ?? 0) + 1; });

  // Raw-body JSON parsing so webhook signatures can be verified over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { (e as any).statusCode = 400; done(e as Error); }
  });

  // Auth + CSRF for /api (except login/accept). Webhooks authenticate by signature instead.
  app.addHook('preHandler', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/v1/')) return;   // /api/v1 authenticates by API key (see registerSandraApi), never by cookie
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-relay-csrf'] !== '1') throw new HttpError(403, 'missing CSRF header');
    const open = req.url.startsWith('/api/auth/login') || req.url.startsWith('/api/invitations/accept');
    const token = req.cookies[COOKIE];
    const a = await actorFromToken(token);
    if (!a && !open) throw new HttpError(401, 'not authenticated');
    req.actor = a ?? undefined;
  });
  const A = (req: FastifyRequest) => req.actor!;
  const idParam = (req: FastifyRequest) => z.string().uuid().parse((req.params as any).id);

  app.get('/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });                       // liveness + db
  app.get('/ready', async (_req, reply) => { const r = await readiness(); return reply.status(r.ready ? 200 : 503).send(r); });   // takes traffic only when schema is current
  app.get('/metrics', async (req, reply) => {
    if (!config.metricsToken) return reply.status(404).send({ error: 'not found' });
    const h = String(req.headers.authorization ?? ''); const want = `Bearer ${config.metricsToken}`;
    if (h.length !== want.length || !timingSafeEqual(Buffer.from(h), Buffer.from(want))) return reply.status(401).send({ error: 'unauthorized' });
    return reply.header('content-type', 'text/plain; version=0.0.4').send(await metricsText());
  });
  app.get('/api/admin/status', async (req) => { const a = A(req); if (!isAdmin(a)) throw new HttpError(403, 'admin required'); return systemStatus(a.workspaceId); });

  // ---------- auth ----------
  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const r = await login(b.email, b.password, req.headers['user-agent'], req.ip);
    if (!r) throw new HttpError(401, 'invalid email or password');
    reply.setCookie(COOKIE, r.token, { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, path: '/', maxAge: config.sessionTtlHours * 3600 });
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => { const t = req.cookies[COOKIE]; if (t) await logout(t); reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });
  app.get('/api/me', async (req) => {
    const a = A(req);
    const ws = (await pool.query('SELECT id, name, timezone FROM workspaces WHERE id=$1', [a.workspaceId])).rows[0];
    const ch = (await pool.query('SELECT provider, address, is_simulated, is_live_enabled FROM channels WHERE workspace_id=$1', [a.workspaceId])).rows;
    return { user: { id: a.userId, name: a.name, role: a.role, departmentIds: a.departmentIds }, workspace: ws, channels: ch, simulated: ch.every((c) => c.is_simulated) };
  });
  app.post('/api/invitations', async (req) => {
    const a = A(req); if (!isAdmin(a)) throw new HttpError(403, 'admin required');
    const b = z.object({ email: z.string().email(), role: z.enum(['admin', 'manager', 'staff']), departmentIds: z.array(z.string().uuid()).default([]) }).parse(req.body);
    if (b.role === 'admin' && a.role !== 'owner') throw new HttpError(403, 'only the owner can invite admins');
    return { token: await createInvitation(a, b.email, b.role, b.departmentIds) };
  });
  app.post('/api/invitations/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ token: z.string().min(10), name: z.string().min(1), password: z.string().min(10) }).parse(req.body);
    const id = await acceptInvitation(b.token, b.name, b.password); if (!id) throw new HttpError(400, 'invalid or expired invitation');
    return { ok: true };
  });

  // ---------- directory ----------
  app.get('/api/departments', async (req) => (await pool.query('SELECT id, key, name, restricted FROM departments WHERE workspace_id=$1 ORDER BY name', [A(req).workspaceId])).rows);
  app.get('/api/users', async (req) => (await pool.query(
    `SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.is_active ORDER BY u.name`, [A(req).workspaceId])).rows);

  // ---------- conversations ----------
  app.get('/api/conversations', async (req) => {
    const q = z.object({ status: z.enum(['open', 'closed']).optional(), responsibility: z.string().optional(), assignee: z.string().optional(), department: z.string().uuid().optional(), search: z.string().max(100).optional(), unread: z.string().optional() }).parse(req.query);
    return conv.listConversations(A(req), { ...q, unreadOnly: q.unread === '1' });
  });
  app.get('/api/conversations/:id', async (req) => conv.getThread(A(req), idParam(req)));
  app.post('/api/conversations', async (req) => {
    const b = z.object({ contactId: z.string().uuid(), departmentId: z.string().uuid().nullable().optional() }).parse(req.body);
    return { id: await contacts.openConversationFor(A(req), b.contactId, b.departmentId) };
  });
  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const a = A(req); const id = idParam(req);
    const b = z.object({ body: z.string().max(1600), idempotencyKey: z.string().min(8).max(100), ifLastSeq: z.number().int().optional(), force: z.boolean().optional(), mediaIds: z.array(z.string().uuid()).max(5).optional(), packageId: z.string().uuid().optional() }).parse(req.body);
    await requireConversation(pool, a, id);
    const r = await queueOutbound({ workspaceId: a.workspaceId, conversationId: id, body: b.body, senderType: 'staff', senderUserId: a.userId, idempotencyKey: b.idempotencyKey, ifLastSeq: b.ifLastSeq, force: b.force, mediaIds: b.mediaIds, packageId: b.packageId });
    if (!r.ok) return reply.status(r.reason === 'newer_messages' ? 409 : 422).send({ error: r.reason, messageId: r.messageId });
    return r;
  });
  const post = (p: string, fn: (a: Actor, id: string, body: any) => Promise<unknown>) => app.post(`/api/conversations/:id/${p}`, async (req) => { await fn(A(req), idParam(req), req.body ?? {}); return { ok: true }; });
  post('assign', (a, id, b) => conv.assign(a, id, z.object({ userId: z.string().uuid().nullable() }).parse(b).userId));
  post('takeover', (a, id) => conv.takeover(a, id));
  post('handling-mode', (a, id, b) => conv.setHandlingMode(a, id, z.object({ mode: z.string() }).parse(b).mode));
  post('responsibility', (a, id, b) => conv.setResponsibility(a, id, z.object({ state: z.string() }).parse(b).state));
  post('status', (a, id, b) => conv.setOpen(a, id, z.object({ open: z.boolean() }).parse(b).open));
  post('department', (a, id, b) => conv.setDepartment(a, id, z.object({ departmentId: z.string().uuid().nullable() }).parse(b).departmentId));
  post('read', (a, id) => conv.markRead(a, id));
  post('notes', (a, id, b) => conv.addNote(a, id, z.object({ body: z.string().min(1).max(5000) }).parse(b).body));
  post('typing', async (a, id, b) => { await conv.getThread(a, id); await publish(pool, a.workspaceId, 'typing', { conversationId: id, userId: a.userId, name: a.name, typing: !!b.typing }); });

  registerPhase2(app, A);
  registerPhase3(app, A);
  registerPhase4(app, A);
  registerPhase5(app, A);
  registerPhase6(app, A);
  registerPhase7(app, A);
  registerSandraApi(app);

  // ---------- contacts ----------
  app.get('/api/contacts', async (req) => contacts.listContacts(A(req), z.object({ search: z.string().max(100).optional(), tag: z.string().optional() }).parse(req.query)));
  app.post('/api/contacts', async (req) => ({ id: await contacts.createContact(A(req), z.object({ firstName: z.string().optional(), lastName: z.string().optional(), company: z.string().optional(), email: z.string().email().optional(), phone: z.string().optional(), secondaryPhone: z.string().optional(), tags: z.array(z.string()).optional() }).parse(req.body)) }));
  app.get('/api/contacts/:id', async (req) => contacts.getContact(A(req), idParam(req)));
  app.patch('/api/contacts/:id', async (req) => { await contacts.updateContact(A(req), idParam(req), z.object({ firstName: z.string().optional(), lastName: z.string().optional(), company: z.string().optional(), email: z.string().email().optional(), tags: z.array(z.string()).optional() }).parse(req.body)); return { ok: true }; });
  app.post('/api/contacts/:id/boats', async (req) => ({ id: await contacts.addBoat(A(req), idParam(req), z.object({ relation: z.enum(['owned', 'interested', 'trade_in']), year: z.number().int().optional(), make: z.string().optional(), model: z.string().optional(), hullId: z.string().optional(), notes: z.string().optional() }).parse(req.body)) }));
  app.post('/api/contacts/:id/consent', async (req) => {
    const b = z.object({ type: z.enum(['sms_stop', 'sms_start', 'marketing_opt_in', 'marketing_opt_out', 'inbound_block', 'inbound_unblock', 'outbound_block', 'outbound_unblock', 'do_not_text_set', 'do_not_text_clear', 'do_not_email_set', 'do_not_email_clear']), evidence: z.string().max(500).optional() }).parse(req.body);
    await contacts.changeConsent(A(req), idParam(req), b.type, b.evidence); return { ok: true };
  });

  // ---------- provider webhooks (signature-verified, not cookie-authenticated) ----------
  app.post('/webhooks/sms/:provider', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req, reply) => {
    const provider = getProvider((req.params as any).provider);
    if (!provider || (provider.isSimulated && config.env === 'production' && !config.allowSandboxInProduction)) throw new HttpError(404, 'unknown provider');
    let events;
    try { events = provider.verifyAndParse(req.headers, (req as any).rawBody ?? ''); } catch (e) { return reply.status(401).send({ error: `signature rejected: ${(e as Error).message}` }); }
    let duplicates = 0;
    for (const ev of events) if ((await processWebhookEvent(provider.key, ev)).duplicate) duplicates++;
    return { ok: true, processed: events.length - duplicates, duplicates };
  });

  // ---------- DEMO: simulate a customer text (only against simulated channels; goes through the real signed webhook path) ----------
  app.post('/api/dev/simulate-inbound', async (req, reply) => {
    const a = A(req);
    if (config.env === 'production') throw new HttpError(404, 'not found');
    const b = z.object({ from: z.string().min(7), body: z.string().min(1).max(1600) }).parse(req.body);
    const ch = (await pool.query(`SELECT address FROM channels WHERE workspace_id=$1 AND provider='simulator' AND is_simulated`, [a.workspaceId])).rows[0];
    if (!ch) throw new HttpError(409, 'no simulated channel');
    const raw = JSON.stringify({ type: 'inbound', eventId: randomUUID(), providerMessageId: randomUUID(), from: b.from, to: ch.address, body: b.body, occurredAt: new Date().toISOString() });
    const sig = signWebhook(config.simulatorWebhookSecret, Math.floor(Date.now() / 1000), raw);
    const res = await app.inject({ method: 'POST', url: '/webhooks/sms/simulator', headers: { 'content-type': 'application/json', 'x-relay-signature': sig }, payload: raw });
    return reply.status(res.statusCode).send(res.json());
  });

  // ---------- realtime (SSE) ----------
  const subscribers = new Set<{ workspaceId: string; write: (s: string) => void }>();
  let listener: pg.Client | null = null; let closing = false;
  async function ensureListener() {
    if (listener) return;
    const c = new pg.Client({ connectionString: config.databaseUrl, application_name: 'relay-sse-listener' });
    listener = c;
    c.on('notification', (m) => {
      try { const e = JSON.parse(m.payload ?? '{}'); for (const s of subscribers) if (s.workspaceId === e.workspaceId) s.write(`data: ${JSON.stringify({ type: e.type, ...e.data })}\n\n`); } catch { /* ignore malformed */ }
    });
    // If the LISTEN connection drops (database restart, network blip, admin termination) notifications sent meanwhile are LOST. After re-listening we tell every
    // open browser to resync (reload what it shows) so nothing stays stale. Retries with backoff until the database is back.
    const lost = () => {
      if (listener !== c || closing) return;   // pg emits both 'error' and 'end' for one drop; handle once
      listener = null; c.end().catch(() => {});
      const again = (): void => { if (closing) return; ensureListener().then(() => { sseStats.listenerReconnects++; sseStats.lastResyncAt = new Date().toISOString(); for (const s of subscribers) s.write(`data: ${JSON.stringify({ type: 'resync' })}\n\n`); }).catch(() => { listener = null; setTimeout(again, 2000); }); };
      setTimeout(again, 1000);
    };
    c.on('error', lost); c.on('end', lost);
    await c.connect(); await c.query('LISTEN relay_events');
  }
  app.get('/api/events', async (req, reply: FastifyReply) => {
    const a = A(req); await ensureListener();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const sub = { workspaceId: a.workspaceId, write: (s: string) => res.write(s) };
    subscribers.add(sub); sseStats.subscribers = subscribers.size;
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => { clearInterval(ping); subscribers.delete(sub); sseStats.subscribers = subscribers.size; });
  });
  app.addHook('onClose', async () => { closing = true; for (const s of subscribers) s.write(''); if (listener) { const l = listener; listener = null; l.removeAllListeners(); l.on('error', () => {}); await l.end().catch(() => {}); } });

  // ---------- static web app ----------
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') || req.url.startsWith('/webhooks') ? reply.status(404).send({ error: 'not found' }) : reply.sendFile('index.html')));
  }
  return app;
}
