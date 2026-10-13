import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { buildApp } from '../src/server/app.js';
import { resetDb, drain, type Seeded } from './helpers.js';
import { signWebhook } from '../src/providers/sms.js';
import { config } from '../src/config.js';

let s: Seeded; let app: Awaited<ReturnType<typeof buildApp>>;
beforeEach(async () => { s = await resetDb(); app = await buildApp(); });
afterAll(async () => { await app.close(); await pool.end(); });

async function loginAs(email: string, password = 'test-password-123') {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email, password } });
  expect(r.statusCode).toBe(200);
  const cookie = r.headers['set-cookie'] as string;
  const call = async (method: string, url: string, payload?: object) => {
    const res = await app.inject({ method: method as any, url, headers: { cookie: cookie.split(';')[0], 'x-relay-csrf': '1' }, payload });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return call;
}

describe('auth', () => {
  it('rejects unauthenticated, wrong password, and missing CSRF header', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/conversations' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email: 'sam@demo.relay.test', password: 'nope-nope-nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'sam@demo.relay.test', password: 'test-password-123' } })).statusCode).toBe(403);
  });
  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email: 'sue@demo.relay.test', password: 'wrong-wrong-wrong' } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email: 'sue@demo.relay.test', password: 'test-password-123' } });
    expect(r.statusCode).toBe(401);
  });
  it('invitation flow: only admins invite; accepted user can log in with scoped access', async () => {
    const sam = await loginAs('sam@demo.relay.test');
    expect((await sam('POST', '/api/invitations', { email: 'new@demo.relay.test', role: 'staff' })).status).toBe(403);
    const owner = await loginAs('owner@demo.relay.test');
    const inv = await owner('POST', '/api/invitations', { email: 'new@demo.relay.test', role: 'staff', departmentIds: [s.departments.service] });
    expect(inv.status).toBe(200);
    const acc = await app.inject({ method: 'POST', url: '/api/invitations/accept', headers: { 'x-relay-csrf': '1' }, payload: { token: inv.body.token, name: 'Newbie', password: 'a-long-enough-pass' } });
    expect(acc.statusCode).toBe(200);
    const nu = await loginAs('new@demo.relay.test', 'a-long-enough-pass');
    expect((await nu('GET', '/api/me')).body.user.role).toBe('staff');
    expect((await app.inject({ method: 'POST', url: '/api/invitations/accept', headers: { 'x-relay-csrf': '1' }, payload: { token: inv.body.token, name: 'x', password: 'a-long-enough-pass' } })).statusCode).toBe(400);   // single-use
  });
});

describe('department-scoped access control', () => {
  it('staff cannot see or act on conversations in departments they are not in; owner can; financing is restricted even for managers outside it', async () => {
    const owner = await loginAs('owner@demo.relay.test'); const sam = await loginAs('sam@demo.relay.test'); const sue = await loginAs('sue@demo.relay.test'); const fin = await loginAs('fin@demo.relay.test');
    const c = await owner('POST', '/api/contacts', { firstName: 'Dana', phone: '(414) 201-0140' });
    const cv = await owner('POST', '/api/conversations', { contactId: c.body.id, departmentId: s.departments.financing });
    const id = cv.body.id;
    expect((await owner('GET', `/api/conversations/${id}`)).status).toBe(200);
    expect((await fin('GET', `/api/conversations/${id}`)).status).toBe(200);
    for (const u of [sam, sue]) {
      expect((await u('GET', `/api/conversations/${id}`)).status).toBe(404);
      expect((await u('POST', `/api/conversations/${id}/messages`, { body: 'hi', idempotencyKey: 'k-12345678' })).status).toBe(404);
      expect((await u('POST', `/api/conversations/${id}/takeover`)).status).toBe(404);
      expect((await u('GET', '/api/conversations')).body.map((x: any) => x.id)).not.toContain(id);
      expect((await u('GET', `/api/contacts/${c.body.id}`)).status).toBe(404);
      expect((await u('GET', '/api/contacts')).body.map((x: any) => x.id)).not.toContain(c.body.id);
      expect((await u('POST', `/api/contacts/${c.body.id}/consent`, { type: 'sms_stop' })).status).toBe(404);
    }
    // cannot assign a financing conversation to someone outside the department
    expect((await owner('POST', `/api/conversations/${id}/assign`, { userId: s.users.sam })).status).toBe(400);
    expect((await owner('POST', `/api/conversations/${id}/assign`, { userId: s.users.fin })).status).toBe(200);
  });
  it('staff cannot hand a conversation to Sandra or apply administrative blocks', async () => {
    const sam = await loginAs('sam@demo.relay.test');
    const c = await sam('POST', '/api/contacts', { firstName: 'Eve', phone: '(414) 201-0141' });
    const cv = await sam('POST', '/api/conversations', { contactId: c.body.id });
    expect((await sam('POST', `/api/conversations/${cv.body.id}/handling-mode`, { mode: 'sandra' })).status).toBe(403);
    expect((await sam('POST', `/api/contacts/${c.body.id}/consent`, { type: 'outbound_block' })).status).toBe(403);
  });
});

