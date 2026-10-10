import { type DB, id, now } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';

const SECRETISH = /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.|-----BEGIN|\b(password|passcode|passphrase|pin|api[_ -]?key|secret|token|2fa|verification code)\b\s*(is|=|:)?\s*\S+|\b\d{13,19}\b)/i;

export function remember(db: DB, content: string, o: { source: string; scope?: string; kind?: string; confidence?: number }) {
  const text = content.trim().slice(0, 1000);
  if (!text) return { ok: false as const, error: 'nothing to remember' };
  if (SECRETISH.test(text)) return { ok: false as const, error: 'That looks like a secret or credential. Secrets are never stored in memory.' };
  const mid = id();
  db.prepare('INSERT INTO memories(id,kind,content,scope,source,confidence,created_at) VALUES(?,?,?,?,?,?,?)').run(mid, o.kind ?? 'fact', text, o.scope ?? 'personal', o.source, o.confidence ?? 0.9, now());
  audit(db, 'luke', 'memory.created', mid, { scope: o.scope ?? 'personal' });
  publish({ type: 'memory' });
  return { ok: true as const, id: mid };
}

/** A correction supersedes the earlier fact; the old row is kept (inactive) only until Luke forgets it. */
export function update(db: DB, memoryId: string, content: string) {
  const old = db.prepare('SELECT * FROM memories WHERE id=? AND superseded_by IS NULL').get(memoryId) as any;
  if (!old) return { ok: false as const, error: 'not found' };
  const r = remember(db, content, { source: `correction of ${memoryId}`, scope: old.scope, kind: old.kind });
  if (!r.ok) return r;
  db.prepare('UPDATE memories SET superseded_by=? WHERE id=?').run(r.id, memoryId);
  return r;
}

/** Forget is a hard delete (row removed, not flagged). Backups roll off per retention; see docs/THREAT_MODEL.md. */
export function forget(db: DB, memoryId: string) {
  const r = db.prepare('DELETE FROM memories WHERE id=?').run(memoryId);
  if (r.changes) { audit(db, 'luke', 'memory.forgotten', memoryId); publish({ type: 'memory' }); }
  return !!r.changes;
}

export const search = (db: DB, q: string) =>
  db.prepare("SELECT * FROM memories WHERE superseded_by IS NULL AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20")
    .all(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
