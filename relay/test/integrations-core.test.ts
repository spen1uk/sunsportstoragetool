import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { decryptJson, encryptJson, maskSecrets, rotate, activeKeyVersion } from '../src/integrations/crypto.js';
import { sign, verify } from '../src/integrations/signing.js';
import { isBlockedIp, parseSafeUrl, assertSafeUrl, safeRequest, UnsafeUrlError } from '../src/integrations/ssrf.js';
import { config } from '../src/config.js';

describe('credential encryption', () => {
  it('round-trips, never stores plaintext, is randomized, and is bound to its row (aad)', () => {
    const secret = { apiKey: 'sk_live_SUPERSECRET123', webhookSecret: 'whsec_abcdef' };
    const a = encryptJson(secret, 'row-1'); const b = encryptJson(secret, 'row-1');
    expect(a.enc).not.toContain('SUPERSECRET'); expect(a.enc).not.toBe(b.enc); expect(decryptJson(a.enc, 'row-1')).toEqual(secret);
    expect(() => decryptJson(a.enc, 'row-2')).toThrow();                                            // ciphertext cannot be moved to another row
    const tampered = a.enc.slice(0, -3) + (a.enc.endsWith('AAA') ? 'BBB' : 'AAA'); expect(() => decryptJson(tampered, 'row-1')).toThrow();
  });
  it('rotates to the active key version and keeps old ciphertext readable until rotated', () => {
    const saved = [config.credentialKeysJson, config.credentialKeyActive] as const;
    try {
      config.credentialKeysJson = JSON.stringify({ 1: '07'.repeat(32), 2: '09'.repeat(32) }); config.credentialKeyActive = 1;
      const old = encryptJson({ t: 'x' }, 'r'); expect(old.keyVersion).toBe(1); expect(rotate(old.enc, 'r')).toBeNull();
      config.credentialKeyActive = 2; expect(activeKeyVersion()).toBe(2); expect(decryptJson(old.enc, 'r')).toEqual({ t: 'x' });
      const r = rotate(old.enc, 'r')!; expect(r.keyVersion).toBe(2); expect(r.enc.startsWith('v2.')).toBe(true); expect(decryptJson(r.enc, 'r')).toEqual({ t: 'x' });
      config.credentialKeysJson = JSON.stringify({ 2: '09'.repeat(32) }); expect(() => decryptJson(old.enc, 'r')).toThrow(/no key available for v1/);
    } finally { config.credentialKeysJson = saved[0]; config.credentialKeyActive = saved[1]; }
  });
  it('refuses weak keys and production without a key; masks secrets in text', () => {
    const saved = [config.credentialKeysJson, config.env] as const;
    try { config.credentialKeysJson = JSON.stringify({ 1: 'abcd' }); expect(() => encryptJson({}, 'r')).toThrow(/32 bytes/);
      config.credentialKeysJson = ''; config.env = 'production'; expect(() => encryptJson({}, 'r')).toThrow(/required in production/); } finally { config.credentialKeysJson = saved[0]; config.env = saved[1]; }
    expect(maskSecrets('failed with key sk_live_SUPERSECRET123 and Bearer abcdefghijklmnop', { apiKey: 'sk_live_SUPERSECRET123' })).toBe('failed with key *** and Bearer ***');
  });
});

describe('timestamped HMAC signatures (Stripe-documented scheme)', () => {
  const body = '{"id":"evt_1"}'; const now = 1_800_000_000_000;
  it('accepts valid, rejects tampered body, wrong secret, missing/malformed, and stale/future timestamps', () => {
    const h = sign('whsec_x', now / 1000, body);
    expect(() => verify('whsec_x', h, body, { now })).not.toThrow();
    expect(() => verify('whsec_x', h, body + ' ', { now })).toThrow(/bad signature/); expect(() => verify('other', h, body, { now })).toThrow(/bad signature/);
    expect(() => verify('whsec_x', undefined, body, { now })).toThrow(/missing/); expect(() => verify('whsec_x', 'garbage', body, { now })).toThrow(/malformed/);
    expect(() => verify('whsec_x', h, body, { now: now + 301_000 })).toThrow(/stale/); expect(() => verify('whsec_x', h, body, { now: now - 301_000 })).toThrow(/stale/);
    expect(() => verify('whsec_x', h, body, { now: now + 299_000 })).not.toThrow();
  });
  it('supports secret rollover (multiple v1) and ignores other schemes; tolerance 0 disables the recency check', () => {
    const t = now / 1000; const good = sign('new', t, body).split('v1=')[1];
    expect(() => verify('new', `t=${t},v1=${'0'.repeat(64)},v1=${good},v0=ignored`, body, { now })).not.toThrow();
    expect(() => verify('new', sign('new', t - 99999, body), body, { now, toleranceSeconds: 0 })).not.toThrow();
  });
});

