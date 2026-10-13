import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, inbound, resetDb, type Seeded } from './helpers.js';
import * as wh from '../src/domain/webhooks.js';
import { verify, sign } from '../src/integrations/signing.js';
import { decryptJson } from '../src/integrations/crypto.js';
import { simulatorControl } from '../src/providers/sms.js';
import { processWebhookEvent } from '../src/domain/inbound.js';
import { buildApp } from '../src/server/app.js';
import { createContact } from '../src/domain/contacts.js';

let s: Seeded; let owner: ReturnType<typeof actor>; let sam: ReturnType<typeof actor>;
type Call = { url: string; addr: string; headers: Record<string, string>; body: string };
let calls: Call[]; let responses: (number | Error)[];
beforeEach(async () => {
  s = await resetDb(); owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; calls = []; responses = [];
  wh.webhookTransport.opts = { resolve: async () => ['93.184.216.34'], transport: async (u, addr, o) => { calls.push({ url: u.toString(), addr, headers: o.headers, body: o.body ?? '' }); const r = responses.shift() ?? 200; if (r instanceof Error) throw r; return { status: r, body: '', headers: {} }; } };
});
afterEach(() => { wh.webhookTransport.opts = {}; });
afterAll(() => pool.end());

const sub = async (o: object = {}) => { const r = await wh.createSubscription(owner, { url: 'https://hooks.example.com/relay', events: ['*'], ...o }); return r; };
const deliveries = async () => (await pool.query('SELECT * FROM webhook_deliveries ORDER BY created_at')).rows;
const pendingJobs = async () => (await pool.query(`SELECT run_at FROM jobs WHERE kind='webhook_delivery' AND status='pending' ORDER BY run_at`)).rows;

describe('outbound subscriptions: creation safety', () => {
  it('admin only; secret shown once and stored encrypted; list never exposes it', async () => {
    await expect(wh.createSubscription(sam, { url: 'https://hooks.example.com/x', events: ['*'] })).rejects.toThrow(/owner or admin/);
    const r = await sub(); expect(r.secret).toMatch(/^whsec_/); const row = (await pool.query('SELECT secret_enc FROM webhook_subscriptions')).rows[0];
    expect(row.secret_enc).not.toContain(r.secret); expect(decryptJson<{ secret: string }>(row.secret_enc, `wh:${r.id}`).secret).toBe(r.secret);
    expect(JSON.stringify(await wh.listSubscriptions(owner))).not.toContain('whsec_');
  });
  it.each([['http://hooks.example.com/x', /https/], ['https://127.0.0.1/x', /not public/], ['https://localhost/x', /internal/], ['https://169.254.169.254/latest', /not public/], ['https://[::1]/x', /not public/], ['https://hooks.example.com:8443/x', /port/], ['https://u:p@hooks.example.com/x', /credentials/], ['https://2130706433/x', /not public/]])('rejects destination %s', async (url, why) => {
    await expect(wh.createSubscription(owner, { url, events: ['*'] })).rejects.toThrow(why);
  });
  it('rejects a hostname that RESOLVES to a private address', async () => { wh.webhookTransport.opts.resolve = async () => ['10.1.2.3']; await expect(wh.createSubscription(owner, { url: 'https://innocent.example.com/x', events: ['*'] })).rejects.toThrow(/non-public/); });
});

