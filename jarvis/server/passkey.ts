import crypto from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.ts';
import { getMeta, setMeta, id } from './db.ts';
import { audit } from './audit.ts';

/**
 * Passkey (WebAuthn) support, written to be small enough to audit in one sitting.
 *  - Algorithm: ES256 (ECDSA P-256 / SHA-256) only. We ask the browser for nothing else, and refuse anything else.
 *  - Attestation: not requested and ignored ("none"). We only need the public key, which we store; private keys never leave the device.
 *  - Every sign-in/approval needs USER VERIFICATION (Face ID / Touch ID / device PIN), not just a tap.
 *  - Challenges are random, single-use, expire in 2 minutes, and (for registration/step-up) are tied to the signed-in session.
 *  - The origin and relying-party id are derived from the already-validated Host header, so a key made for one address never works on another.
 *  - A signature counter that goes backwards (when counters are in use) is treated as a cloned key and refused.
 * This is custom code on a security boundary: it is on the list for the independent security review (docs/DEPLOY.md).
 */
const TTL = 2 * 60_000, FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const unb64u = (s: string) => Buffer.from(s, 'base64url');
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();

// ---- a minimal CBOR reader: just what WebAuthn uses (ints, byte/text strings, arrays, maps, booleans, null) ----
export function cborDecode(buf: Buffer, start = 0): { value: any; end: number } {
  let i = start;
  const item = (depth: number): any => {
    if (depth > 8) throw new Error('cbor too deep');
    if (i >= buf.length) throw new Error('cbor truncated');
    const ib = buf[i++], mt = ib >> 5, ai = ib & 31; let n: number;
    if (ai < 24) n = ai;
    else if (ai === 24) { n = buf[i]; i += 1; }
    else if (ai === 25) { n = buf.readUInt16BE(i); i += 2; }
    else if (ai === 26) { n = buf.readUInt32BE(i); i += 4; }
    else if (mt === 7) n = ai;
    else throw new Error('cbor unsupported length');
    if (n > buf.length * 8 && mt !== 7) throw new Error('cbor length');
    switch (mt) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { if (i + n > buf.length) throw new Error('cbor truncated'); const v = buf.subarray(i, i + n); i += n; return Buffer.from(v); }
      case 3: { if (i + n > buf.length) throw new Error('cbor truncated'); const v = buf.toString('utf8', i, i + n); i += n; return v; }
      case 4: { if (n > 64) throw new Error('cbor array'); const a = []; for (let k = 0; k < n; k++) a.push(item(depth + 1)); return a; }
      case 5: { if (n > 64) throw new Error('cbor map'); const m = new Map(); for (let k = 0; k < n; k++) { const key = item(depth + 1); m.set(key, item(depth + 1)); } return m; }
      case 7: if (n === 20) return false; if (n === 21) return true; if (n === 22 || n === 23) return null; throw new Error('cbor simple');
      default: throw new Error('cbor unsupported type');
    }
  };
  const value = item(0); return { value, end: i };
}

type Ctx = { rpId: string; origin: string };
const clientDataOf = (raw: Buffer, type: string, challenge: string, ctx: Ctx) => {
  let cd: any; try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('bad client data'); }
  if (cd.type !== type) throw new Error('wrong ceremony type');
  if (typeof cd.challenge !== 'string' || !timingEq(cd.challenge, challenge)) throw new Error('challenge mismatch');
  if (cd.origin !== ctx.origin) throw new Error('origin mismatch');
  if (cd.crossOrigin === true) throw new Error('cross-origin ceremony refused');
};
const timingEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function parseAuthData(ad: Buffer, ctx: Ctx) {
  if (ad.length < 37) throw new Error('short authenticator data');
  if (!ad.subarray(0, 32).equals(sha256(ctx.rpId))) throw new Error('wrong relying party');
  const flags = ad[32], signCount = ad.readUInt32BE(33);
  if (!(flags & FLAG_UP)) throw new Error('user presence missing');
  if (!(flags & FLAG_UV)) throw new Error('user verification missing (Face ID / Touch ID / PIN is required)');
  return { flags, signCount };
}

