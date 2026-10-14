import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { makeDb } from './helpers.ts';
import { createServer } from '../http.ts';
import { resetLoginThrottle } from '../auth.ts';
import { cborDecode, finishRegistration, finishAuthentication, registrationOptions, authOptions, listPasskeys, passkeyRequired, setRequired, removePasskey, allowPassphrase } from '../passkey.ts';

// ---- a software "authenticator" (a pretend phone) so the real verification code runs against real signatures ----
const b64u = (b: Buffer) => b.toString('base64url'); const sha = (x: Buffer | string) => crypto.createHash('sha256').update(x).digest();
function cbor(v: any): Buffer {
  const head = (mt: number, n: number) => n < 24 ? Buffer.from([(mt << 5) | n]) : n < 256 ? Buffer.from([(mt << 5) | 24, n]) : Buffer.from([(mt << 5) | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('test cbor');
}
class Phone {
  key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); credId = crypto.randomBytes(32); counter = 0;
  cose() { const j = this.key.publicKey.export({ format: 'jwk' }) as any; return cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, 'base64url')], [-3, Buffer.from(j.y, 'base64url')]])); }
  create(o: { challenge: string; origin: string; rpId: string }, f: { uv?: boolean; up?: boolean; type?: string } = {}) {
    const flags = (f.up === false ? 0 : 1) | (f.uv === false ? 0 : 4) | 0x40; const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credId.length);
    const cnt = Buffer.alloc(4); const authData = Buffer.concat([sha(o.rpId), Buffer.from([flags]), cnt, Buffer.alloc(16), idLen, this.credId, this.cose()]);
    const cd = Buffer.from(JSON.stringify({ type: f.type ?? 'webauthn.create', challenge: o.challenge, origin: o.origin }));
    return { id: b64u(this.credId), response: { clientDataJSON: b64u(cd), attestationObject: b64u(cbor(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))) } };
  }
  get(o: { challenge: string; origin: string; rpId: string }, f: { uv?: boolean; counter?: number; sign?: boolean; type?: string } = {}) {
    this.counter = f.counter ?? this.counter + 1; const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(o.rpId), Buffer.from([1 | (f.uv === false ? 0 : 4)]), cnt]);
    const cd = Buffer.from(JSON.stringify({ type: f.type ?? 'webauthn.get', challenge: o.challenge, origin: o.origin }));
    const sig = crypto.sign('sha256', Buffer.concat([authData, sha(cd)]), this.key.privateKey);
    return { id: b64u(this.credId), response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(f.sign === false ? Buffer.concat([sig.subarray(0, -1), Buffer.from([sig.at(-1)! ^ 1])]) : sig) } };
  }
}
const ctx = { rpId: 'jarvis.tail1234.ts.net', origin: 'https://jarvis.tail1234.ts.net' };
const enroll = (db: any, p: Phone, c = ctx) => { const o = registrationOptions(db, c, 'sess'); return finishRegistration(db, c, 'sess', p.create({ ...c, challenge: o.challenge }), Date.now()); };

test('cbor reader handles what authenticators send and rejects junk', () => {
  assert.deepEqual(cborDecode(cbor(new Map<any, any>([[1, 2], [-1, Buffer.from('ab')], ['k', 'v']]))).value, new Map<any, any>([[1, 2], [-1, Buffer.from('ab')], ['k', 'v']]));
  assert.throws(() => cborDecode(Buffer.from([0x5f]))); assert.throws(() => cborDecode(Buffer.from([0x58, 0xff]))); assert.throws(() => cborDecode(Buffer.alloc(0)));
});

