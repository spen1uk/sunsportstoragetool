import { type DB, now, sha256, canonicalJson } from './db.ts';
import { publish } from './events.ts';

const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passphrase|secret|token|api[_-]?key)\s*[:=]\s*\S+)/gi;
export const redact = (s: string) => s.replace(SECRET_RE, '[REDACTED]');

function redactDeep(v: unknown): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

/** Append-only, hash-chained audit record. Details are redacted before storage. */
export function audit(db: DB, actor: string, action: string, target = '', detail: Record<string, unknown> = {}) {
  const prev = (db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? 'GENESIS';
  const at = now();
  const d = canonicalJson(redactDeep(detail));
  const hash = sha256([prev, at, actor, action, target, d].join('|'));
  db.prepare('INSERT INTO audit(at,actor,action,target,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?)').run(at, actor, action, target, d, prev, hash);
  publish({ type: 'activity', action, target });
}

export function verifyAuditChain(db: DB): { ok: boolean; brokenAt?: number } {
  let prev = 'GENESIS';
  for (const r of db.prepare('SELECT * FROM audit ORDER BY id').all() as any[]) {
    if (r.prev_hash !== prev || sha256([prev, r.at, r.actor, r.action, r.target, r.detail].join('|')) !== r.hash) return { ok: false, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true };
}
