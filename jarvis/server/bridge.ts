import crypto from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.ts';
import { id } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { parseScan, rememberSources, sources, storeCalendar, recordSync, type CalEvent } from './calendar.ts';
import { parseNotes, storeNotes } from './notes.ts';

/**
 * Mac helper → server bridge. When Jarvis runs on a server it cannot read Apple Calendar/Notes itself, so a small helper on
 * Luke's Mac reads them (read-only, exactly as before) and pushes a copy here. Design rules:
 *  - the server decides WHAT may be read (the calendars/folders Luke ticked); anything else pushed is discarded;
 *  - the helper's credential can do exactly three things (read its config, report names, push copies) and nothing else;
 *  - only a hash of the credential is stored; it can be revoked at any time; Luke needs step-up to create one.
 */
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const fails = { n: 0, lockedUntil: 0 };
export const resetBridgeThrottle = () => { fails.n = 0; fails.lockedUntil = 0; };

export function createToken(db: DB, nowMs = Date.now()) {
  db.prepare('UPDATE bridge_tokens SET revoked_at=? WHERE revoked_at IS NULL').run(nowMs);   // one active helper at a time
  const token = 'jvb_' + crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO bridge_tokens(id,token_hash,created_at) VALUES(?,?,?)').run(id(), sha(token), nowMs);
  audit(db, 'luke', 'bridge.token_created'); return token;
}
export function revokeToken(db: DB, nowMs = Date.now()) { const r = db.prepare('UPDATE bridge_tokens SET revoked_at=? WHERE revoked_at IS NULL').run(nowMs); if (r.changes) audit(db, 'luke', 'bridge.token_revoked'); return r.changes > 0; }
export function status(db: DB) {
  const t = db.prepare('SELECT created_at, last_used_at FROM bridge_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get() as { created_at: number; last_used_at: number | null } | undefined;
  return { configured: !!t, createdAt: t?.created_at ?? null, lastSeen: t?.last_used_at ?? null };
}
/** Check an Authorization header. Constant-time on the hash; repeated failures lock the bridge door briefly. */
export function verify(db: DB, header: string | undefined, nowMs = Date.now()): { ok: true } | { ok: false; status: number; error: string } {
  if (nowMs < fails.lockedUntil) return { ok: false, status: 429, error: 'Too many attempts' };
  const m = /^Bearer (jvb_[A-Za-z0-9_-]{20,100})$/.exec(header ?? '');
  const row = m ? (db.prepare('SELECT id, token_hash FROM bridge_tokens WHERE revoked_at IS NULL AND token_hash=?').get(sha(m[1])) as { id: string; token_hash: string } | undefined) : undefined;
  if (!row || !crypto.timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(sha(m![1])))) {
    fails.n++; if (fails.n >= 10) { fails.lockedUntil = nowMs + 60_000; fails.n = 0; }
    return { ok: false, status: 401, error: 'invalid bridge credential' };
  }
  fails.n = 0; db.prepare('UPDATE bridge_tokens SET last_used_at=? WHERE id=?').run(nowMs, row.id); return { ok: true };
}

/** What the helper may read, as decided on the server. */
export const helperConfig = (db: DB) => ({ calendars: sources(db, 'calendar').filter((s) => s.enabled).map((s) => s.name), folders: sources(db, 'notes').filter((s) => s.enabled).map((s) => s.name) });

const names = z.object({ kind: z.enum(['calendar', 'notes']), names: z.array(z.string().min(1).max(200)).max(200) }).strict();
export function reportNames(db: DB, body: unknown) { const b = names.parse(body); rememberSources(db, b.kind, b.names); return helperConfig(db); }

export function ingestCalendar(db: DB, body: unknown, nowMs = Date.now()) {
  const b = z.object({ events: z.array(z.unknown()).max(8000), detail: z.unknown().optional() }).parse(body);
  const want = new Set(sources(db, 'calendar').filter((s) => s.enabled).map((s) => s.name));
  const scan = parseScan(JSON.stringify({ events: b.events, stats: {} }));
  const events: CalEvent[] = scan.events.filter((e) => want.has(e.calendar)).map(({ rule, exclude, ...e }) => e);   // anything from a calendar Luke did not tick is discarded
  storeCalendar(db, events, { ...(typeof b.detail === 'object' && b.detail ? (b.detail as object) : {}), via: 'mac-helper' }, nowMs, 'mac-helper');
  return { stored: events.length, discarded: scan.events.length - events.length };
}
export function ingestNotes(db: DB, body: unknown, nowMs = Date.now()) {
  const b = z.object({ notes: z.array(z.unknown()).max(1500) }).parse(body);
  const want = new Set(sources(db, 'notes').filter((s) => s.enabled).map((s) => s.name));
  const all = parseNotes(JSON.stringify(b.notes)), notes = all.filter((n) => want.has(n.folder));
  storeNotes(db, notes, nowMs, 'mac-helper'); return { stored: notes.length, discarded: all.length - notes.length };
}
export function reportFailure(db: DB, kind: 'calendar' | 'notes', message: string, nowMs = Date.now()) { recordSync(db, kind, false, 0, `Mac helper: ${message.slice(0, 200)}`, nowMs); publish({ type: 'calendar-sync', kind }); }