test('registration: a real P-256 passkey is stored by public key; challenge is single-use; every check can fail', () => {
  const db = makeDb(), p = new Phone();
  const o = registrationOptions(db, ctx, 'sess'); assert.deepEqual(o.pubKeyCredParams, [{ type: 'public-key', alg: -7 }]); assert.equal(o.authenticatorSelection.userVerification, 'required'); assert.equal(o.attestation, 'none');
  const good = p.create({ ...ctx, challenge: o.challenge }); const r = finishRegistration(db, ctx, 'sess', { ...good, name: 'My MacBook' }); assert.equal(r.name, 'My MacBook');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM passkeys').all()).includes('PRIVATE'), false); assert.equal(listPasskeys(db).length, 1);
  assert.throws(() => finishRegistration(db, ctx, 'sess', good), /expired or was already used/, 'replay');
  const bad = (f: any, c = ctx, sess = 'sess', ph = new Phone()) => { const op = registrationOptions(db, ctx, 'sess'); return () => finishRegistration(db, ctx, sess, ph.create({ ...c, challenge: op.challenge }, f)); };
  assert.throws(bad({ uv: false }), /user verification/); assert.throws(bad({ up: false }), /presence/); assert.throws(bad({ type: 'webauthn.get' }), /ceremony type/);
  assert.throws(bad({}, { ...ctx, origin: 'https://evil.example' }), /origin/); assert.throws(bad({}, { ...ctx, rpId: 'evil.example' }), /relying party/);
  assert.throws(bad({}, ctx, 'someone-else'), /different session/);
  assert.throws(() => finishRegistration(db, ctx, 'sess', { ...p.create({ ...ctx, challenge: 'made-up-challenge-value' }) }), /expired or was already used/);
  assert.throws(() => enroll(db, p), /already registered/);
  assert.equal(listPasskeys(db).length, 1);
});

test('sign-in: valid signature passes; wrong key, tampering, wrong origin/rp, no UV, replayed challenge and a counter going backwards all fail', () => {
  const db = makeDb(), p = new Phone(); enroll(db, p);
  const login = (f: any = {}, c = ctx, ph = p) => { const o = authOptions(db, ctx, 'login', null); return () => finishAuthentication(db, ctx, 'login', null, ph.get({ ...c, challenge: o.challenge }, f)); };
  assert.deepEqual(login()(), { id: b64u(p.credId) });
  assert.throws(login({ sign: false }), /signature/); assert.throws(login({ uv: false }), /user verification/); assert.throws(login({ type: 'webauthn.create' }), /ceremony/);
  assert.throws(login({}, { ...ctx, origin: 'https://evil.example' }), /origin/); assert.throws(login({}, { ...ctx, rpId: 'evil.example' }), /relying party/);
  const other = new Phone(); other.credId = p.credId; assert.throws(login({}, ctx, other), /signature/, 'same id, different private key');
  const o = authOptions(db, ctx, 'login', null); const a = p.get({ ...ctx, challenge: o.challenge }); finishAuthentication(db, ctx, 'login', null, a); assert.throws(() => finishAuthentication(db, ctx, 'login', null, a), /expired or was already used/);
  assert.throws(login({ counter: 1 }), /cloned/, 'counter rollback');
  assert.throws(() => finishAuthentication(db, ctx, 'login', null, { ...p.get({ ...ctx, challenge: authOptions(db, ctx, 'login', null).challenge }), id: b64u(crypto.randomBytes(32)) }), /unknown passkey/);
  const stepOpt = authOptions(db, ctx, 'stepup', 'sess-A'); assert.throws(() => finishAuthentication(db, ctx, 'stepup', 'sess-B', p.get({ ...ctx, challenge: stepOpt.challenge })), /different session/);
  const loginOpt = authOptions(db, ctx, 'login', null); assert.throws(() => finishAuthentication(db, ctx, 'stepup', null, p.get({ ...ctx, challenge: loginOpt.challenge })), /expired or was already used/, 'a login challenge cannot be used as step-up');
  const phoneZero = new Phone(); const db2 = makeDb(); enroll(db2, phoneZero); const o2 = authOptions(db2, ctx, 'login', null); assert.ok(finishAuthentication(db2, ctx, 'login', null, phoneZero.get({ ...ctx, challenge: o2.challenge }, { counter: 0 })), 'synced passkeys that always report 0 still work');
});

test('challenges expire after two minutes', () => {
  const db = makeDb(), p = new Phone(); enroll(db, p); const t0 = Date.now(); const o = authOptions(db, ctx, 'login', null, t0);
  assert.throws(() => finishAuthentication(db, ctx, 'login', null, p.get({ ...ctx, challenge: o.challenge }), t0 + 3 * 60_000), /expired/);
});

test('require-passkey switch, removal and the command-line way back', () => {
  const db = makeDb(), p = new Phone(); assert.throws(() => setRequired(db, true), /Add a passkey first/); enroll(db, p);
  setRequired(db, true); assert.equal(passkeyRequired(db), true); allowPassphrase(db); assert.equal(passkeyRequired(db), false);
  setRequired(db, true); assert.equal(removePasskey(db, b64u(p.credId)), true); assert.equal(passkeyRequired(db), false, 'removing the last passkey can never lock you out');
});

