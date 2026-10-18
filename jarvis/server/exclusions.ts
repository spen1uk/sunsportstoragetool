import { type DB, id } from './db.ts';
import { audit } from './audit.ts';

/** Words or names Luke has said must never be stored in memory, the knowledge graph or the decision log. DB-only, so any module may import it. */
export type Exclusion = { id: string; pattern: string; note: string; created_at: number };

export const list = (db: DB) => db.prepare('SELECT * FROM exclusions ORDER BY created_at DESC').all() as Exclusion[];

export function add(db: DB, pattern: string, note = ''): { ok: true; id: string } | { ok: false; error: string } {
  const p = pattern.trim().replace(/\s+/g, ' ');
  if (p.length < 3 || p.length > 80) return { ok: false, error: 'An exclusion needs 3 to 80 characters.' };
  const ex = db.prepare('SELECT id FROM exclusions WHERE lower(pattern)=lower(?)').get(p) as { id: string } | undefined;
  if (ex) return { ok: true, id: ex.id };
  const eid = id();
  db.prepare('INSERT INTO exclusions(id,pattern,note,created_at) VALUES(?,?,?,?)').run(eid, p, note.slice(0, 200), Date.now());
  audit(db, 'luke', 'exclusion.added', eid, { length: p.length });   // the pattern itself is not written to the audit log
  return { ok: true, id: eid };
}
export function remove(db: DB, eid: string) {
  const r = db.prepare('DELETE FROM exclusions WHERE id=?').run(eid);
  if (r.changes) audit(db, 'luke', 'exclusion.removed', eid);
  return r.changes > 0;
}
/** True if the text contains any excluded pattern (case-insensitive). */
export function isExcluded(db: DB, text: string): boolean {
  const t = text.toLowerCase();
  return (db.prepare('SELECT pattern FROM exclusions').all() as { pattern: string }[]).some((e) => t.includes(e.pattern.toLowerCase()));
}
export const filterOut = <T,>(db: DB, items: T[], text: (x: T) => string): T[] => {
  const pats = (db.prepare('SELECT pattern FROM exclusions').all() as { pattern: string }[]).map((e) => e.pattern.toLowerCase());
  return pats.length ? items.filter((x) => { const t = text(x).toLowerCase(); return !pats.some((p) => t.includes(p)); }) : items;
};
