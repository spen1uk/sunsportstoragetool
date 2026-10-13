import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, resetDb, type Seeded } from './helpers.js';
import * as pay from '../src/domain/payments.js';
import * as cx from '../src/integrations/connections.js';
import { fakePayServer as srv } from '../src/integrations/demo/fakeServers.js';
import { simulatorControl } from '../src/providers/sms.js';
import { buildApp } from '../src/server/app.js';
import { sign } from '../src/integrations/signing.js';
import { createContact } from '../src/domain/contacts.js';
import { listNotifications } from '../src/domain/notifications.js';

let s: Seeded; let owner: ReturnType<typeof actor>; let sam: ReturnType<typeof actor>; let fin: ReturnType<typeof actor>; let connId: string;
const SECRET = 'whsec_demo_secret_123';
beforeEach(async () => {
  srv.reset(); s = await resetDb(); owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; fin = { ...actor(s, 'fin', 'manager', ['financing', 'sales']), name: 'Fran' };
  connId = await cx.connect(owner, 'demo_pay', { apiKey: 'demo_key_1', webhookSecret: SECRET }, { writeEnabled: true });
});
afterAll(() => pool.end());

const mkReq = async (amountCents = 500000, contactPhone = '(414) 201-1001') => { const contactId = await createContact(owner, { firstName: 'Pat', phone: contactPhone }); const id = await pay.createPaymentRequest(owner, { contactId, amountCents, description: 'Deposit on 2019 Sea Ray', reference: 'INV-1042' }); return { id, contactId }; };
const open = async (amt?: number, phone?: string) => { const r = await mkReq(amt, phone); await pay.createLink(owner, r.id); return { ...r, ref: (await row(r.id)).provider_ref as string }; };
const row = async (id: string) => (await pool.query('SELECT * FROM payment_requests WHERE id=$1', [id])).rows[0];
const deliver = (events: any[], o: { secret?: string; now?: number } = {}) => { const w = srv.webhook(o.secret ?? SECRET, events, o.now); return pay.handlePaymentWebhook(connId, w.headers, w.raw); };

