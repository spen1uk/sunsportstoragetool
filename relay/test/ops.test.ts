import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pool } from '../src/db/pool.js';
import { actor, drain, inbound, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import { buildApp, scrubUrl } from '../src/server/app.js';
import { config } from '../src/config.js';
import { beat, productionProblems, readiness, systemStatus, metricsText } from '../src/domain/ops.js';
import { claim, enqueue } from '../src/domain/queue.js';
import { publish } from '../src/domain/events.js';
import { eraseContact, exportContact } from '../src/domain/privacy.js';
import { addNote, setHandlingMode } from '../src/domain/conversations.js';
import { queueOutbound } from '../src/domain/messaging.js';
import { changeConsent } from '../src/domain/contacts.js';
import { getSummary } from '../src/domain/summary.js';
import { simulatorControl } from '../src/providers/sms.js';
import { saveMedia } from '../src/domain/media.js';

let s: Seeded; let app: Awaited<ReturnType<typeof buildApp>>;
let owner: ReturnType<typeof actor>; let sam: ReturnType<typeof actor>;
const saved = { ...config };
beforeEach(async () => { s = await resetDb(); owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; });
afterEach(async () => { Object.assign(config, saved); await app?.close(); });
afterAll(() => pool.end());

async function login(a: typeof app, email = 'owner@demo.relay.test') {
  const r = await a.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email, password: 'test-password-123' } });
  return String(r.headers['set-cookie']).split(';')[0];
}

describe('production config guard', () => {
  const good = { env: 'production', databaseUrl: 'postgres://relay:s3cure-Passw0rd@db:5432/relay', credentialKeyHex: '', credentialKeysJson: '{"1":"' + 'ab'.repeat(32) + '"}', mediaSigningKey: 'x'.repeat(40), simulatorWebhookSecret: 'y'.repeat(40), publicBaseUrl: 'https://relay.example.com', secureCookies: true, testJobs: false, allowSandboxInProduction: false, trustProxy: 1 as number | boolean | string[] };
  it('accepts a proper production configuration and ignores non-production', () => {
    expect(productionProblems(good)).toEqual([]);
    expect(productionProblems({ ...good, env: 'development', databaseUrl: 'relay_dev_only' })).toEqual([]);
  });
  it.each([
    [{ databaseUrl: 'postgres://relay:relay_dev_only@localhost/relay_dev' }, /development password/],
    [{ credentialKeysJson: '', credentialKeyHex: '' }, /CREDENTIAL_KEYS/],
    [{ mediaSigningKey: 'dev-media-signing-key' }, /MEDIA_SIGNING_KEY/],
    [{ simulatorWebhookSecret: 'dev-simulator-secret' }, /SIM_WEBHOOK_SECRET/],
    [{ publicBaseUrl: 'http://relay.example.com' }, /https/],
    [{ secureCookies: false }, /Secure cookies/],
    [{ testJobs: true }, /RELAY_TEST_JOBS/],
    [{ allowSandboxInProduction: true }, /ALLOW_SANDBOX/],
    [{ trustProxy: true }, /TRUST_PROXY/],
  ])('refuses %j', (patch, re) => { expect(productionProblems({ ...good, ...patch }).join('\n')).toMatch(re); });
  it('the simulator webhook endpoint does not exist in production (no forging inbound texts)', async () => {
    config.env = 'production'; app = await buildApp();
    const r = await app.inject({ method: 'POST', url: '/webhooks/sms/simulator', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(404);
  });
});

describe('probes, status and metrics', () => {
  it('/health is liveness; /ready also needs a current schema', async () => {
    app = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    expect((await readiness()).checks).toMatchObject({ database: 'ok', migrations: 'ok' });
    await pool.query(`DELETE FROM schema_migrations WHERE name='008_sandra_ops.sql'`);
    const r = await app.inject({ method: 'GET', url: '/ready' }); expect(r.statusCode).toBe(503); expect(r.json().checks.migrations).toMatch(/008_sandra_ops/);
  });
  it('admin status reports a missing worker until a heartbeat exists, then healthy; backlog and unknown messages surface', async () => {
    app = await buildApp(); const cookie = await login(app);
    let st = (await app.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie } })).json();
    expect(st.ok).toBe(false); expect(st.problems.join(' ')).toMatch(/No worker heartbeat/);
    await beat(5); st = (await app.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie } })).json();
    expect(st.workers[0]).toMatchObject({ alive: true, jobsDone: 5 }); expect(st.problems.join(' ')).not.toMatch(/No worker/);
    await pool.query(`UPDATE worker_heartbeats SET beat_at = now() - interval '2 minutes'`); expect((await systemStatus()).workers[0].alive).toBe(false);
    // unknown outcome + overdue job show up
    const c = await newCustomerConvo(s, owner); await queueOutbound({ workspaceId: s.workspaceId, conversationId: c.conversationId, body: 'hi', senderType: 'staff', senderUserId: owner.userId, idempotencyKey: 'ops-unknown-1' });
    await pool.query(`UPDATE messages SET status='unknown'`); await pool.query(`UPDATE jobs SET run_at = now() - interval '10 minutes'`);
    const st2 = await systemStatus(); expect(st2.unknownMessages).toBe(1); expect(st2.queue.oldest_due_seconds).toBeGreaterThan(500); expect(st2.problems.join(' ')).toMatch(/unknown delivery outcome/);
  });
  it('status is admin only', async () => {
    app = await buildApp(); const cookie = await login(app, 'sam@demo.relay.test');
    expect((await app.inject({ method: 'GET', url: '/api/admin/status', headers: { cookie } })).statusCode).toBe(403);
  });
  it('/metrics is off without a token, rejects wrong tokens, and exposes only counters', async () => {
    app = await buildApp(); expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    config.metricsToken = 'metrics-token-123';
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer wrong-token-12345' } })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token-123' } });
    expect(ok.statusCode).toBe(200); expect(ok.body).toMatch(/relay_workers_alive 0/); expect(ok.body).toMatch(/relay_jobs\{state="pending"\}/); expect(ok.body).not.toMatch(/@|\+1\d{10}/);
    expect(await metricsText()).toContain('relay_ready 1');
  });
});