// ---- challenges ----
export function newChallenge(db: DB, purpose: 'register' | 'login' | 'stepup', sessionHash: string | null, now = Date.now()): string {
  db.prepare('DELETE FROM passkey_challenges WHERE created_at<?').run(now - TTL);
  const ch = b64u(crypto.randomBytes(32));
  db.prepare('INSERT INTO passkey_challenges(id,challenge,purpose,session_hash,created_at) VALUES(?,?,?,?,?)').run(id(), ch, purpose, sessionHash, now);
  return ch;
}
/** Single use: the challenge is deleted the moment it is looked up, pass or fail. */
function takeChallenge(db: DB, challenge: string, purpose: string, sessionHash: string | null, now: number) {
  const r = db.prepare('SELECT id, session_hash, created_at FROM passkey_challenges WHERE challenge=? AND purpose=?').get(challenge, purpose) as { id: string; session_hash: string | null; created_at: number } | undefined;
  if (r) db.prepare('DELETE FROM passkey_challenges WHERE id=?').run(r.id);
  if (!r || now - r.created_at > TTL) throw new Error('that sign-in request expired or was already used');
  if (r.session_hash !== sessionHash) throw new Error('that request belongs to a different session');
}

// ---- registration ----
export const registrationOptions = (db: DB, ctx: Ctx, sessionHash: string, now = Date.now()) => ({
  challenge: newChallenge(db, 'register', sessionHash, now),
  rp: { id: ctx.rpId, name: 'Jarvis' },
  user: { id: b64u(sha256('jarvis-owner')), name: 'luke', displayName: 'Luke' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  attestation: 'none', timeout: 120_000,
  excludeCredentials: listPasskeys(db).map((p) => ({ type: 'public-key', id: p.id })),
});
const regBody = z.object({ id: z.string().min(8).max(1400), name: z.string().max(40).optional(), transports: z.array(z.string().max(20)).max(6).optional(), response: z.object({ clientDataJSON: z.string().max(4000), attestationObject: z.string().max(20000) }) });
export function finishRegistration(db: DB, ctx: Ctx, sessionHash: string, body: unknown, now = Date.now()) {
  const b = regBody.parse(body), clientData = unb64u(b.response.clientDataJSON);
  let cd: any; try { cd = JSON.parse(clientData.toString('utf8')); } catch { throw new Error('bad client data'); }
  takeChallenge(db, String(cd.challenge), 'register', sessionHash, now);
  clientDataOf(clientData, 'webauthn.create', cd.challenge, ctx);
  const att = cborDecode(unb64u(b.response.attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('bad attestation object');
  const ad = att.get('authData') as Buffer, { flags, signCount } = parseAuthData(ad, ctx);
  if (!(flags & FLAG_AT)) throw new Error('no credential in response');
  const idLen = ad.readUInt16BE(53); if (idLen < 16 || idLen > 1023 || ad.length < 55 + idLen) throw new Error('bad credential id');
  const credId = ad.subarray(55, 55 + idLen), cose = cborDecode(ad, 55 + idLen).value;
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1) throw new Error('only ES256 (P-256) passkeys are supported');
  const x = cose.get(-2), y = cose.get(-3); if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('bad public key');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }, format: 'jwk' });
  const credB64 = b64u(credId); if (credB64 !== b.id) throw new Error('credential id mismatch');
  if (db.prepare('SELECT 1 FROM passkeys WHERE id=?').get(credB64)) throw new Error('that passkey is already registered');
  if ((db.prepare('SELECT COUNT(*) c FROM passkeys').get() as any).c >= 10) throw new Error('You can keep up to 10 passkeys. Remove one first.');
  const name = (b.name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'Passkey';
  db.prepare('INSERT INTO passkeys(id,name,public_key,sign_count,transports,created_at) VALUES(?,?,?,?,?,?)').run(credB64, name, key.export({ type: 'spki', format: 'der' }).toString('base64'), signCount, (b.transports ?? []).join(','), now);
  audit(db, 'luke', 'passkey.registered', credB64.slice(0, 8)); return { id: credB64, name };
}