describe('creating requests and links', () => {
  it('manager-only; amount sanity bounds; contact visibility enforced', async () => {
    const { contactId } = await mkReq(); const ok = { contactId, description: 'x' };
    await expect(pay.createPaymentRequest(sam, { ...ok, amountCents: 100 })).rejects.toThrow(/manager/);
    for (const bad of [0, -5, 1.5, pay.MAX_AMOUNT_CENTS + 1]) await expect(pay.createPaymentRequest(owner, { ...ok, amountCents: bad })).rejects.toThrow();
    const f = await createContact(fin, { firstName: 'Fin', phone: '(414) 201-1002' }); const cv = (await import('../src/domain/contacts.js')).openConversationFor; const cid = await cv(fin, f, s.departments.financing); void cid;
    const tight = { ...actor(s, 'sam', 'manager', ['sales']), name: 'SalesMgr' }; await expect(pay.createPaymentRequest(tight, { contactId: f, amountCents: 100, description: 'x' })).rejects.toThrow(/not found/);
  });
  it('needs a connected provider with WRITE enabled; secret-free errors', async () => {
    const r = await mkReq(); await cx.setPermissions(owner, connId, { write: false }); await expect(pay.createLink(owner, r.id)).rejects.toThrow(/write access is not enabled/);
    await cx.disconnect(owner, connId); await expect(pay.createLink(owner, r.id)).rejects.toThrow(/No payments provider is connected/);
  });
  it('is idempotent: an uncertain create can be retried and never produces a second provider session; concurrent double-clicks create one', async () => {
    const r = await mkReq(); srv.failCreate = 'ambiguous_once';
    await expect(pay.createLink(owner, r.id)).rejects.toThrow(/may or may not have created/); expect((await row(r.id)).status).toBe('draft'); expect((await row(r.id)).status_detail).toMatch(/creation_outcome_unknown/);
    await pay.createLink(owner, r.id); expect(srv.sessions.size).toBe(1); expect((await row(r.id)).status).toBe('open');
    const r2 = await mkReq(100, '(414) 201-1003'); srv.failCreate = 'none'; const out = await Promise.allSettled([pay.createLink(owner, r2.id), pay.createLink(owner, r2.id)]);
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect(srv.sessions.size).toBe(2);
  });
  it('a not-sent failure leaves the request as a draft you can retry', async () => { const r = await mkReq(); srv.failCreate = 'not_sent'; await expect(pay.createLink(owner, r.id)).rejects.toThrow(/no link was created/); expect(srv.sessions.size).toBe(0); srv.failCreate = 'none'; await pay.createLink(owner, r.id); expect((await row(r.id)).status).toBe('open'); });
  it('the link text is a DRAFT for a person to send — nothing is sent', async () => {
    const r = await open(); const d = await pay.linkMessageDraft(owner, r.id); expect(d.body).toContain('https://pay.demo.invalid/ds_1'); expect(d.body).toContain('$5000.00'); await drain();
    expect(simulatorControl.sent).toHaveLength(0); expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE direction='outbound'`)).rows[0].n).toBe(0);
  });
});

describe('only VERIFIED events change status', () => {
  it('rejects unsigned, tampered, wrong-secret and stale/replayed-old webhooks without any state change', async () => {
    const r = await open(); const ev = srv.pay(r.ref); const w = srv.webhook(SECRET, [ev]);
    await expect(pay.handlePaymentWebhook(connId, {}, w.raw)).rejects.toThrow(/signature rejected: missing/);
    await expect(pay.handlePaymentWebhook(connId, w.headers, w.raw.replace('5000', '1'))).rejects.toThrow(/bad signature/);
    await expect(deliver([ev], { secret: 'whsec_wrong_secret_000' })).rejects.toThrow(/bad signature/);
    await expect(deliver([ev], { now: Date.now() - 3600_000 })).rejects.toThrow(/stale/);          // captured webhook replayed an hour later
    expect(await row(r.id)).toMatchObject({ status: 'open', paid_cents: 0 }); expect((await pool.query('SELECT count(*)::int n FROM payment_events')).rows[0].n).toBe(0);
    expect(await deliver([ev])).toEqual({ recorded: 1, duplicate: 0, unmatched: 0 }); expect(await row(r.id)).toMatchObject({ status: 'paid', paid_cents: 500000 });
  });
  it('duplicate deliveries and provider retries are harmless; webhooks for an inactive connection are refused', async () => {
    const r = await open(); const ev = srv.pay(r.ref); await deliver([ev]); expect(await deliver([ev])).toEqual({ recorded: 0, duplicate: 1, unmatched: 0 }); expect(await deliver([ev, ev])).toMatchObject({ recorded: 0, duplicate: 2 });
    expect(Number((await row(r.id)).paid_cents)).toBe(500000); expect((await pool.query('SELECT count(*)::int n FROM payment_events')).rows[0].n).toBe(1);
    await cx.disconnect(owner, connId); await expect(deliver([srv.pay(r.ref, 1)])).rejects.toThrow(/not active/);
  });
  it('opening the success/return URL proves nothing; only the verified event does', async () => {
    const app = await buildApp(); const r = await open(); const get = () => app.inject({ method: 'GET', url: `/payments/return/${r.id}` });
    const before = await get(); expect(before.statusCode).toBe(200); expect(before.body).toMatch(/confirm your payment as soon as/); expect((await row(r.id)).status).toBe('open');
    await get(); await get(); expect((await row(r.id)).status).toBe('open'); expect((await pool.query('SELECT count(*)::int n FROM payment_events')).rows[0].n).toBe(0);
    await deliver([srv.pay(r.ref)]); expect((await get()).body).toMatch(/confirmed by our payment provider/); expect((await get()).headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: '/payments/return/not-a-uuid' })).body).toMatch(/could not find/); await app.close();
  });
  it('unknown provider references are recorded as unmatched (audit), never applied to anything', async () => {
    const r = await open(); expect(await deliver([{ providerEventId: 'evt_x', providerRef: 'ds_999', type: 'succeeded', amountCents: 100, occurredAt: new Date().toISOString() }])).toEqual({ recorded: 0, duplicate: 0, unmatched: 1 });
    expect((await row(r.id)).paid_cents).toBe(0); expect((await pool.query(`SELECT count(*)::int n FROM audit_events WHERE action='payment.event.unmatched'`)).rows[0].n).toBe(1);
  });
});

describe('status derivation (order-independent)', () => {
  it('partial then full payment; overpayment is noted; receipts stored; timeline + notification written', async () => {
    const r = await open(100000); await deliver([srv.pay(r.ref, 40000)]); expect(await row(r.id)).toMatchObject({ status: 'partially_paid', paid_cents: 40000 });
    await deliver([srv.pay(r.ref, 70000)]); expect(await row(r.id)).toMatchObject({ status: 'paid', paid_cents: 110000 }); expect((await row(r.id)).status_detail).toMatch(/more than the requested/); expect((await row(r.id)).receipt_url).toMatch(/receipt/);
    expect((await pool.query(`SELECT count(*)::int n FROM timeline_events WHERE type='payment'`)).rows[0].n).toBe(2); expect((await listNotifications(owner)).items.filter((n) => n.type === 'payment')).toHaveLength(2);
  });
  it('a refund event arriving BEFORE its payment event does not corrupt state; once both are known the result is correct', async () => {
    const r = await open(100000); const paid = srv.pay(r.ref); const refund = srv.refund(r.ref, 100000);
    await deliver([refund]); expect(await row(r.id)).toMatchObject({ status: 'open' }); expect((await row(r.id)).status_detail).toMatch(/before the payment event/);
    await deliver([paid]); expect(await row(r.id)).toMatchObject({ status: 'refunded', paid_cents: 100000, refunded_cents: 100000 });
  });
  it('same events in any order give the same answer', async () => {
    const evs = [{ type: 'succeeded', amount_cents: 60000, terminal: false }, { type: 'succeeded', amount_cents: 40000, terminal: false }, { type: 'refunded', amount_cents: 25000, terminal: false }];
    const base = { amount_cents: 100000, status: 'open', cancelled_locally: false }; const want = pay.deriveStatus(base, evs);
    for (const perm of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) expect(pay.deriveStatus(base, perm.map((i) => evs[i]))).toEqual(want); expect(want).toMatchObject({ status: 'partially_refunded', paid: 100000, refunded: 25000 });
  });
  it('failure semantics: a non-terminal failure keeps the link usable; terminal failure only counts if nothing was paid', async () => {
    const a = await open(100000); await deliver([{ providerEventId: 'f1', providerRef: a.ref, type: 'failed', terminal: false, occurredAt: new Date().toISOString() }]); expect((await row(a.id)).status).toBe('open');
    await deliver([{ providerEventId: 'f2', providerRef: a.ref, type: 'failed', terminal: true, occurredAt: new Date().toISOString() }]); expect((await row(a.id)).status).toBe('failed');
    const b = await open(100000, '(414) 201-1004'); await deliver([srv.pay(b.ref, 30000), { providerEventId: 'f3', providerRef: b.ref, type: 'failed', terminal: true, occurredAt: new Date().toISOString() }]); expect((await row(b.id)).status).toBe('partially_paid');
  });
  it('local cancel never hides money: a later verified payment still shows as paid', async () => {
    const r = await open(); await pay.cancelRequest(owner, r.id); expect(await row(r.id)).toMatchObject({ status: 'cancelled' }); expect((await row(r.id)).status_detail).toMatch(/may still be payable/);
    await deliver([srv.pay(r.ref)]); expect((await row(r.id)).status).toBe('paid');
  });
});

describe('refunds and reconciliation', () => {
  it('a refund REQUEST changes nothing locally; the signed provider event does; limits enforced', async () => {
    const r = await open(100000); await deliver([srv.pay(r.ref)]);
    await expect(pay.refund(owner, r.id, 200000)).rejects.toThrow(/between 1 and 100000/); await expect(pay.refund(sam, r.id, 100)).rejects.toThrow(/manager/);
    expect((await pay.refund(owner, r.id, 30000)).requested).toBe(true); expect((await row(r.id)).refunded_cents).toBe(0); expect((await row(r.id)).status).toBe('paid');
    await deliver([{ providerEventId: 'evt_r1', providerRef: r.ref, type: 'refunded', amountCents: 30000, occurredAt: new Date().toISOString() }]); expect(await row(r.id)).toMatchObject({ status: 'partially_refunded', refunded_cents: 30000 });
    await cx.setPermissions(owner, connId, { write: false }); await expect(pay.refund(owner, r.id, 100)).rejects.toThrow(/write access/);
  });
  it('RECONCILIATION fills a missed webhook, is idempotent, and a LATE webhook for the same payment does not double-count', async () => {
    const r = await open(100000); const ev = srv.pay(r.ref);                          // customer paid; webhook never arrived
    await pool.query(`UPDATE payment_requests SET updated_at = now() - interval '5 minutes'`);
    expect(await pay.reconcileOne(r.id)).toBe('filled'); expect(await row(r.id)).toMatchObject({ status: 'paid', paid_cents: 100000 }); expect(await pay.reconcileOne(r.id)).toBe('ok');
    await deliver([ev]); expect(await row(r.id)).toMatchObject({ status: 'paid', paid_cents: 100000 });              // late webhook: same cumulative total
    expect((await pool.query(`SELECT count(*)::int n FROM audit_events WHERE action='payment.reconcile.filled'`)).rows[0].n).toBe(1);
    expect(await pay.reconcileOpen()).toBe(0);
  });
  it('reconciliation flags (never auto-fixes) a provider that reports LESS than our verified events; expiry is only learned from the provider', async () => {
    const r = await open(100000); await deliver([srv.pay(r.ref)]); srv.sessions.get(r.ref)!.paid = 50000;
    expect(await pay.reconcileOne(r.id)).toBe('mismatch'); expect(await row(r.id)).toMatchObject({ status: 'paid', paid_cents: 100000 }); expect((await row(r.id)).status_detail).toMatch(/MISMATCH/);
    const e = await open(100000, '(414) 201-1005'); await pool.query(`UPDATE payment_requests SET expires_at = now() - interval '1 hour' WHERE id=$1`, [e.id]); expect(await pay.reconcileOne(e.id)).toBe('ok'); expect((await row(e.id)).status).toBe('open');   // local clock alone proves nothing
    srv.sessions.get(e.ref)!.status = 'expired'; expect(await pay.reconcileOne(e.id)).toBe('filled'); expect((await row(e.id)).status).toBe('expired');
  });
});

describe('accounting separation, visibility, API', () => {
  it('Relay never changes accounting data: paid in Relay leaves accounting fields untouched and says the balance is unverified', async () => {
    const r = await open(); await pay.setAccountingRef(owner, r.id, 'QB-INV-1042', 'Matched manually by Sam'); await deliver([srv.pay(r.ref)]);
    const x = await row(r.id); expect(x).toMatchObject({ status: 'paid', accounting_ref: 'QB-INV-1042', accounting_note: 'Matched manually by Sam' });
    const listed = (await pay.listPayments(owner)).find((p) => p.id === r.id)!; expect(listed.accounting).toMatch(/NOT verified/); expect((await pay.listPayments(owner)).length).toBe(1);
    const noRef = await open(100, '(414) 201-1006'); expect((await pay.listPayments(owner)).find((p) => p.id === noRef.id)!.accounting).toMatch(/not checked or changed by Relay/);
  });
  it('payments follow customer visibility (financing customers are hidden from non-financing staff)', async () => {
    const f = await createContact(fin, { firstName: 'Fin', phone: '(414) 201-1007' }); const { openConversationFor } = await import('../src/domain/contacts.js'); await openConversationFor(fin, f, s.departments.financing);
    const id = await pay.createPaymentRequest(fin, { contactId: f, amountCents: 5000, description: 'Financing fee' });
    expect((await pay.listPayments(fin)).map((p) => p.id)).toContain(id); expect((await pay.listPayments(sam)).map((p) => p.id)).not.toContain(id); await expect(pay.getPayment(sam, id)).rejects.toThrow(/not found/);
  });
  it('API: signed webhook endpoint end-to-end (rate-limited public route), staff cannot create requests', async () => {
    const app = await buildApp(); const login = async (e: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email: e, password: 'test-password-123' } })).headers['set-cookie'] as string;
    const co = (await login('owner@demo.relay.test')).split(';')[0], cs = (await login('sam@demo.relay.test')).split(';')[0]; const call = (cookie: string, method: any, url: string, payload?: object) => app.inject({ method, url, headers: { cookie, 'x-relay-csrf': '1' }, payload });
    const contact = (await call(co, 'POST', '/api/contacts', { firstName: 'Api', phone: '(414) 201-1008' })).json().id;
    expect((await call(cs, 'POST', '/api/payments', { contactId: contact, amountCents: 100, description: 'x' })).statusCode).toBe(403);
    const pid = (await call(co, 'POST', '/api/payments', { contactId: contact, amountCents: 123456, description: 'API deposit' })).json().id; expect((await call(co, 'POST', `/api/payments/${pid}/link`)).statusCode).toBe(200);
    const ref = (await row(pid)).provider_ref; const w = srv.webhook(SECRET, [srv.pay(ref)]);
    const bad = await app.inject({ method: 'POST', url: `/webhooks/payments/${connId}`, headers: { 'content-type': 'application/json' }, payload: w.raw }); expect(bad.statusCode).toBe(401); expect((await row(pid)).status).toBe('open');
    const good = await app.inject({ method: 'POST', url: `/webhooks/payments/${connId}`, headers: { 'content-type': 'application/json', ...w.headers }, payload: w.raw }); expect(good.json()).toMatchObject({ recorded: 1 }); expect((await row(pid)).status).toBe('paid');
    expect(((await call(co, 'GET', `/api/payments/${pid}`)).json()).events[0]).toMatchObject({ type: 'succeeded', source: 'signed_webhook' }); await app.close(); void sign;
  });
});