describe('http hardening', () => {
  it('sets security headers everywhere and never caches API responses', async () => {
    app = await buildApp(); const r = await app.inject({ method: 'GET', url: '/api/me' });
    expect(r.headers).toMatchObject({ 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
  });
  it('redacts credentials from logs: Authorization, cookies, signatures, and signed-URL query tokens', async () => {
    const lines: string[] = []; app = await buildApp({ logStream: new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } }) });
    await app.inject({ method: 'GET', url: '/api/v1/me?sig=SUPERSECRETSIG&token=TOKENVALUE', headers: { authorization: 'Bearer rk_abcdefabcdef_SECRETKEYSECRETKEYSECRET', cookie: 'relay_session=SESSIONSECRET', 'x-relay-signature': 't=1,v1=SIGSECRET' } });
    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of ['SUPERSECRETSIG', 'TOKENVALUE', 'SECRETKEYSECRETKEY', 'SESSIONSECRET', 'SIGSECRET']) expect(log).not.toContain(secret);
    expect(scrubUrl('/media/x?sig=abc&exp=1')).toBe('/media/x?sig=[redacted]&exp=1');
  });
  it('does NOT trust X-Forwarded-For by default; trusts it only when TRUST_PROXY says so', async () => {
    const ipOf = async () => { const lines: string[] = []; app = await buildApp({ logStream: new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }) }); await app.inject({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': '9.9.9.9' } }); await app.close(); return lines.join(''); };
    expect(await ipOf()).not.toContain('9.9.9.9');
    config.trustProxy = 1; expect(await ipOf()).toContain('9.9.9.9');
  });
});

