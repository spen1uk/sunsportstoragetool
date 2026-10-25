import { type DB } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { looksSecret } from './memory.ts';
import { isExcluded } from './exclusions.ts';

/**
 * A feedback signal on Jarvis's answers. It only ever feeds the improvement list (gaps): three or more "wrong" marks in two weeks on the same kind of answer
 * become a gap for Luke to look at. It never changes a prompt, a rule or a skill by itself.
 */
const DAY = 86_400_000;
export function rate(db: DB, messageId: number | null, rating: 'up' | 'down', note = '', now = Date.now()): { ok: boolean; error?: string } {
  const m = messageId ? db.prepare("SELECT id FROM messages WHERE id=? AND role='jarvis'").get(messageId) : db.prepare("SELECT id FROM messages WHERE role='jarvis' ORDER BY id DESC LIMIT 1").get(); if (!m) return { ok: false, error: 'There is nothing of mine to rate yet.' };
  const clean = note.replace(/\s+/g, ' ').trim().slice(0, 300); const keep = clean && !looksSecret(clean) && !isExcluded(db, clean) ? clean : '';
  db.prepare('DELETE FROM feedback WHERE message_id=?').run((m as { id: number }).id);   // one rating per answer; the latest wins
  db.prepare('INSERT INTO feedback(message_id,rating,note,created_at) VALUES(?,?,?,?)').run((m as { id: number }).id, rating, keep, now); audit(db, 'luke', 'feedback.rated', String((m as { id: number }).id), { rating }); publish({ type: 'improve' }); return { ok: true };
}
export const ratingOf = (db: DB, messageId: number) => (db.prepare('SELECT rating FROM feedback WHERE message_id=?').get(messageId) as { rating: string } | undefined)?.rating ?? null;
/** "Wrong" marks in the last 14 days, grouped by kind of answer (from the internet, or ordinary chat). */
export function downByKind(db: DB, now = Date.now()): { kind: 'web' | 'chat'; count: number; notes: string[] }[] {
  const rows = db.prepare("SELECT m.web w, f.note n FROM feedback f JOIN messages m ON m.id=f.message_id WHERE f.rating='down' AND f.created_at>?").all(now - 14 * DAY) as { w: number; n: string }[];
  return (['web', 'chat'] as const).map((k) => { const r = rows.filter((x) => (x.w ? 'web' : 'chat') === k); return { kind: k, count: r.length, notes: r.map((x) => x.n).filter(Boolean).slice(0, 3) }; }).filter((x) => x.count > 0);
}
export const chatRating = (t: string): { rating: 'up' | 'down'; note: string } | null => {
  const x = t.trim(); let m: RegExpMatchArray | null;
  if ((m = x.match(/^(?:(?:that|this|it)(?:'s| is| was)?|you(?:'re| are)|wrong answer)[\s,]*(?:wrong|incorrect|not right|not correct|mistaken)(?:[,.:;]?\s*(?:because\s+)?(.{3,300}))?[.!]*$/i))) return { rating: 'down', note: m[1] ?? '' };
  if ((m = x.match(/^wrong[,.:;]\s*(.{3,300})$/i))) return { rating: 'down', note: m[1] };
  if (/^wrong[.! ]*$/i.test(x)) return { rating: 'down', note: '' };
  if (/^(?:(?:good|great|perfect|excellent) (?:answer|job|response)|exactly right|(?:that|this)(?:'s| is| was) (?:exactly )?(?:right|correct|perfect))[.! ]*$/i.test(x)) return { rating: 'up', note: '' };
  return null;
};
