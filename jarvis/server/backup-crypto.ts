import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Encrypted backups. The server only ever holds a PUBLIC key, so a stolen server or a stolen backup file cannot decrypt old backups;
 * only the recovery key (kept by Luke, in a password manager) can.
 *   file = "JVBK1\n" | ephemeral X25519 public key (32) | HKDF salt (16) | AES-GCM iv (12) | ciphertext | GCM tag (16)
 *   key  = HKDF-SHA256( X25519(ephemeral private, recipient public), salt, "jarvis-backup-v1" )
 * The whole header is authenticated (GCM additional data), so any change to it, the ciphertext or the length is detected on restore.
 * Every backup uses a fresh ephemeral key, so no key/iv pair is ever reused.
 */
const MAGIC = Buffer.from('JVBK1\n'), HEADER = MAGIC.length + 32 + 16 + 12, TAG = 16;
const b64u = (b: Buffer) => b.toString('base64url');

export function generateRecoveryKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const d = Buffer.from((privateKey.export({ format: 'jwk' }) as any).d, 'base64url'), x = Buffer.from((publicKey.export({ format: 'jwk' }) as any).x, 'base64url');
  return { recoveryKey: 'jvk1_' + b64u(Buffer.concat([d, x])), publicKey: b64u(x) };
}
const pub = (xB64u: string) => { const x = Buffer.from(xB64u, 'base64url'); if (x.length !== 32) throw new Error('That is not a backup public key.'); return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(x) }, format: 'jwk' }); };
function priv(recovery: string) {
  const m = /^jvk1_([A-Za-z0-9_-]{86})$/.exec(recovery.trim()); if (!m) throw new Error('That does not look like a Jarvis recovery key (it starts with jvk1_).');
  const raw = Buffer.from(m[1], 'base64url'); if (raw.length !== 64) throw new Error('That recovery key is the wrong length.');
  return crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64u(raw.subarray(0, 32)), x: b64u(raw.subarray(32)) }, format: 'jwk' });
}
const derive = (shared: Buffer, salt: Buffer) => Buffer.from(crypto.hkdfSync('sha256', shared, salt, 'jarvis-backup-v1', 32));

export async function encryptFile(src: string, dest: string, publicKeyB64u: string) {
  const eph = crypto.generateKeyPairSync('x25519'), epub = Buffer.from((eph.publicKey.export({ format: 'jwk' }) as any).x, 'base64url');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = derive(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub(publicKeyB64u) }), salt);
  const header = Buffer.concat([MAGIC, epub, salt, iv]);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(header);
  const out = fs.createWriteStream(dest, { mode: 0o600, flags: 'wx' });
  out.write(header);
  try { await pipeline(fs.createReadStream(src), c, out, { end: false }); out.write(c.getAuthTag()); await new Promise<void>((res, rej) => out.end((e: Error | null | undefined) => (e ? rej(e) : res()))); }
  catch (e) { out.destroy(); fs.rmSync(dest, { force: true }); throw e; }
  fs.chmodSync(dest, 0o600); return { bytes: fs.statSync(dest).size };
}

/** Decrypt to `dest`. Writes nothing usable on failure: wrong key, damage, truncation and tampering all raise the same plain error. */
export async function decryptFile(src: string, dest: string, recoveryKey: string) {
  const fail = () => new Error('Could not decrypt this backup: wrong recovery key, or the file is damaged or has been changed.');
  const key0 = priv(recoveryKey); const size = fs.statSync(src).size; if (size < HEADER + TAG) throw fail();
  const fd = fs.openSync(src, 'r'); const header = Buffer.alloc(HEADER), tag = Buffer.alloc(TAG);
  try { fs.readSync(fd, header, 0, HEADER, 0); fs.readSync(fd, tag, 0, TAG, size - TAG); } finally { fs.closeSync(fd); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not a Jarvis backup file.');
  const epub = header.subarray(MAGIC.length, MAGIC.length + 32), salt = header.subarray(MAGIC.length + 32, MAGIC.length + 48), iv = header.subarray(MAGIC.length + 48);
  const key = derive(crypto.diffieHellman({ privateKey: key0, publicKey: pub(b64u(epub)) }), salt);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAAD(header); d.setAuthTag(tag);
  const out = fs.createWriteStream(dest, { mode: 0o600, flags: 'wx' });
  try { await pipeline(fs.createReadStream(src, { start: HEADER, end: size - TAG - 1 }), d, out); }
  catch { out.destroy(); fs.rmSync(dest, { force: true }); throw fail(); }
  fs.chmodSync(dest, 0o600);
}
