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

// Wrong-passphrase handling. We deliberately do NOT lock the owner out: behind a private proxy every request looks alike, so a lockout
// would let anyone who can reach the server lock Luke out. The passphrase is 160 random bits (not guessable), so instead each recent
// failure slows every attempt a little (up to 2 s) and scrypt itself caps the guess rate; the correct passphrase always works.
const fails = { n: 0, last: 0 };
/** Tests only: clear the in-memory failure counter. */
export const resetLoginThrottle = () => { fails.n = 0; fails.last = 0; };
/** How long to pause before checking a passphrase, given recent failures (resets after a quiet minute). */
export function failureDelayMs(now = Date.now()) { if (now - fails.last > 60_000) fails.n = 0; return fails.n < 3 ? 0 : Math.min(2000, 100 * 2 ** (fails.n - 3)); }
const noteFail = () => { fails.n++; fails.last = Date.now(); };

export function login(db: DB, pass: string): { token: string; csrf: string } | { error: string } {
  if (!verifyPassphrase(db, pass)) { noteFail(); audit(db, 'unknown', 'auth.login_failed'); return { error: 'Invalid credentials' }; }
  fails.n = 0;
  const s = startSession(db); audit(db, 'luke', 'auth.login');
  return s;
}

/** Create a signed-in session (used after the passphrase or a passkey has proven it is Luke). */
export function startSession(db: DB): { token: string; csrf: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,csrf,created_at,expires_at) VALUES(?,?,?,?)')
    .run(sha256(token), csrf, Date.now(), Date.now() + config.sessionTtlMs);
  return { token, csrf };
}
/** Open the step-up window after a passkey (with user verification) approved this action. */
export function grantStepUp(db: DB, s: Session) {
  db.prepare('UPDATE sessions SET step_up_until=? WHERE token_hash=?').run(Date.now() + config.stepUpTtlMs, s.tokenHash);
  audit(db, 'luke', 'auth.stepup', '', { via: 'passkey' });
}
/** A step-up pays for ONE protected action. Spending it means a stolen session cookie cannot ride a recent confirmation. */
export function consumeStepUp(db: DB, s: Session) { db.prepare('UPDATE sessions SET step_up_until=0 WHERE token_hash=?').run(s.tokenHash); s.stepUpUntil = 0; }

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
  if (!verifyPassphrase(db, pass)) { noteFail(); audit(db, 'luke', 'auth.stepup_failed'); return false; }
  db.prepare('UPDATE sessions SET step_up_until=? WHERE token_hash=?').run(Date.now() + config.stepUpTtlMs, s.tokenHash);
  audit(db, 'luke', 'auth.stepup');
  return true;
}
export const hasStepUp = (s: Session) => s.stepUpUntil > Date.now();
void now;