describe('SSRF guard', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '2001:db8::1',
  ])('blocks non-public address %s', (ip) => { expect(isBlockedIp(ip)).toBe(true); });
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public address %s', (ip) => { expect(isBlockedIp(ip)).toBe(false); });
  it.each([
    ['http://example.com/hook', /https/], ['ftp://example.com/', /https/], ['file:///etc/passwd', /https/], ['javascript:alert(1)', /https|valid/],
    ['https://user:pw@example.com/', /credentials/], ['https://example.com:8443/', /port/], ['https://example.com:22/', /port/],
    ['https://localhost/', /internal/], ['https://app.localhost/', /internal/], ['https://db.internal/', /internal/], ['https://printer.local/', /internal/], ['https://intranet/', /internal/],
    ['https://127.0.0.1/', /not public/], ['https://[::1]/', /not public/], ['https://2130706433/', /not public/], ['https://0x7f.1/', /not public/], ['https://017700000001/', /not public/], ['https://169.254.169.254/latest/meta-data/', /not public/],
    ['https://[::ffff:127.0.0.1]/', /not public/], ['https://example.com@127.0.0.1/', /credentials|not public/], ['not a url', /valid/],
  ])('rejects %s', (url, why) => { expect(() => parseSafeUrl(url)).toThrow(why as RegExp); });
  it('rejects names that RESOLVE to private addresses (incl. one bad record among good ones) and unresolvable names; allows public', async () => {
    await expect(assertSafeUrl('https://evil.example/', async () => ['10.0.0.8'])).rejects.toThrow(/non-public/);
    await expect(assertSafeUrl('https://evil.example/', async () => ['8.8.8.8', '127.0.0.1'])).rejects.toThrow(/non-public/);
    await expect(assertSafeUrl('https://evil.example/', async () => ['::ffff:169.254.169.254'])).rejects.toThrow(/non-public/);
    await expect(assertSafeUrl('https://nx.example/', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow(/did not resolve/);
    await expect(assertSafeUrl('https://ok.example/hook', async () => ['93.184.216.34'])).resolves.toMatchObject({ addresses: ['93.184.216.34'] });
  });
  it('safeRequest pins the validated address (rebinding-proof) and caps behaviour; blocked destinations never reach the transport', async () => {
    let seen: string | undefined;
    const ok = await safeRequest('https://ok.example/hook', { resolve: async () => ['93.184.216.34'], body: '{}', transport: async (_u, addr) => { seen = addr; return { status: 204, body: '', headers: {} }; } });
    expect(ok.status).toBe(204); expect(seen).toBe('93.184.216.34');
    let called = false; await expect(safeRequest('https://evil.example/', { resolve: async () => ['192.168.0.9'], transport: async () => { called = true; return { status: 200, body: '', headers: {} }; } })).rejects.toBeInstanceOf(UnsafeUrlError); expect(called).toBe(false);
  });
  it('REAL transport path: a server on loopback is unreachable through safeRequest', async () => {
    let hits = 0; const srv = createServer((_q, r) => { hits++; r.end('secret-internal'); }); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await expect(safeRequest(`https://127.0.0.1:${port}/`)).rejects.toThrow(/port|not public/); await expect(safeRequest('https://127.0.0.1/')).rejects.toThrow(/not public/); await expect(safeRequest('https://localhost/')).rejects.toThrow(/internal/);
    expect(hits).toBe(0); srv.close();
  });
});