describe('end-to-end over HTTP', () => {
  it('two staff accounts see the same persisted conversation; send → worker → provider_accepted; records survive an app restart', async () => {
    const sam = await loginAs('sam@demo.relay.test'); const owner = await loginAs('owner@demo.relay.test');
    const sim = await sam('POST', '/api/dev/simulate-inbound', { from: '(414) 201-0150', body: 'Do you have any 24ft pontoons?' });
    expect(sim.status).toBe(200);
    const list = await sam('GET', '/api/conversations'); expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ unread: 1, responsibility: 'needs_our_reply', is_simulated: true });
    const id = list.body[0].id;
    expect((await owner('GET', '/api/conversations')).body[0].id).toBe(id);
    const sent = await sam('POST', `/api/conversations/${id}/messages`, { body: 'Yes! Can I call you?', idempotencyKey: 'send-0001-abcd' });
    expect(sent.status).toBe(200);
    expect((await sam('POST', `/api/conversations/${id}/messages`, { body: 'Yes! Can I call you?', idempotencyKey: 'send-0001-abcd' })).body.duplicate).toBe(true);
    await drain();
    await sam('POST', `/api/conversations/${id}/read`);
    await app.close(); app = await buildApp();     // simulated restart
    const sam2 = await loginAs('sam@demo.relay.test');
    const t = await sam2('GET', `/api/conversations/${id}`);
    expect(t.body.messages.map((m: any) => [m.direction, m.status])).toEqual([['inbound', 'received'], ['outbound', 'provider_accepted']]);
    expect((await sam2('GET', '/api/conversations')).body[0]).toMatchObject({ unread: 0, responsibility: 'waiting_on_customer' });
    // per-user read state: owner still sees it unread
    expect((await (await loginAs('owner@demo.relay.test'))('GET', '/api/conversations')).body[0].unread).toBe(1);
  });

  it('internal notes are not messages and never reach the provider', async () => {
    const sam = await loginAs('sam@demo.relay.test');
    await sam('POST', '/api/dev/simulate-inbound', { from: '(414) 201-0151', body: 'hello' });
    const id = (await sam('GET', '/api/conversations')).body[0].id;
    expect((await sam('POST', `/api/conversations/${id}/notes`, { body: 'INTERNAL: customer is difficult' })).status).toBe(200);
    await drain();
    const { simulatorControl } = await import('../src/providers/sms.js');
    expect(simulatorControl.sent).toHaveLength(0);
    const msgs = (await sam('GET', `/api/conversations/${id}`)).body;
    expect(JSON.stringify(msgs.messages)).not.toContain('INTERNAL'); expect(msgs.notes[0].body).toContain('INTERNAL');
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body LIKE '%INTERNAL%'`)).rows[0].n).toBe(0);
  });
});

describe('webhook security', () => {
  const raw = () => JSON.stringify({ type: 'inbound', eventId: 'w1', providerMessageId: 'wp1', from: '+14142010160', to: '+12625550100', body: 'hi', occurredAt: new Date().toISOString() });
  const hit = (payload: string, sig?: string) => app.inject({ method: 'POST', url: '/webhooks/sms/simulator', headers: { 'content-type': 'application/json', ...(sig ? { 'x-relay-signature': sig } : {}) }, payload });
  it('rejects missing, tampered, wrong-secret and stale signatures; accepts valid; duplicate replay is a no-op', async () => {
    const body = raw(); const now = Math.floor(Date.now() / 1000);
    expect((await hit(body)).statusCode).toBe(401);
    expect((await hit(body, signWebhook('wrong', now, body))).statusCode).toBe(401);
    expect((await hit(body + ' ', signWebhook(config.simulatorWebhookSecret, now, body))).statusCode).toBe(401);
    expect((await hit(body, signWebhook(config.simulatorWebhookSecret, now - 3600, body))).statusCode).toBe(401);
    expect((await pool.query('SELECT count(*)::int n FROM messages')).rows[0].n).toBe(0);
    const good = signWebhook(config.simulatorWebhookSecret, now, body);
    expect((await hit(body, good)).json()).toMatchObject({ processed: 1, duplicates: 0 });
    expect((await hit(body, good)).json()).toMatchObject({ processed: 0, duplicates: 1 });
    expect((await pool.query('SELECT count(*)::int n FROM messages')).rows[0].n).toBe(1);
  });
  it('unknown provider → 404', async () => { expect((await app.inject({ method: 'POST', url: '/webhooks/sms/nope', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404); });
});