describe('job lease & recovery', () => {
  it('a job whose worker vanished is reclaimed after the configured lease and run again', async () => {
    config.jobLeaseSeconds = 1; await enqueue(pool, 'send_message', { messageId: '00000000-0000-0000-0000-000000000000' }, { dedupeKey: 'lease-test' });
    const first = await claim(); expect(first?.attempts).toBe(1);
    expect(await claim()).toBeNull();                                  // leased: nobody else may take it
    await new Promise((r) => setTimeout(r, 1200));
    const again = await claim(); expect(again?.id).toBe(first!.id); expect(again?.attempts).toBe(2);
  });
});

describe('realtime recovery', () => {
  it('when the LISTEN connection is killed the server reconnects, tells clients to resync, and live events flow again', async () => {
    app = await buildApp(); await app.listen({ port: 0, host: '127.0.0.1' }); const port = (app.server.address() as { port: number }).port;
    const cookie = await login(app);
    const ctrl = new AbortController(); const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie }, signal: ctrl.signal });
    const reader = res.body!.getReader(); let buf = '';
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;   // exactly one outstanding read, so no chunk is ever consumed by an abandoned promise
    const waitFor = async (re: RegExp, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(buf)) return; pending ??= reader.read(); const r = await Promise.race([pending, new Promise<null>((x) => setTimeout(() => x(null), 200))]); if (r) { pending = null; if (!r.done) buf += new TextDecoder().decode(r.value); } } throw new Error(`timed out waiting for ${re}; got ${buf}`); };
    await waitFor(/retry: 2000/);
    await publish(pool, s.workspaceId, 'conversation.updated', { conversationId: 'before' }); await waitFor(/"conversationId":"before"/);
    const killed = await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='relay-sse-listener'`); expect(killed.rowCount).toBe(1);
    await waitFor(/"type":"resync"/);
    await publish(pool, s.workspaceId, 'conversation.updated', { conversationId: 'after' }); await waitFor(/"conversationId":"after"/);
    ctrl.abort();
    expect((await systemStatus()).realtime.listenerReconnects).toBeGreaterThanOrEqual(1);
  }, 30000);
});

describe('data export & erasure', () => {
  const setup = async () => {
    const c = await newCustomerConvo(s, owner, '(414) 201-7777', 'Pat'); await inbound('(414) 201-7777', 'My address is 12 Lake Rd, call me about the Sea Ray'); await addNote(owner, c.conversationId, 'Pat prefers mornings');
    await queueOutbound({ workspaceId: s.workspaceId, conversationId: c.conversationId, body: 'Happy to help Pat', senderType: 'staff', senderUserId: owner.userId, idempotencyKey: 'pv-1' }); await drain();
    await saveMedia({ workspaceId: s.workspaceId }, { filename: 'pat-photo.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]), origin: 'inbound_mms', contactId: c.contactId }).catch(() => null);
    return c;
  };
  it('export is admin-only, complete, and audited', async () => {
    const c = await setup();
    await expect(exportContact(sam, c.contactId)).rejects.toThrow(/owner or admin/);
    const x = await exportContact(owner, c.contactId);
    expect(x.contact.first_name).toBe('Pat'); expect(JSON.stringify(x.messages)).toContain('12 Lake Rd'); expect(x.notes[0].body).toBe('Pat prefers mornings'); expect(x.identities[0].original_value).toContain('414');
    expect((await pool.query(`SELECT 1 FROM audit_events WHERE action='contact.export'`)).rowCount).toBe(1);
  });
  it('erase needs the confirmation word and admin rights, then removes personal content everywhere but keeps proof of opt-out', async () => {
    const c = await setup(); await inbound('(414) 201-7777', 'STOP'); await drain();
    await expect(eraseContact(sam, c.contactId, 'ERASE')).rejects.toThrow(/owner or admin/);
    await expect(eraseContact(owner, c.contactId, 'yes')).rejects.toThrow(/confirmation/);
    const r = await eraseContact(owner, c.contactId, 'ERASE'); expect(r.ok).toBe(true);
    const all = JSON.stringify([(await pool.query('SELECT * FROM contacts WHERE id=$1', [c.contactId])).rows, (await pool.query('SELECT body, from_original, to_original FROM messages')).rows, (await pool.query('SELECT * FROM notes')).rows, (await pool.query('SELECT original_value FROM contact_identities')).rows, (await pool.query('SELECT summary FROM timeline_events')).rows, (await pool.query('SELECT last_preview FROM conversations')).rows]);
    for (const pii of ['Pat', '12 Lake Rd', 'mornings', '414', 'Sea Ray']) expect(all, pii).not.toContain(pii);
    const ct = (await pool.query('SELECT * FROM contacts WHERE id=$1', [c.contactId])).rows[0]; expect(ct).toMatchObject({ first_name: 'Erased', email: null, outbound_blocked: true, sms_opted_out: true }); expect(ct.erased_at).not.toBeNull();
    expect((await pool.query(`SELECT count(*)::int n FROM consent_events WHERE contact_id=$1 AND type='sms_stop'`, [c.contactId])).rows[0].n).toBe(1);   // proof retained
    expect((await pool.query('SELECT normalized FROM contact_identities WHERE contact_id=$1', [c.contactId])).rows[0].normalized).toBe('+14142017777'); // suppression record kept (opted out)
    expect((await pool.query(`SELECT count(*)::int n FROM media_assets WHERE contact_id=$1 AND deleted_at IS NULL`, [c.contactId])).rows[0].n).toBe(0);
    expect((await getSummary(owner, c.contactId)).status).toBe('none');
    await expect(eraseContact(owner, c.contactId, 'ERASE')).rejects.toThrow(/already erased/);
    expect((await pool.query(`SELECT meta FROM audit_events WHERE action='contact.erase'`)).rows[0].meta).toMatchObject({ numberKeptAsSuppression: true });
  });
  it('an erased contact can never be texted (even by a forced attempt), and queued sends are cancelled', async () => {
    const c = await setup(); await setHandlingMode(owner, c.conversationId, 'human');
    await queueOutbound({ workspaceId: s.workspaceId, conversationId: c.conversationId, body: 'pending text', senderType: 'staff', senderUserId: owner.userId, idempotencyKey: 'pv-queued' });
    await eraseContact(owner, c.contactId, 'ERASE'); simulatorControl.reset(); await drain();
    expect(simulatorControl.sent).toHaveLength(0);
    const r = await queueOutbound({ workspaceId: s.workspaceId, conversationId: c.conversationId, body: 'hello?', senderType: 'staff', senderUserId: owner.userId, idempotencyKey: 'pv-after' });
    expect(r.ok).toBe(false);
  });
  it('without an opt-out the phone number is deleted entirely', async () => {
    const c = await setup(); await eraseContact(owner, c.contactId, 'ERASE');
    expect((await pool.query('SELECT count(*)::int n FROM contact_identities WHERE contact_id=$1', [c.contactId])).rows[0].n).toBe(0);
    await changeConsent(owner, c.contactId, 'marketing_opt_out').catch(() => undefined);
  });
  it('refuses while a payment request is still open', async () => {
    const c = await setup();
    await pool.query(`INSERT INTO payment_requests (workspace_id, contact_id, created_by, amount_cents, description, status) VALUES ($1,$2,$3,5000,'Deposit Pat','open')`, [s.workspaceId, c.contactId, s.users.owner]);
    await expect(eraseContact(owner, c.contactId, 'ERASE')).rejects.toThrow(/payment request/);
    await pool.query(`UPDATE payment_requests SET status='paid', paid_cents=5000`); await eraseContact(owner, c.contactId, 'ERASE');
    const p = (await pool.query('SELECT description, amount_cents, paid_cents FROM payment_requests')).rows[0]; expect(p).toMatchObject({ description: '[erased]', amount_cents: 5000, paid_cents: 5000 });
  });
});
