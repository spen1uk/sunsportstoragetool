import { type DB, id, getMeta, setMeta } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { isExcluded } from './exclusions.ts';
import { looksSecret } from './memory.ts';
import * as missions from './missions.ts';

/**
 * Research follow-through. Two things used to be forgotten the moment a research job ended: what it could NOT find, and the fact that its findings get old.
 *  - Open questions: the gaps a research report names, plus anything Luke asks to track. Listed until he marks them answered or drops them.
 *  - Re-checks: once a day, findings older than 90 days and open questions that are due become PROPOSED missions (they wait for his accept or dismiss, as every follow-up does). Nothing is researched, and no money is spent, without him.
 */
export const RECHECK_DAYS = 90, QUESTION_DAYS = 30, PER_DAY = 2, DAY = 86_400_000;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export type OpenQ = { id: string; question: string; source: string; status: string; note: string; created_at: number; next_check_at: number | null };
export const list = (db: DB, status: 'open' | 'all' = 'open') => db.prepare(`SELECT id,question,source,task_id,status,note,created_at,next_check_at FROM open_questions ${status === 'open' ? "WHERE status='open'" : ''} ORDER BY created_at DESC LIMIT 60`).all() as (OpenQ & { task_id: string | null })[];
export function add(db: DB, question: string, o: { source?: string; taskId?: string | null } = {}, now = Date.now()): string | null {
  const q = question.replace(/\s+/g, ' ').trim().slice(0, 300); if (q.length < 10 || looksSecret(q) || isExcluded(db, q)) return null;
  const k = norm(q); for (const r of db.prepare("SELECT question FROM open_questions WHERE status='open'").all() as { question: string }[]) if (norm(r.question) === k) return null;
  if ((db.prepare("SELECT COUNT(*) c FROM open_questions WHERE status='open'").get() as { c: number }).c >= 40) return null;
  const qid = id(); db.prepare('INSERT INTO open_questions(id,question,source,task_id,created_at,next_check_at) VALUES(?,?,?,?,?,?)').run(qid, q, o.source ?? 'luke', o.taskId ?? null, now, now + QUESTION_DAYS * DAY); audit(db, o.source === 'luke' || !o.source ? 'luke' : 'system', 'openq.added', qid); publish({ type: 'knowledge' }); return qid;
}
/** What a finished research report said it could not settle becomes an open question, with the question it came from. */
export function fromResearch(db: DB, taskId: string, question: string, gaps: string[], now = Date.now()): number {
  let n = 0; for (const g of gaps.slice(0, 6)) if (add(db, `${question.replace(/[?.!]+$/, '').slice(0, 100)}: ${g}`, { source: 'research', taskId }, now)) n++; return n;
}
export function setStatus(db: DB, qid: string, status: 'answered' | 'dropped' | 'open', note = '') {
  const r = db.prepare('UPDATE open_questions SET status=?, note=?, last_checked_at=? WHERE id=?').run(status, note.slice(0, 300), Date.now(), qid); if (r.changes) { audit(db, 'luke', `openq.${status}`, qid); publish({ type: 'knowledge' }); } return r.changes > 0;
}
/** "Look into it now": proposes a follow-up mission (it still waits for his accept). */
export function lookInto(db: DB, qid: string, now = Date.now()): string | null {
  const q = db.prepare("SELECT question FROM open_questions WHERE id=? AND status='open'").get(qid) as { question: string } | undefined; if (!q) return null;
  const m = missions.propose(db, { question: q.question, why: 'An open question from earlier research.', origin: 'openq' }, now); if (m) db.prepare('UPDATE open_questions SET last_checked_at=?, next_check_at=? WHERE id=?').run(now, now + QUESTION_DAYS * DAY, qid); return m;
}
/** Once a day, no model, no spending: proposes at most two re-checks of old findings and two looks at due questions. */
export function recheckDaily(db: DB, now = Date.now()): number {
  const today = new Date(now).toISOString().slice(0, 10); if (getMeta(db, 'openq:ran') === today) return 0; setMeta(db, 'openq:ran', today); let made = 0;
  for (const e of db.prepare("SELECT id, name FROM entities WHERE source_ref LIKE 'research:%' AND updated_at<? ORDER BY updated_at LIMIT 12").all(now - RECHECK_DAYS * DAY) as { id: string; name: string }[]) {
    if (made >= PER_DAY) break; const key = `recheck:${e.id}`; const asked = Number(getMeta(db, key) || 0); if (now - asked < RECHECK_DAYS * DAY) continue;
    setMeta(db, key, String(now)); if (missions.propose(db, { question: `Re-check: ${e.name}`, why: `Last researched more than ${RECHECK_DAYS} days ago; prices, products and facts may have changed.`, origin: 'recheck' }, now)) made++;
  }
  let q = 0; for (const r of db.prepare("SELECT id, question FROM open_questions WHERE status='open' AND next_check_at IS NOT NULL AND next_check_at<=? ORDER BY next_check_at LIMIT 6").all(now) as { id: string; question: string }[]) {
    if (q >= PER_DAY) break; db.prepare('UPDATE open_questions SET next_check_at=?, last_checked_at=? WHERE id=?').run(now + QUESTION_DAYS * DAY, now, r.id); if (missions.propose(db, { question: `Look again: ${r.question}`, why: 'It was left open by earlier research.', origin: 'openq' }, now)) { q++; made++; }
  }
  if (made) audit(db, 'system', 'openq.rechecks_proposed', String(made)); return made;
}
export function describe(db: DB): string {
  const l = list(db); if (!l.length) return 'Nothing is open, sir. I\'m not tracking any unanswered research questions.';
  return `Still open (${l.length}):\n${l.slice(0, 8).map((q, i) => `${i + 1}. ${q.question}`).join('\n')}${l.length > 8 ? `\n…and ${l.length - 8} more on the Knowledge page.` : ''}\nOn the Knowledge page you can mark each answered, drop it, or ask me to look into it.`;
}
