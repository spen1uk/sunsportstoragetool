import { z } from 'zod';
import { type DB, id, now as isoNow } from './db.ts';
import { audit } from './audit.ts';
import { isPaused } from './pause.ts';
import { chicagoParts, chicagoInstant } from './tz.ts';
import * as props from './proposals.ts';

/**
 * Standing permissions: Luke pre-approves ONE narrow kind of chat suggestion so it runs without the Confirm click.
 * Rules, all enforced here and tested:
 *  - Only the few low-impact, undoable kinds below can ever be granted. Nothing that sends, spends, deletes, fetches, or remembers is on the list.
 *  - Created only from the signed-in dashboard with a fresh passphrase/passkey (the caller spends the step-up); never by chat, a device, or the model.
 *  - Never inferred from a one-time approval. Each has a daily cap, an expiry (max 90 days), and the interfaces it applies to.
 *  - Revoking takes effect at once. A paused Jarvis never auto-runs anything. Every use is logged.
 */
export const ELIGIBLE = ['add_task', 'log_habit', 'log_learning', 'mark_contacted'] as const;
export type Eligible = (typeof ELIGIBLE)[number];
export const CHANNELS = ['dashboard', 'phone', 'car', 'voice'] as const;   // text messages are deliberately not eligible
const DAY = 86_400_000;

export const grantInput = z.object({
  type: z.enum(ELIGIBLE), perDay: z.number().int().min(1).max(30).default(10), days: z.number().int().min(1).max(90).default(30),
  channels: z.array(z.enum(CHANNELS)).min(1).default(['dashboard']),
}).strict();

export function grant(db: DB, raw: unknown, nowMs = Date.now()) {
  const i = grantInput.parse(raw), category = `proposal:${i.type}`;
  if (db.prepare('SELECT 1 FROM standing_permissions WHERE category=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)').get(category, nowMs)) throw new Error('That kind already has an active standing permission. Revoke it first to change it.');
  const sid = id();
  db.prepare('INSERT INTO standing_permissions(id,category,recipients,limits,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(sid, category, '[]', JSON.stringify({ perDay: i.perDay, channels: [...new Set(i.channels)] }), nowMs + i.days * DAY, isoNow());
  audit(db, 'luke', 'standing.granted', sid, { type: i.type, perDay: i.perDay, days: i.days, channels: i.channels }); return { id: sid };
}

const dayStart = (t: number) => { const p = chicagoParts(t); return chicagoInstant(p.y, p.m, p.d, 0, 0); };
export const usedToday = (db: DB, sid: string, t = Date.now()) => (db.prepare('SELECT COUNT(*) c FROM standing_uses WHERE standing_id=? AND at>=?').get(sid, dayStart(t)) as any).c as number;

export function list(db: DB, t = Date.now()) {
  return (db.prepare("SELECT * FROM standing_permissions WHERE category LIKE 'proposal:%' ORDER BY created_at DESC").all() as any[]).map((r) => {
    const l = JSON.parse(r.limits || '{}');
    return { id: r.id, type: String(r.category).slice(9), perDay: l.perDay as number, channels: l.channels as string[], expiresAt: r.expires_at as number | null, status: r.revoked_at ? 'revoked' : r.expires_at && r.expires_at <= t ? 'expired' : 'active', usedToday: usedToday(db, r.id, t) };
  });
}

/** Run any just-created chat suggestions that a live standing permission covers. Returns what ran and what still waits for a click. */
export function autoRun(db: DB, created: { id: string; kind: string; summary: string }[], channel: string, t = Date.now()) {
  const done: { summary: string; message: string }[] = [], waiting: typeof created = [];
  if (isPaused(db)) return { done, waiting: created };
  for (const p of created) {
    const row = db.prepare("SELECT * FROM standing_permissions WHERE category=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(`proposal:${p.kind}`, t) as any;
    const l = row ? JSON.parse(row.limits || '{}') : null;
    if (!row || !(ELIGIBLE as readonly string[]).includes(p.kind) || !Array.isArray(l.channels) || !l.channels.includes(channel) || usedToday(db, row.id, t) >= (l.perDay ?? 0)) { waiting.push(p); continue; }
    db.prepare('INSERT INTO standing_uses(standing_id,at,kind,proposal_id,channel) VALUES(?,?,?,?,?)').run(row.id, t, p.kind, p.id, channel);   // counted before running, so a failure can't be retried past the cap
    const r = props.confirm(db, p.id, t, 'jarvis (standing permission)');
    audit(db, 'jarvis', 'standing.used', row.id, { kind: p.kind, proposal: p.id, ok: r.ok, channel });
    if (r.ok) done.push({ summary: p.summary, message: r.message }); else waiting.push(p);
  }
  return { done, waiting };
}
