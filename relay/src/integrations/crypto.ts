import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// Dev/test fallback key is deliberately NON-SECRET and refused in production.
const DEV_KEY_HEX = '07'.repeat(32);

function keyring(): Map<number, Buffer> {
  const m = new Map<number, Buffer>();
  if (config.credentialKeysJson) { for (const [v, hex] of Object.entries(JSON.parse(config.credentialKeysJson) as Record<string, string>)) m.set(Number(v), Buffer.from(hex, 'hex')); }
  else if (config.credentialKeyHex) m.set(1, Buffer.from(config.credentialKeyHex, 'hex'));
  else if (config.env !== 'production') m.set(1, Buffer.from(DEV_KEY_HEX, 'hex'));
  for (const [v, k] of m) if (k.length !== 32) throw new Error(`credential key v${v} must be 32 bytes (64 hex chars)`);
  if (!m.size) throw new Error('CREDENTIAL_KEY_HEX / CREDENTIAL_KEYS is required in production to store integration credentials');
  return m;
}
export const activeKeyVersion = () => { const k = keyring(); const v = k.has(config.credentialKeyActive) ? config.credentialKeyActive : Math.max(...k.keys()); return v; };

/** AES-256-GCM. `aad` binds the ciphertext to its owning row so it cannot be swapped between rows. Envelope: v<keyver>.<iv>.<tag>.<ct> (base64url). */
export function encryptJson(value: unknown, aad: string): { enc: string; keyVersion: number } {
  const keyVersion = activeKeyVersion(); const key = keyring().get(keyVersion)!; const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { enc: ['v' + keyVersion, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.'), keyVersion };
}
export function decryptJson<T = any>(enc: string, aad: string): T {
  const [v, iv, tag, ct] = enc.split('.'); const key = keyring().get(Number(v.slice(1)));
  if (!key) throw new Error(`no key available for ${v} (was it removed before rotation finished?)`);
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); d.setAAD(Buffer.from(aad)); d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
}
/** Re-encrypt under the active key (key rotation). Returns null when already current. */
export function rotate(enc: string, aad: string): { enc: string; keyVersion: number } | null {
  if (Number(enc.split('.')[0].slice(1)) === activeKeyVersion()) return null;
  return encryptJson(decryptJson(enc, aad), aad);
}

/** Remove any known secret values from text before it is stored or logged. */
export function maskSecrets(text: string, creds: unknown): string {
  const secrets: string[] = [];
  const walk = (v: unknown) => { if (typeof v === 'string' && v.length >= 6) secrets.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  walk(creds);
  let out = text; for (const s of secrets.sort((a, b) => b.length - a.length)) out = out.split(s).join('***');
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***').slice(0, 2000);
}
