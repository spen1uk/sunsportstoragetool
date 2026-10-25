import { type DB, id, now } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { isExcluded } from './exclusions.ts';

const SECRETISH = /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.|-----BEGIN|\b(password|passcode|passphrase|pin|api[_ -]?key|secret|token|2fa|verification code)\b\s*(is|=|:)?\s*\S+|\b\d{13,19}\b)/i;

export const looksSecret = (t: string) => SECRETISH.test(t);

// ---------- life cycle: status, duplicates, conflicts ----------
export const STATUSES = ['stated', 'confirmed', 'preference', 'unverified', 'historical', 'disproven'] as const;
export type MemStatus = (typeof STATUSES)[number];
/** A memory that is still in force (not replaced, not marked old or wrong). */
export const ACTIVE = "superseded_by IS NULL AND status NOT IN ('historical','disproven')";
const STOPW = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'are', 'was', 'were', 'his', 'her', 'our', 'your', 'you', 'luke', 'sir', 'about', 'been', 'will', 'would', 'than', 'then', 'into', 'also', 'very', 'just', 'its', 'their', 'they', 'them', 'who', 'what', 'when', 'where', 'which']);
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9$%. ]/g, ' ').replace(/(?<![0-9])\.|\.(?![0-9])/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOPW.has(w)).map((w) => w.replace(/s$/, '')));
const numbers = (t: string) => new Set((t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, '')));
const NEG = /\b(not|never|no longer|don't|doesn't|isn't|aren't|won't|can't|cannot|stopped|quit|none)\b/i;
const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
/** Compares a new statement with what is already remembered. Duplicate: same words, same numbers, same yes/no. Conflict: about the same thing, but the numbers differ or one says not. */
export function relate(db: DB, text: string, ignoreId?: string): { duplicate: { id: string; content: string } | null; conflicts: { id: string; content: string; why: string }[] } {
  const A = words(text), nA = numbers(text), negA = NEG.test(text); let duplicate: { id: string; content: string } | null = null; const conflicts: { id: string; content: string; why: string }[] = [];
  if (A.size < 2) return { duplicate, conflicts };
  for (const m of db.prepare(`SELECT id, content FROM memories WHERE ${ACTIVE} ORDER BY created_at DESC LIMIT 400`).all() as { id: string; content: string }[]) {
    if (m.id === ignoreId) continue; const B = words(m.content); let shared = 0; for (const w of A) if (B.has(w)) shared++; const j = shared / (A.size + B.size - shared); if (!j) continue;
    const nB = numbers(m.content), negB = NEG.test(m.content);
    if (j >= 0.8 && sameSet(nA, nB) && negA === negB) { duplicate = { id: m.id, content: m.content }; break; }
    if (shared >= 3 && j >= 0.35 && conflicts.length < 2) { if (nA.size && nB.size && !sameSet(nA, nB)) conflicts.push({ ...m, why: 'the numbers differ' }); else if (negA !== negB) conflicts.push({ ...m, why: 'one of them says “not”' }); }
  }
  return { duplicate, conflicts };
}

export function remember(db: DB, content: string, o: { source: string; scope?: string; kind?: string; confidence?: number; status?: MemStatus; ignoreId?: string }) {
  const text = content.trim().slice(0, 1000);
  if (!text) return { ok: false as const, error: 'nothing to remember' };
  if (SECRETISH.test(text)) return { ok: false as const, error: 'That looks like a secret or credential. Secrets are never stored in memory.' };
  if (isExcluded(db, text)) return { ok: false as const, error: 'That mentions something you asked me never to store.' };
  const rel = relate(db, text, o.ignoreId);
  if (rel.duplicate) { db.prepare('UPDATE memories SET last_confirmed_at=? WHERE id=?').run(now(), rel.duplicate.id); return { ok: true as const, id: rel.duplicate.id, duplicate: true as const, conflicts: [] as { id: string; content: string; why: string }[] }; }
  const mid = id();
  db.prepare('INSERT INTO memories(id,kind,content,scope,source,confidence,created_at,status) VALUES(?,?,?,?,?,?,?,?)').run(mid, o.kind ?? 'fact', text, o.scope ?? 'personal', o.source, o.confidence ?? 0.9, now(), o.status ?? 'stated');
  for (const c of rel.conflicts) db.prepare("INSERT INTO memory_reviews(id,kind,new_id,existing_id,reason,created_at) VALUES(?,'conflict',?,?,?,?)").run(id(), mid, c.id, c.why, now());
  audit(db, 'luke', 'memory.created', mid, { scope: o.scope ?? 'personal', conflicts: rel.conflicts.length });
  publish({ type: 'memory' });
  return { ok: true as const, id: mid, duplicate: false as const, conflicts: rel.conflicts };
}
/** How a save is described to Luke in chat. */
export function describeSaved(r: { ok: true; duplicate: boolean; conflicts: { content: string; why: string }[] }): string {
  if (r.duplicate) return 'I already have that, sir. I\'ve noted that it is still true.';
  if (r.conflicts.length) return `Noted, sir. But it may conflict with something I already had (${r.conflicts[0].why}): “${r.conflicts[0].content.slice(0, 120)}”. Open the Memory page and settle it under “Needs your decision”.`;
  return 'Noted, sir. You can review or correct it on the Memory page.';
}