describe('delivery', () => {
  it('signs each request (verifiable by the receiver), pins the validated address, sends metadata only by default, and marks delivered', async () => {
    const r = await sub(); await processWebhookEvent('simulator', { type: 'inbound', eventId: 'e1', providerMessageId: 'p1', from: '+14142011101', to: '+12625550100', body: 'secret customer text', occurredAt: new Date() }); await drain();
    expect(calls).toHaveLength(1); const c = calls[0]; expect(c.addr).toBe('93.184.216.34'); expect(c.headers['x-relay-event-type']).toBe('message.received'); expect(c.headers['user-agent']).toBe('Relay-Webhooks/1');
    expect(() => verify(r.secret, c.headers['x-relay-signature'], c.body)).not.toThrow(); expect(() => verify('whsec_wrong', c.headers['x-relay-signature'], c.body)).toThrow();
    const payload = JSON.parse(c.body); expect(payload).toMatchObject({ type: 'message.received', data: { channel: 'sms' } }); expect(c.body).not.toContain('secret customer text'); expect(c.body).not.toContain('+14142011101');   // no content, no phone number
    expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 1, response_status: 200 });
  });
  it('includes message text only for subscriptions an admin explicitly marked include_content', async () => {
    await sub({ includeContent: true }); await processWebhookEvent('simulator', { type: 'inbound', eventId: 'e2', providerMessageId: 'p2', from: '+14142011102', to: '+12625550100', body: 'hello with content', occurredAt: new Date() }); await drain();
    expect(JSON.parse(calls[0].body).data).toMatchObject({ body: 'hello with content' });
  });
  it('only matching event types and active subscriptions get deliveries', async () => {
    await sub({ events: ['payment.updated'] }); const off = await sub({ url: 'https://other.example.com/h', events: ['*'] }); await wh.setSubscriptionActive(owner, off.id, false);
    await inbound('+14142011103', 'hi'); await drain(); expect(calls).toHaveLength(0); expect(await deliveries()).toHaveLength(0);
  });
  it('status changes are emitted as message.status_changed', async () => {
    await sub({ events: ['message.status_changed'] }); const { newCustomerConvo } = await import('./helpers.js'); const c = await newCustomerConvo(s, sam, '(414) 201-1104');
    const { queueOutbound } = await import('../src/domain/messaging.js'); await queueOutbound({ workspaceId: s.workspaceId, conversationId: c.conversationId, body: 'hi', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: 'wh-status-0001' }); await drain();
    const pid = simulatorControl.sent[0].providerMessageId; await processWebhookEvent('simulator', { type: 'status', eventId: 'st1', providerMessageId: pid, status: 'delivered', occurredAt: new Date() }); await drain();
    expect(calls.map((x) => JSON.parse(x.body).data.status)).toEqual(['delivered']);
  });
});

