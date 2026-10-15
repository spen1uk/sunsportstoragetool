import { deviceSpend } from './llm/gateway.ts';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.ts';
import { id } from './db.ts';
import { audit } from './audit.ts';

/**
 * Device registry. A "device" is any client other than the signed-in browser: a phone app, the car, a text/voice gateway.
 * Each gets its own credential that can do only what its SCOPES allow, can be revoked at any time, expires, and is stored only as a hash.
 * There is deliberately NO scope for approving anything, changing settings, or managing devices: those need Luke at the dashboard
 * with a passkey/passphrase. The list of scopes below is the whole vocabulary; nothing else can be granted.
 */
export const SCOPES = ['chat', 'greeting', 'glance'] as const;
export type Scope = (typeof SCOPES)[number];
export const KINDS = ['phone', 'car', 'sms', 'voice', 'tablet', 'other'] as const;
export const DEFAULT_SCOPES: Record<(typeof KINDS)[number], Scope[]> = { phone: ['chat', 'greeting', 'glance'], car: ['chat', 'greeting', 'glance'], sms: ['chat'], voice: ['chat', 'greeting'], tablet: ['chat', 'greeting', 'glance'], other: ['glance'] };
export const DEFAULT_LIMIT_USD = 10;
const MAX_DEVICES = 8, TTL = 365 * 86_400_000;
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export const createInput = z.object({ name: z.string().min(1).max(40), kind: z.enum(KINDS), profile: z.enum(['glance', 'full']).optional(), scopes: z.array(z.enum(SCOPES)).min(1).optional(), monthlyLimitUsd: z.number().min(0.5).max(50).optional() }).strict();

export function createDevice(db: DB, raw: unknown, now = Date.now()) {
  const i = createInput.parse(raw), name = i.name.replace(/[\u0000-\u001f]/g, ' ').trim(); if (!name) throw new Error('A device needs a name.');
  if ((db.prepare('SELECT COUNT(*) c FROM devices WHERE revoked_at IS NULL AND expires_at>?').get(now) as any).c >= MAX_DEVICES) throw new Error(`You can have up to ${MAX_DEVICES} devices. Revoke one first.`);
  const token = 'jvd_' + crypto.randomBytes(32).toString('base64url'), scopes = [...new Set(i.scopes ?? DEFAULT_SCOPES[i.kind])], did = id();
  db.prepare('INSERT INTO devices(id,name,kind,token_hash,scopes,profile,created_at,expires_at,monthly_limit_micro_usd) VALUES(?,?,?,?,?,?,?,?,?)').run(did, name, i.kind, sha(token), JSON.stringify(scopes), i.profile ?? (i.kind === 'car' ? 'glance' : 'full'), now, now + TTL, Math.round((i.monthlyLimitUsd ?? DEFAULT_LIMIT_USD) * 1e6));
  audit(db, 'luke', 'device.created', did, { kind: i.kind, scopes }); return { id: did, token };
}
export const listDevices = (db: DB, now = Date.now()) => (db.prepare('SELECT id,name,kind,scopes,profile,created_at,expires_at,last_seen_at,revoked_at,monthly_limit_micro_usd FROM devices ORDER BY created_at DESC').all() as any[])
  .map((d) => ({ id: d.id, name: d.name, kind: d.kind, scopes: JSON.parse(d.scopes) as Scope[], profile: d.profile as 'glance' | 'full', createdAt: d.created_at, expiresAt: d.expires_at, lastSeen: d.last_seen_at, monthlyLimitMicroUsd: d.monthly_limit_micro_usd as number, spentMicroUsd: deviceSpend(db, d.id, now), status: d.revoked_at ? 'revoked' : d.expires_at <= now ? 'expired' : 'active' }));
export function revokeDevice(db: DB, did: string, now = Date.now()) { const r = db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, did); if (r.changes) audit(db, 'luke', 'device.revoked', did); return r.changes > 0; }

export type Device = { id: string; name: string; kind: (typeof KINDS)[number]; scopes: Scope[]; profile: 'glance' | 'full'; lastSeen: number | null; monthlyLimitMicroUsd: number };
/** Check an Authorization header. A wrong or revoked or expired credential is simply refused; there is no lockout (a lockout would let anyone on the network cut a real device off). */
export function authenticate(db: DB, header: string | undefined, need: Scope | null, now = Date.now(), touch = true): { ok: true; device: Device } | { ok: false; status: number; error: string } {
  const m = /^Bearer (jvd_[A-Za-z0-9_-]{20,100})$/.exec(header ?? ''); if (!m) return { ok: false, status: 401, error: 'invalid device credential' };
  const r = db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').get(sha(m[1]), now) as any;
  if (!r) return { ok: false, status: 401, error: 'invalid device credential' };
  const device: Device = { id: r.id, name: r.name, kind: r.kind, scopes: JSON.parse(r.scopes), profile: r.profile, lastSeen: r.last_seen_at, monthlyLimitMicroUsd: r.monthly_limit_micro_usd };
  if (need && !device.scopes.includes(need)) return { ok: false, status: 403, error: `this device is not allowed to do that (needs "${need}")` };
  if (touch) db.prepare('UPDATE devices SET last_seen_at=? WHERE id=?').run(now, r.id); return { ok: true, device };
}

// Per-device request budget (in memory): a runaway or stolen device cannot hammer the model or the server.
const buckets = new Map<string, number[]>();
export function allow(deviceId: string, limitPerMin: number, now = Date.now()): boolean {
  const a = (buckets.get(deviceId) ?? []).filter((t) => now - t < 60_000); if (a.length >= limitPerMin) { buckets.set(deviceId, a); return false; } a.push(now); buckets.set(deviceId, a); return true;
}
export const resetRateLimits = () => buckets.clear();
