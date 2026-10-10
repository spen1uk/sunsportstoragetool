import crypto from 'node:crypto';
import { type DB, getMeta, setMeta, sha256, now } from './db.ts';
import { config } from './config.ts';
import { audit } from './audit.ts';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function hashPassphrase(pass: string): string {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pass, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verifyPassphrase(db: DB, pass: string): boolean {
  const stored = getMeta(db, 'owner_hash');
  if (!stored) return false;
  const [, saltHex, hashHex] = stored.split('$');
  const h = crypto.scryptSync(pass, Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  return crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}
export function setPassphrase(db: DB, pass: string) { setMeta(db, 'owner_hash', hashPassphrase(pass)); }
export const isConfigured = (db: DB) => !!getMeta(db, 'owner_hash');

export type Session = { csrf: string; stepUpUntil: number; tokenHash: string };

// Login throttling (in-memory, per process): 5 failures → 60s lockout, doubling.
const fails = { n: 0, lockedUntil: 0 };

export function login(db: DB, pass: string): { token: string; csrf: string } | { error: string; retryAfterMs?: number } {
  if (Date.now() < fails.lockedUntil) return { error: 'Too many attempts', retryAfterMs: fails.lockedUntil - Date.now() };
  if (!verifyPassphrase(db, pass)) {
    fails.n++;
    if (fails.n >= 5) fails.lockedUntil = Date.now() + 60_000 * 2 ** Math.min(fails.n - 5, 6);
    audit(db, 'unknown', 'auth.login_failed');
    return { error: 'Invalid credentials' };
  }
  fails.n = 0;
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,csrf,created_at,expires_at) VALUES(?,?,?,?)')
    .run(sha256(token), csrf, Date.now(), Date.now() + config.sessionTtlMs);
  audit(db, 'luke', 'auth.login');
  return { token, csrf };
}

export function getSession(db: DB, token: string | undefined): Session | null {
  if (!token) return null;
  const r = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha256(token)) as any;
  if (!r) return null;
  if (r.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(r.token_hash); return null; }
  return { csrf: r.csrf, stepUpUntil: r.step_up_until, tokenHash: r.token_hash };
}
export function logout(db: DB, token: string) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token)); }

/** Step-up: re-verify the passphrase to authorise high-risk approvals for a short window. */
export function stepUp(db: DB, s: Session, pass: string): boolean {
  if (!verifyPassphrase(db, pass)) { audit(db, 'luke', 'auth.stepup_failed'); return false; }
  db.prepare('UPDATE sessions SET step_up_until=? WHERE token_hash=?').run(Date.now() + config.stepUpTtlMs, s.tokenHash);
  audit(db, 'luke', 'auth.stepup');
  return true;
}
export const hasStepUp = (s: Session) => s.stepUpUntil > Date.now();
void now;
