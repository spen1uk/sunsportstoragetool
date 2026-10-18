import { type DB } from './db.ts';
import { audit } from './audit.ts';

/**
 * The research source catalog: what Jarvis knows about places it reads from. Marking a site "trusted" only changes how research is aimed
 * (focused searches); it never lets Jarvis fetch pages itself (that stays a separate, approved allow-list entry). "blocked" sites are excluded from searches.
 * Reliability scores are YOURS (or empty): nothing here invents a score for a site.
 */
export const CLASSES = ['official', 'primary', 'reference', 'news', 'vendor', 'community', 'academic', 'unknown'] as const;
export const STATUSES = ['suggested', 'trusted', 'watch', 'blocked'] as const;
const MAX_SOURCES = 500;

export function validHost(h: unknown): string | null {
  const host = String(h ?? '').trim().toLowerCase().replace(/^www\./, '');
  if (!/^(?=.{4,120}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(host)) return null;
  if (/\.(local|internal|lan|home|corp|localhost|invalid|test|example)$/.test(host)) return null;
  return host;
}
const cleanText = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);

export type SourceRow = { host: string; label: string; class: string; reliability: number | null; status: string; terms_note: string; topics: string[]; cadence_days: number | null; last_checked: number | null; added_by: string; times_cited: number; created_at: number };
const map = (r: any): SourceRow => ({ ...r, topics: JSON.parse(r.topics || '[]') });
export const list = (db: DB) => (db.prepare("SELECT * FROM sources ORDER BY CASE status WHEN 'suggested' THEN 0 WHEN 'trusted' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END, times_cited DESC, host").all() as any[]).map(map);
export const get = (db: DB, host: string) => { const r = db.prepare('SELECT * FROM sources WHERE host=?').get(host); return r ? map(r) : null; };

export function upsert(db: DB, raw: { host: string; label?: string; class?: string; reliability?: number | null; status?: string; terms_note?: string; topics?: string[]; cadence_days?: number | null }, by = 'luke', now = Date.now()) {
  const host = validHost(raw.host); if (!host) throw new Error('That is not a valid public website name (for example "example.com").');
  const cur = get(db, host);
  if (!cur && (db.prepare('SELECT COUNT(*) c FROM sources').get() as any).c >= MAX_SOURCES) throw new Error(`The catalog is full (${MAX_SOURCES} sites). Remove some first.`);
  const cls = raw.class ?? cur?.class ?? 'unknown'; if (!(CLASSES as readonly string[]).includes(cls)) throw new Error('unknown class');
  const status = raw.status ?? cur?.status ?? 'trusted'; if (!(STATUSES as readonly string[]).includes(status)) throw new Error('unknown status');
  const rel = raw.reliability === undefined ? cur?.reliability ?? null : raw.reliability; if (rel !== null && !(Number.isInteger(rel) && rel >= 0 && rel <= 100)) throw new Error('reliability must be 0 to 100');
  const cad = raw.cadence_days === undefined ? cur?.cadence_days ?? null : raw.cadence_days; if (cad !== null && !(Number.isInteger(cad) && cad >= 1 && cad <= 365)) throw new Error('review cadence must be 1 to 365 days');
  const topics = (raw.topics ?? cur?.topics ?? []).map((t) => cleanText(t, 30).toLowerCase()).filter(Boolean).slice(0, 12);
  const label = cleanText(raw.label ?? cur?.label ?? '', 80), note = cleanText(raw.terms_note ?? cur?.terms_note ?? '', 300);
  if (cur) db.prepare('UPDATE sources SET label=?,class=?,reliability=?,status=?,terms_note=?,topics=?,cadence_days=? WHERE host=?').run(label, cls, rel, status, note, JSON.stringify(topics), cad, host);
  else db.prepare('INSERT INTO sources(host,label,class,reliability,status,terms_note,topics,cadence_days,added_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(host, label, cls, rel, status, note, JSON.stringify(topics), cad, by, now);
  audit(db, by, cur ? 'source.updated' : 'source.added', host, { status, class: cls }); return host;
}
export function remove(db: DB, host: string) { const r = db.prepare('DELETE FROM sources WHERE host=?').run(host); if (r.changes) audit(db, 'luke', 'source.removed', host); return Number(r.changes) > 0; }
export function markChecked(db: DB, host: string, now = Date.now()) { db.prepare('UPDATE sources SET last_checked=? WHERE host=?').run(now, host); }

/** Research found these sites worth a look: add them as SUGGESTIONS (never trusted automatically). */
export function suggestFromResearch(db: DB, hosts: string[], now = Date.now()) {
  let added = 0;
  for (const h of hosts.slice(0, 10)) {
    const host = validHost(h); if (!host) continue;
    if (get(db, host)) { db.prepare('UPDATE sources SET times_cited=times_cited+1 WHERE host=?').run(host); continue; }
    if ((db.prepare('SELECT COUNT(*) c FROM sources').get() as any).c >= MAX_SOURCES) break;
    db.prepare("INSERT INTO sources(host,status,added_by,times_cited,created_at) VALUES(?, 'suggested','prometheus',1,?)").run(host, now); added++;
  }
  return added;
}
export const blockedHosts = (db: DB) => (db.prepare("SELECT host FROM sources WHERE status='blocked' ORDER BY host LIMIT 60").all() as { host: string }[]).map((r) => r.host);
/** Trusted sites whose topics overlap the question (a trusted site with no topics applies to everything). */
export function trustedFor(db: DB, question: string, limit = 20): string[] {
  const q = question.toLowerCase();
  return list(db).filter((s) => s.status === 'trusted' && (s.topics.length === 0 || s.topics.some((t) => q.includes(t)))).slice(0, limit).map((s) => s.host);
}
/** Sites whose review is due (cadence set and last check older). Automatic re-checking arrives with proactive monitoring; for now this drives a "due for review" badge. */
export const dueForReview = (db: DB, now = Date.now()) => list(db).filter((s) => s.cadence_days && (!s.last_checked || now - s.last_checked > s.cadence_days * 86_400_000)).map((s) => s.host);