/** A correction supersedes the earlier fact; the old row is kept (inactive) only until Luke forgets it. */
export function update(db: DB, memoryId: string, content: string) {
  const old = db.prepare('SELECT * FROM memories WHERE id=? AND superseded_by IS NULL').get(memoryId) as any;
  if (!old) return { ok: false as const, error: 'not found' };
  const r = remember(db, content, { source: `correction of ${memoryId}`, scope: old.scope, kind: old.kind, status: old.status === 'preference' ? 'preference' : 'confirmed', ignoreId: memoryId });
  if (!r.ok) return r;
  if (r.id !== memoryId) { db.prepare("UPDATE memories SET superseded_by=?, status='historical' WHERE id=?").run(r.id, memoryId); db.prepare("UPDATE memory_reviews SET status='replaced', decided_at=? WHERE existing_id=? AND status='open'").run(now(), memoryId); }
  return r;
}

/** Forget is a hard delete (row removed, not flagged). Backups roll off per retention; see docs/THREAT_MODEL.md. */
export function forget(db: DB, memoryId: string) {
  const r = db.prepare('DELETE FROM memories WHERE id=?').run(memoryId);
  if (r.changes) { db.prepare("DELETE FROM entity_links WHERE kind='memory' AND ref_id=?").run(memoryId); db.prepare('DELETE FROM memory_reviews WHERE new_id=? OR existing_id=?').run(memoryId, memoryId); audit(db, 'luke', 'memory.forgotten', memoryId); publish({ type: 'memory' }); }
  return !!r.changes;
}
/** Mark a memory as confirmed, still true, out of date, or wrong. Out of date and wrong stop being used in answers but are kept until forgotten. */
export function setStatus(db: DB, memoryId: string, status: MemStatus) {
  if (!STATUSES.includes(status)) return false;
  const r = db.prepare('UPDATE memories SET status=?, last_confirmed_at=? WHERE id=?').run(status, status === 'confirmed' ? now() : null, memoryId);
  if (r.changes) { audit(db, 'luke', 'memory.status', memoryId, { status }); publish({ type: 'memory' }); } return r.changes > 0;
}
export const listReviews = (db: DB) => (db.prepare("SELECT r.id, r.reason, r.created_at, n.id nid, n.content ncontent, e.id eid, e.content econtent FROM memory_reviews r JOIN memories n ON n.id=r.new_id JOIN memories e ON e.id=r.existing_id WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 30").all() as any[]).map((r) => ({ id: r.id, reason: r.reason, created_at: r.created_at, newer: { id: r.nid, content: r.ncontent }, earlier: { id: r.eid, content: r.econtent } }));
/** Luke settles a conflict: the new one replaces the old, both stay, or the new one is dropped. */
export function resolveReview(db: DB, rid: string, action: 'replace' | 'keep_both' | 'drop_new'): boolean {
  const r = db.prepare("SELECT * FROM memory_reviews WHERE id=? AND status='open'").get(rid) as any; if (!r) return false;
  if (action === 'replace') { db.prepare("UPDATE memories SET superseded_by=?, status='historical' WHERE id=?").run(r.new_id, r.existing_id); db.prepare("UPDATE memory_reviews SET status='replaced', decided_at=? WHERE id=?").run(now(), rid); }
  else if (action === 'keep_both') db.prepare("UPDATE memory_reviews SET status='kept_both', decided_at=? WHERE id=?").run(now(), rid);
  else { forget(db, r.new_id); }
  audit(db, 'luke', 'memory.review', rid, { action }); publish({ type: 'memory' }); return true;
}

export const search = (db: DB, q: string) =>
  db.prepare(`SELECT * FROM memories WHERE ${ACTIVE} AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20`)
    .all(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
