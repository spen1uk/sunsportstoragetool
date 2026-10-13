import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, resetDb, type Seeded } from './helpers.js';
import * as cx from '../src/integrations/connections.js';
import { fakeReviewServer as srv } from '../src/integrations/demo/fakeServers.js';
import { listAdapters } from '../src/integrations/adapter.js';
import { CATALOG } from '../src/integrations/catalog.js';
import { config } from '../src/config.js';
import { listNotifications } from '../src/domain/notifications.js';
import { decryptJson } from '../src/integrations/crypto.js';

let s: Seeded; let owner: ReturnType<typeof actor>; let sam: ReturnType<typeof actor>;
const rev = (n: number) => Array.from({ length: n }, (_, i) => ({ externalId: `R${i + 1}`, rating: 5 - (i % 5), authorName: `Reviewer ${i + 1}`, body: `Review text ${i + 1}`, reviewedAt: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(), replyText: null as string | null, repliedAt: null as string | null }));
const creds = () => ({ accessToken: srv.accessToken, refreshToken: srv.refreshToken, expiresAt: new Date(srv.tokenExpiresAt).toISOString() });
beforeEach(async () => { srv.reset(); s = await resetDb(); owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; });
afterAll(() => pool.end());
const conn = async () => (await pool.query('SELECT * FROM connections')).rows[0];
const connect = async (n = 5) => { srv.reviews = rev(n); const id = await cx.connect(owner, 'demo_reviews', creds()); srv.listCalls = 0; return id; };   // validation makes one list call; don't count it
const count = async (t: string) => (await pool.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n;

describe('connecting', () => {
  it('admin only; providers without an adapter cannot be connected (explains why); bad credentials are rejected and nothing is stored', async () => {
    await expect(cx.connect(sam, 'demo_reviews', creds())).rejects.toThrow(/owner or admin/);
    await expect(cx.connect(owner, 'quickbooks', {})).rejects.toThrow(/no adapter exists/);
    await expect(cx.connect(owner, 'demo_reviews', { accessToken: 'wrong', refreshToken: 'x' })).rejects.toThrow(/credentials rejected/);
    expect(await count('connections')).toBe(0);
  });
  it('credentials are encrypted at rest, bound to the row, never returned by the API, and writes are OFF by default', async () => {
    await connect(); const row = await conn();
    expect(row.credentials_enc).not.toContain('at_1'); expect(row.credentials_enc).not.toContain('rt_1'); expect(row.key_version).toBe(1);
    expect(decryptJson(row.credentials_enc, `conn:${row.id}`).accessToken).toBe('at_1'); expect(() => decryptJson(row.credentials_enc, 'conn:other')).toThrow();
    const view = (await cx.listIntegrations(owner)).find((e) => e.id === 'demo_reviews')!.connection!;
    expect(JSON.stringify(view)).not.toMatch(/at_1|rt_1|credentials_enc/); expect(view).toMatchObject({ status: 'connected', readEnabled: true, writeEnabled: false, hasCredentials: true, account: 'Demo Marine Reviews' });
    expect(() => cx.assertWritable(row)).toThrow(/not enabled/);
    await expect(cx.setPermissions(sam, row.id, { write: true })).rejects.toThrow(/owner or admin/);
    await cx.setPermissions(owner, row.id, { write: true }); expect(() => cx.assertWritable({ ...row, write_enabled: true })).not.toThrow();
    await cx.setPermissions(owner, row.id, { read: false }); expect(await cx.runSync(row.id, 'reviews')).toEqual({ status: 'skipped' });   // reads can be turned off independently
  });
  it('already-connected providers cannot be connected twice', async () => { await connect(); await expect(cx.connect(owner, 'demo_reviews', creds())).rejects.toThrow(/already connected/); });
});

describe('sync', () => {
  it('pages through everything, maps external ids, records runs and source stats; a second sync writes nothing; a changed review updates exactly one', async () => {
    const id = await connect(5); await drain();
    expect(await count('reviews')).toBe(5); expect(await count('external_mappings')).toBe(5); expect(srv.listCalls).toBe(3);                // 2+2+1
    const run = (await pool.query('SELECT status, fetched, created, updated, skipped FROM sync_runs')).rows[0]; expect(run).toEqual({ status: 'ok', fetched: 5, created: 5, updated: 0, skipped: 0 });
    const c = await conn(); expect(c.last_success_sync_at).not.toBeNull(); expect(c.credentials_meta.sourceStats).toMatchObject({ averageRating: 3, totalReviewCount: 5 });
    const r2 = await cx.runSync(id, 'reviews'); expect(r2).toMatchObject({ status: 'ok', created: 0, updated: 0, skipped: 5 });             // idempotent: unchanged data is not rewritten
    srv.reviews[1].body = 'Edited upstream'; expect(await cx.runSync(id, 'reviews')).toMatchObject({ created: 0, updated: 1, skipped: 4 });
    expect((await pool.query(`SELECT body FROM reviews WHERE external_id='R2'`)).rows[0].body).toBe('Edited upstream'); expect(await count('reviews')).toBe(5);
  });
  it('a failure mid-sweep keeps progress: the next run resumes at the saved cursor instead of starting over', async () => {
    const id = await connect(6); srv.failListOnCall = 2;                                              // page 1 succeeds, page 2 fails temporarily
    const a = await cx.runSync(id, 'reviews'); expect(a).toMatchObject({ status: 'retry' }); expect(a.retryInSeconds).toBeGreaterThan(0);
    expect(await count('reviews')).toBe(2); expect((await pool.query('SELECT cursor FROM sync_state')).rows[0].cursor).toBe('2'); expect((await conn()).status).toBe('connected');
    srv.listCalls = 0; srv.failListOnCall = 0; await pool.query('UPDATE sync_state SET next_attempt_at=NULL'); const b = await cx.runSync(id, 'reviews');
    expect(b.status).toBe('ok'); expect(srv.listCalls).toBe(2); expect(await count('reviews')).toBe(6); expect((await pool.query('SELECT cursor FROM sync_state')).rows[0].cursor).toBeNull();   // pages 3 and 5 only
  });
  it('scan schedules due syncs only: not while healthy-and-recent, not while backing off', async () => {
    const id = await connect(2); await drain(); expect(await cx.scanConnections()).toBe(0);
    await pool.query(`UPDATE sync_state SET last_success_at = now() - interval '1 hour'`); expect(await cx.scanConnections()).toBe(1); await drain();
    await pool.query(`UPDATE sync_state SET last_success_at = now() - interval '1 hour', next_attempt_at = now() + interval '10 minutes'`); expect(await cx.scanConnections()).toBe(0); void id;
  });
});

describe('tokens: refresh, failure classes, recovery', () => {
  it('refreshes an expiring token BEFORE calling the API and stores the new one encrypted', async () => {
    const id = await connect(2); srv.expireToken(); await pool.query(`UPDATE connections SET credentials_meta = jsonb_set(credentials_meta,'{expiresAt}','"2000-01-01T00:00:00Z"')`);
    const row0 = await conn(); const old = decryptJson(row0.credentials_enc, `conn:${id}`); await pool.query(`UPDATE connections SET credentials_enc=$2 WHERE id=$1`, [id, (await import('../src/integrations/crypto.js')).encryptJson({ ...old, expiresAt: new Date(Date.now() - 1000).toISOString() }, `conn:${id}`).enc]);
    const r = await cx.runSync(id, 'reviews'); expect(r.status).toBe('ok'); expect(srv.refreshCalls).toBe(1);
    expect(decryptJson((await conn()).credentials_enc, `conn:${id}`).accessToken).toBe(srv.accessToken); expect(srv.accessToken).not.toBe('at_1');
  });
  it('TEMPORARY refresh failure → stays connected, error recorded, backoff scheduled, recovers on its own', async () => {
    const id = await connect(2); srv.expireToken(); srv.refreshMode = 'transient';
    const row = await conn(); const cr = decryptJson(row.credentials_enc, `conn:${id}`); await pool.query(`UPDATE connections SET credentials_enc=$2 WHERE id=$1`, [id, (await import('../src/integrations/crypto.js')).encryptJson({ ...cr, expiresAt: new Date(Date.now() - 1000).toISOString() }, `conn:${id}`).enc]);
    const r = await cx.runSync(id, 'reviews'); expect(r).toMatchObject({ status: 'retry', retryInSeconds: 30 });
    expect(await conn()).toMatchObject({ status: 'connected', error_count: 1 }); expect((await pool.query('SELECT next_attempt_at FROM sync_state')).rows[0].next_attempt_at).not.toBeNull();
    srv.refreshMode = 'ok'; await pool.query('UPDATE sync_state SET next_attempt_at=NULL'); expect((await cx.runSync(id, 'reviews')).status).toBe('ok'); expect(await conn()).toMatchObject({ status: 'connected', error_count: 0, last_error: null });
  });
  it('PERMANENT refusal (invalid_grant) → needs_reauth, admins notified, pending syncs cancelled, NO retry storm, secrets masked', async () => {
    const id = await connect(4); await drain(); srv.reviews = rev(6); srv.refreshMode = 'invalid_grant';
    const row = await conn(); const cr = decryptJson(row.credentials_enc, `conn:${id}`); await pool.query(`UPDATE connections SET credentials_enc=$2 WHERE id=$1`, [id, (await import('../src/integrations/crypto.js')).encryptJson({ ...cr, expiresAt: new Date(Date.now() - 1000).toISOString() }, `conn:${id}`).enc]);
    await pool.query(`UPDATE sync_state SET last_success_at = now() - interval '1 hour'`); await cx.scanConnections();
    await drain(); srv.listCalls = 0; srv.refreshCalls = 0;
    const r = await cx.runSync(id, 'reviews'); expect(r.status).toBe('skipped');                     // already needs_reauth → nothing runs
    const c = await conn(); expect(c.status).toBe('needs_reauth'); expect(c.last_error).toMatch(/invalid_grant/); expect(c.last_error).not.toMatch(/rt_1|at_1/);
    expect((await listNotifications(owner)).items.some((n) => n.type === 'connection_needs_reauth')).toBe(true);
    expect(await cx.scanConnections()).toBe(0); expect((await pool.query(`SELECT count(*)::int n FROM jobs WHERE kind='connection_sync' AND status='pending'`)).rows[0].n).toBe(0);
    expect(srv.refreshCalls).toBe(0);                                                                // no hammering the provider
  });
  it('FAILED-TOKEN RECOVERY: after re-authorization, sync resumes from the saved cursor with no duplicates', async () => {
    const id = await connect(6); srv.failListOnCall = 2; await cx.runSync(id, 'reviews'); expect(await count('reviews')).toBe(2);
    srv.revoked = true; srv.listCalls = 0; const dead = await cx.runSync(id, 'reviews'); expect(dead.status).toBe('failed'); expect((await conn()).status).toBe('needs_reauth');
    // owner re-authorizes at the provider and gives Relay the new tokens
    srv.revoked = false; srv.accessToken = 'at_new'; srv.refreshToken = 'rt_new'; srv.tokenExpiresAt = Date.now() + 3600_000; srv.failListOnCall = 0;
    await expect(cx.reauthorize(sam, id, creds())).rejects.toThrow(/owner or admin/); await expect(cx.reauthorize(owner, id, { accessToken: 'stale', refreshToken: 'x' })).rejects.toThrow(/rejected/);
    await cx.reauthorize(owner, id, creds()); expect(await conn()).toMatchObject({ status: 'connected', error_count: 0, last_error: null });
    srv.listCalls = 0; await drain();
    expect(await count('reviews')).toBe(6); expect(await count('external_mappings')).toBe(6); expect(srv.listCalls).toBe(2);                 // resumed at the cursor (pages 2 and 3), not re-fetching page 1
  });
  it('a token revoked at the provider mid-sync gets one forced refresh, then needs_reauth', async () => {
    const id = await connect(3); srv.revoked = true; const r = await cx.runSync(id, 'reviews'); expect(r.status).toBe('failed'); expect((await conn()).status).toBe('needs_reauth');
  });
});

describe('disconnect, rotation, catalog', () => {
  it('disconnect destroys stored credentials, cancels jobs, stops sync; reconnect reuses the mapping (no duplicate reviews)', async () => {
    const id = await connect(4); await drain(); const out = await cx.disconnect(owner, id);
    expect(out.revoked).toBe('revoked_at_provider'); expect(await conn()).toMatchObject({ status: 'disconnected', credentials_enc: null, read_enabled: false, write_enabled: false });
    expect(await cx.runSync(id, 'reviews')).toEqual({ status: 'skipped' }); await expect(cx.disconnect(sam, id)).rejects.toThrow(/owner or admin/);
    await cx.connect(owner, 'demo_reviews', creds()); expect((await conn()).id).toBe(id); await drain(); expect(await count('reviews')).toBe(4); expect(await count('external_mappings')).toBe(4);
  });
  it('key rotation re-encrypts every stored secret and everything keeps working', async () => {
    const id = await connect(2); const saved = [config.credentialKeysJson, config.credentialKeyActive] as const;
    try { config.credentialKeysJson = JSON.stringify({ 1: '07'.repeat(32), 2: '09'.repeat(32) }); config.credentialKeyActive = 2;
      expect((await cx.rotateAllSecrets()).rotated).toBe(1); expect((await conn()).key_version).toBe(2); expect((await cx.rotateAllSecrets()).rotated).toBe(0);
      config.credentialKeysJson = JSON.stringify({ 2: '09'.repeat(32) }); expect((await cx.runSync(id, 'reviews')).status).toBe('ok');
    } finally { config.credentialKeysJson = saved[0]; config.credentialKeyActive = saved[1]; }
  });
  it('capability matrix is honest: every requested integration is listed; none claims production testing; only adapter-backed ones are connectable; sandbox adapters are labelled', async () => {
    const list = await cx.listIntegrations(owner); const ids = list.map((e) => e.id);
    for (const want of ['google_business_profile', 'google_gmail', 'google_calendar', 'google_drive', 'quickbooks', 'meta_messaging', 'tiktok', 'ringcentral_calls', 'zoho_crm', 'openai', 'anthropic', 'sandra', 'generic_webhooks', 'inventory_system']) expect(ids).toContain(want);
    expect(CATALOG.flatMap((e) => e.capabilities).filter((c) => c.state === 'production-tested')).toHaveLength(0);
    const sandboxAllowed = new Set(['demo_pay', 'demo_reviews', 'generic_webhooks', 'inventory_system']);
    for (const e of CATALOG.filter((x) => x.implementation === 'not-built' || x.implementation === 'helper')) for (const c of e.capabilities) if (c.state === 'sandbox-tested') expect(sandboxAllowed.has(e.id)).toBe(true);
    expect(list.filter((e) => e.connectable).map((e) => e.id).sort()).toEqual(listAdapters().map((a) => a.key).sort());
    expect(list.find((e) => e.id === 'quickbooks')).toMatchObject({ connectable: false, implementation: 'not-built' }); expect(list.find((e) => e.id === 'quickbooks')!.blockers.length).toBeGreaterThan(0);
    expect(list.find((e) => e.id === 'meta_messaging')!.capabilities.find((c) => c.id === 'marketplace.personal')!.state).toBe('unsupported');
    expect(list.find((e) => e.id === 'ringcentral_calls')!.capabilities.find((c) => c.id === 'sms.routing')!.state).toBe('unsupported');
    expect(listAdapters().every((a) => a.sandbox)).toBe(true);      // no real provider adapter exists yet
  });
});