// ---- authentication (sign in, or step-up) ----
export const authOptions = (db: DB, ctx: Ctx, purpose: 'login' | 'stepup', sessionHash: string | null, now = Date.now()) => ({
  challenge: newChallenge(db, purpose, sessionHash, now), rpId: ctx.rpId, userVerification: 'required', timeout: 120_000,
  allowCredentials: listPasskeys(db).map((p) => ({ type: 'public-key', id: p.id })),
});
const authBody = z.object({ id: z.string().min(8).max(1400), response: z.object({ clientDataJSON: z.string().max(4000), authenticatorData: z.string().max(4000), signature: z.string().max(1000) }) });
export function finishAuthentication(db: DB, ctx: Ctx, purpose: 'login' | 'stepup', sessionHash: string | null, body: unknown, now = Date.now()) {
  const b = authBody.parse(body), clientData = unb64u(b.response.clientDataJSON);
  let cd: any; try { cd = JSON.parse(clientData.toString('utf8')); } catch { throw new Error('bad client data'); }
  takeChallenge(db, String(cd.challenge), purpose, sessionHash, now);
  clientDataOf(clientData, 'webauthn.get', cd.challenge, ctx);
  const row = db.prepare('SELECT * FROM passkeys WHERE id=?').get(b.id) as { id: string; public_key: string; sign_count: number } | undefined;
  if (!row) throw new Error('unknown passkey');
  const ad = unb64u(b.response.authenticatorData), { signCount } = parseAuthData(ad, ctx);
  const key = crypto.createPublicKey({ key: Buffer.from(row.public_key, 'base64'), format: 'der', type: 'spki' });
  const ok = crypto.verify('sha256', Buffer.concat([ad, sha256(clientData)]), key, unb64u(b.response.signature));
  if (!ok) throw new Error('signature check failed');
  if ((signCount > 0 || row.sign_count > 0) && signCount <= row.sign_count) { audit(db, 'system', 'passkey.counter_rollback', row.id.slice(0, 8)); throw new Error('this passkey looks cloned (its counter went backwards)'); }
  db.prepare('UPDATE passkeys SET sign_count=?, last_used_at=? WHERE id=?').run(signCount, now, row.id);
  return { id: row.id };
}

// ---- management ----
export const listPasskeys = (db: DB) => (db.prepare('SELECT id, name, created_at, last_used_at FROM passkeys ORDER BY created_at').all() as { id: string; name: string; created_at: number; last_used_at: number | null }[]);
export const passkeyRequired = (db: DB) => getMeta(db, 'passkey_required') === '1' && listPasskeys(db).length > 0;
export function setRequired(db: DB, on: boolean) {
  if (on && !listPasskeys(db).length) throw new Error('Add a passkey first.');
  setMeta(db, 'passkey_required', on ? '1' : '0'); audit(db, 'luke', 'passkey.require', '', { on });
}
export function removePasskey(db: DB, pid: string) {
  const r = db.prepare('DELETE FROM passkeys WHERE id=?').run(pid);
  if (r.changes) { audit(db, 'luke', 'passkey.removed', pid.slice(0, 8)); if (!listPasskeys(db).length) setMeta(db, 'passkey_required', '0'); }
  return r.changes > 0;
}
/** Recovery from the command line on the machine itself (see setup.ts): allow the passphrase again. */
export function allowPassphrase(db: DB) { setMeta(db, 'passkey_required', '0'); audit(db, 'luke', 'passkey.require', '', { on: false, via: 'cli' }); }