test('over HTTP: register needs step-up, sign in with a passkey gives a session, and when required the passphrase is refused', async () => {
  resetLoginThrottle(); const { config } = await import('../config.ts');
  const db = makeDb(), allowed: string[] = []; const srv = createServer(db, { webDir: '/nonexistent', allowedHosts: allowed });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port; allowed.push(`localhost:${port}`, `127.0.0.1:${port}`);
  const host = `localhost:${port}`; const c = { rpId: 'localhost', origin: `http://${host}` };
  const rawReq = (host2: string, p: string, method: string, headers: Record<string, string>, body?: string) => new Promise<any>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', host: host2, ...headers } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: { get: (k: string) => { const v = res.headers[k.toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } }, text: async () => text, json: async () => JSON.parse(text), clone() { return this; } }); });
    }); r.on('error', reject); if (body !== undefined) r.write(body); r.end();
  });
  const api = (p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => rawReq(host, p, o.method ?? 'POST', o.headers ?? {}, o.method === 'GET' || o.method === 'DELETE' ? undefined : JSON.stringify(o.body ?? {}));
  void config;
  try {
    const login = await api('/api/login', { body: { passphrase: 'test-pass' } }); const cookie = login.headers.get('set-cookie')!.split(';')[0]; const { csrf } = await login.json() as any; const me = { cookie, 'x-jarvis-csrf': csrf };
    assert.equal((await api('/api/passkeys/register/options', { headers: me })).status, 403, 'needs step-up first');
    await api('/api/stepup', { headers: me, body: { passphrase: 'test-pass' } });
    const p = new Phone(); const opt = await (await api('/api/passkeys/register/options', { headers: me })).json() as any;
    const reg = await api('/api/passkeys/register/verify', { headers: me, body: { ...p.create({ ...c, challenge: opt.challenge }), name: 'Test phone' } }); assert.equal(reg.status, 200);
    assert.equal((await (await api('/api/me', { method: 'GET' })).json() as any).passkeys, 1);
    // sign in with the passkey from a fresh (logged-out) client
    const lo = await (await api('/api/passkeys/login/options')).json() as any; assert.equal(lo.rpId, 'localhost'); assert.equal(lo.userVerification, 'required');
    const lv = await api('/api/passkeys/login/verify', { body: p.get({ ...c, challenge: lo.challenge }) }); assert.equal(lv.status, 200); assert.match(lv.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    const sc = lv.headers.get('set-cookie')!; const s2 = { cookie: sc.split(';')[0], 'x-jarvis-csrf': (await lv.json() as any).csrf }; assert.equal((await api('/api/state', { method: 'GET', headers: s2 })).status, 200);
    // wrong challenge / forged signature → 401 and no session
    const lo2 = await (await api('/api/passkeys/login/options')).json() as any; assert.equal((await api('/api/passkeys/login/verify', { body: p.get({ ...c, challenge: lo2.challenge }, { sign: false }) })).status, 401);
    // step-up with a passkey opens the window
    const so = await (await api('/api/passkeys/stepup/options', { headers: s2 })).json() as any; assert.equal((await api('/api/passkeys/stepup/verify', { headers: s2, body: p.get({ ...c, challenge: so.challenge }) })).status, 200);
    assert.equal((await (await api('/api/me', { method: 'GET', headers: s2 })).json() as any).stepUp, true);
    // require passkey → passphrase refused with a recovery hint
    assert.equal((await api('/api/passkeys/require', { method: 'PUT', headers: s2, body: { required: true } })).status, 200);
    resetLoginThrottle(); const refused = await api('/api/login', { body: { passphrase: 'test-pass' } }); assert.equal(refused.status, 403); assert.match((await refused.json() as any).error, /allow-passphrase/);
    assert.equal((await (await api('/api/me', { method: 'GET' })).json() as any).passkeyRequired, true);
    // numeric addresses cannot do passkeys; the message says how to fix it
    const numeric = await rawReq(`127.0.0.1:${port}`, '/api/passkeys/login/options', 'POST', {}, '{}'); assert.equal(numeric.status, 400); assert.match((await numeric.json() as any).error, /localhost/);
  } finally { await new Promise((r) => srv.close(r)); }
});