describe('retries and failure handling', () => {
  it('5xx and network errors retry with exponential backoff, then go dead after the maximum attempts; a fresh signature is made for each attempt', async () => {
    await sub(); const { emitEvent } = await import('../src/domain/outbound-events.js'); await emitEvent(pool, s.workspaceId, 'payment.updated', { paymentRequestId: 'x' }); const d = (await deliveries())[0];
    responses = [500, new Error('ECONNRESET')]; expect(await wh.deliverOnce(d.id)).toBe('retry'); let row = (await deliveries())[0]; expect(row).toMatchObject({ status: 'failed', attempts: 1, response_status: 500 });
    expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(25_000); expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBeLessThan(35_000);   // ~30s
    expect(await wh.deliverOnce(d.id)).toBe('retry'); row = (await deliveries())[0]; expect(row.attempts).toBe(2); expect(new Date(row.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(55_000);   // ~60s
    expect(calls[0].headers['x-relay-signature']).not.toBeUndefined(); expect(calls[0].headers['x-relay-delivery-attempt']).toBe('1'); expect(calls[1].headers['x-relay-delivery-attempt']).toBe('2');
    responses = Array(20).fill(503); let last = 'retry'; for (let i = 0; i < wh.MAX_ATTEMPTS; i++) { last = await wh.deliverOnce(d.id); if (last === 'dead') break; }
    expect(last).toBe('dead'); expect((await deliveries())[0]).toMatchObject({ status: 'dead', attempts: wh.MAX_ATTEMPTS }); expect((await deliveries())[0].last_error).toMatch(/gave up/);
    expect(await wh.deliverOnce(d.id)).toBe('skipped'); expect((await pendingJobs()).length).toBeGreaterThan(0);
  });
  it('retryable: 408/429; permanent: other 4xx and redirects (never followed); 410 disables the subscription', async () => {
    const r = await sub(); const { emitEvent } = await import('../src/domain/outbound-events.js');
    const one = async (status: number) => { await emitEvent(pool, s.workspaceId, 'payment.updated', { n: status }); const d = (await deliveries()).find((x) => x.status === 'pending')!; responses = [status]; return wh.deliverOnce(d.id); };
    expect(await one(429)).toBe('retry'); await pool.query(`UPDATE webhook_deliveries SET status='dead'`); expect(await one(408)).toBe('retry'); await pool.query(`UPDATE webhook_deliveries SET status='dead'`);
    expect(await one(400)).toBe('dead'); expect(await one(302)).toBe('dead'); expect((await deliveries()).find((x) => x.response_status === 302)!.last_error).toMatch(/not retryable/);
    expect(await one(410)).toBe('dead'); expect((await pool.query('SELECT active, disabled_reason FROM webhook_subscriptions WHERE id=$1', [r.id])).rows[0]).toMatchObject({ active: false, disabled_reason: expect.stringContaining('410') });
  });
  it('DNS REBINDING after creation: if the name now resolves to a private address, nothing is sent and the subscription is disabled', async () => {
    const r = await sub(); const { emitEvent } = await import('../src/domain/outbound-events.js'); await emitEvent(pool, s.workspaceId, 'payment.updated', {}); const d = (await deliveries())[0];
    wh.webhookTransport.opts.resolve = async () => ['169.254.169.254']; expect(await wh.deliverOnce(d.id)).toBe('dead'); expect(calls).toHaveLength(0);
    expect((await pool.query('SELECT active, disabled_reason FROM webhook_subscriptions WHERE id=$1', [r.id])).rows[0]).toMatchObject({ active: false }); expect((await deliveries())[0].last_error).toMatch(/blocked/);
  });
  it('ping works; dead deliveries can be redelivered; disabled subscriptions deliver nothing; secrets can be rotated', async () => {
    const r = await sub(); await wh.sendPing(owner, r.id); await drain(); expect(JSON.parse(calls[0].body).type).toBe('ping');
    const { emitEvent } = await import('../src/domain/outbound-events.js'); await emitEvent(pool, s.workspaceId, 'payment.updated', {}); const d = (await deliveries()).find((x) => x.event_type === 'payment.updated')!; responses = [400]; await wh.deliverOnce(d.id); expect((await deliveries()).find((x) => x.id === d.id)!.status).toBe('dead');
    await wh.redeliver(owner, d.id); await drain(); expect((await deliveries()).find((x) => x.id === d.id)!.status).toBe('delivered'); await expect(wh.redeliver(sam, d.id)).rejects.toThrow(/owner or admin/);
    const rot = await wh.rotateSubscriptionSecret(owner, r.id); expect(rot.secret).not.toBe(r.secret); await emitEvent(pool, s.workspaceId, 'payment.updated', {}); await drain(); const last = calls.at(-1)!; expect(() => verify(rot.secret, last.headers['x-relay-signature'], last.body)).not.toThrow(); expect(() => verify(r.secret, last.headers['x-relay-signature'], last.body)).toThrow();
  });
});

describe('inbound lead endpoints (create contacts only — can never send a message)', () => {
  const lead = (o: object = {}) => JSON.stringify({ eventId: 'ev-' + Math.random().toString(36).slice(2), firstName: 'Web', lastName: 'Lead', phone: '(414) 201-1201', email: 'web@example.com', message: 'Interested in the 2019 pontoon', ...o });
  const post = (ep: { id: string; secret: string }, raw: string, o: { secret?: string; now?: number } = {}) => wh.handleInboundLead(ep.id, { 'x-relay-signature': sign(o.secret ?? ep.secret, Math.floor((o.now ?? Date.now()) / 1000), raw) }, raw);
  it('requires a valid timestamped signature; rejects tampering/stale/wrong secret/inactive endpoints', async () => {
    const ep = await wh.createInboundEndpoint(owner, 'Website contact form', ['website']); const raw = lead();
    await expect(wh.handleInboundLead(ep.id, {}, raw)).rejects.toThrow(/missing/); await expect(post(ep, raw, { secret: 'inhook_wrong' })).rejects.toThrow(/bad signature/); await expect(post(ep, raw, { now: Date.now() - 3600_000 })).rejects.toThrow(/stale/);
    await expect(wh.handleInboundLead(ep.id, { 'x-relay-signature': sign(ep.secret, Math.floor(Date.now() / 1000), raw) }, raw + ' ')).rejects.toThrow(/bad signature/);
    expect((await pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(0);
    await wh.setInboundActive(owner, ep.id, false); await expect(post(ep, raw)).rejects.toThrow(/unknown endpoint/);
  });
});

describe('inbound leads: behaviour', () => {
  const lead = (o: object = {}) => JSON.stringify({ eventId: 'ev-' + Math.random().toString(36).slice(2), firstName: 'Web', lastName: 'Lead', phone: '(414) 201-1301', email: 'web@example.com', message: 'Interested in the 2019 pontoon', ...o });
  const post = (ep: { id: string; secret: string }, raw: string) => wh.handleInboundLead(ep.id, { 'x-relay-signature': sign(ep.secret, Math.floor(Date.now() / 1000), raw) }, raw);
  it('creates a contact, a note and a timeline entry; notifies admins; a replayed event creates nothing new; NO message is ever sent and NO consent is assumed', async () => {
    const ep = await wh.createInboundEndpoint(owner, 'Website contact form', ['website']); const raw = lead({ eventId: 'evt-fixed-1' });
    const r = await post(ep, raw); expect(r).toMatchObject({ duplicate: false, outcome: 'created' }); expect(await post(ep, raw)).toEqual({ duplicate: true });
    const c = (await pool.query('SELECT * FROM contacts')).rows; expect(c).toHaveLength(1); expect(c[0]).toMatchObject({ first_name: 'Web', marketing_status: 'opt_in_not_received', sms_opted_out: false }); expect(c[0].tags).toEqual(expect.arrayContaining(['web-lead', 'website']));
    expect((await pool.query('SELECT body FROM notes')).rows[0].body).toContain('Interested in the 2019 pontoon'); expect((await pool.query(`SELECT count(*)::int n FROM consent_events`)).rows[0].n).toBe(0);
    await drain(); expect(simulatorControl.sent).toHaveLength(0); expect((await pool.query(`SELECT count(*)::int n FROM messages`)).rows[0].n).toBe(0); expect((await pool.query(`SELECT count(*)::int n FROM jobs WHERE kind='send_message'`)).rows[0].n).toBe(0);
  });
  it('marketing consent is recorded ONLY when the form supplies explicit evidence', async () => {
    const ep = await wh.createInboundEndpoint(owner, 'Form', []);
    await expect(post(ep, lead({ consent: { marketing: { granted: true, evidence: '' } } }))).rejects.toThrow(/invalid lead/); await expect(post(ep, lead({ consent: { marketing: { granted: false, evidence: 'checkbox' } } }))).rejects.toThrow(/invalid lead/);
    await post(ep, lead({ eventId: 'evt-consent-1', consent: { marketing: { granted: true, evidence: 'Checked "text me deals" on /contact, 2026-10-13' } } }));
    expect((await pool.query('SELECT marketing_status FROM contacts')).rows[0].marketing_status).toBe('opt_in'); expect((await pool.query('SELECT type, source, evidence FROM consent_events')).rows[0]).toMatchObject({ type: 'marketing_opt_in', source: 'web_form' });
  });
  it('an existing contact is matched (no duplicate); a number shared by several people is NEVER merged — a separate contact is created and flagged for review', async () => {
    const ep = await wh.createInboundEndpoint(owner, 'Form', []); const existing = await createContact(owner, { firstName: 'Existing', phone: '(414) 201-1302' });
    const m = await post(ep, lead({ phone: '(414) 201-1302', eventId: 'evt-match-1' })); expect(m).toMatchObject({ outcome: 'matched', contactId: existing }); expect((await pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(1);
    await createContact(owner, { firstName: 'Twin', phone: '(414) 201-1302' });
    const x = await post(ep, lead({ phone: '(414) 201-1302', eventId: 'evt-shared-1' })); expect(x).toMatchObject({ outcome: 'created_needs_review' }); expect((await pool.query(`SELECT tags FROM contacts WHERE id=$1`, [(x as any).contactId])).rows[0].tags).toContain('needs-review');
    expect((await pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(3);
  });
  it('validates input: needs phone or email, valid phone, sane sizes', async () => {
    const ep = await wh.createInboundEndpoint(owner, 'Form', []); await expect(post(ep, JSON.stringify({ eventId: 'evt-noid-123', firstName: 'x' }))).rejects.toThrow(/phone or email/);
    await expect(post(ep, lead({ phone: '123' }))).rejects.toThrow(/not a valid number/); await expect(post(ep, lead({ eventId: 'x' }))).rejects.toThrow(/invalid lead/); await expect(post(ep, '{not json')).rejects.toThrow(/JSON/); await expect(post(ep, lead({ message: 'a'.repeat(2001) }))).rejects.toThrow(/invalid lead/);
  });
  it('HTTP: public route is signature-authenticated and does not need a login or CSRF header', async () => {
    const app = await buildApp(); const ep = await wh.createInboundEndpoint(owner, 'Form', []); const raw = lead({ eventId: 'evt-http-1' });
    const bad = await app.inject({ method: 'POST', url: `/hooks/inbound/${ep.id}`, headers: { 'content-type': 'application/json' }, payload: raw }); expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: `/hooks/inbound/${ep.id}`, headers: { 'content-type': 'application/json', 'x-relay-signature': sign(ep.secret, Math.floor(Date.now() / 1000), raw) }, payload: raw }); expect(ok.statusCode).toBe(200); expect(ok.json().outcome).toBe('created'); await app.close();
  });
});
