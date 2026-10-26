import { type DB, getMeta, setMeta } from './db.ts';
import { audit } from './audit.ts';
import * as memory from './memory.ts';

/**
 * Where Luke is, so "what's the weather tomorrow" works without being told every time. A place is only a city and state he typed himself.
 * It is kept as a memory ("Based in …") and in one setting, is added to weather and local searches that name no place (the place itself is the only
 * thing added; the web search never sees anything else about him), and can be forgotten by saying "forget where I live".
 * When Jarvis has to ask for the city he remembers the question for 15 minutes, so the answer ("I am in Oconomowoc WI") finishes the original question.
 */
const PENDING_MS = 15 * 60_000;
export const getPlace = (db: DB) => getMeta(db, 'home:place') || null;
const STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/i;
const NOT_A_PLACE = new Set(['yes', 'no', 'ok', 'okay', 'thanks', 'thank', 'sure', 'nothing', 'nevermind', 'never mind', 'cancel', 'stop', 'skip', 'later', 'nope', 'yep', 'maybe', 'none', 'home', 'here', 'work', 'forget it', 'not sure', 'dont know', "don't know", 'why', 'what', 'hi', 'hello']);
const CHAT_WORDS = new Set(['yes', 'no', 'ok', 'okay', 'thanks', 'thank', 'you', 'please', 'never', 'mind', 'sure', 'nope', 'yep', 'nothing', 'later', 'skip', 'cancel', 'stop', 'hello', 'hi', 'hey', 'sorry', 'actually', 'wait', 'my', 'me', 'it', 'that', 'this', 'not']);
const title = (s: string) => s.replace(/\s+/g, ' ').trim().split(' ').map((w, i, a) => (i === a.length - 1 && /^[a-z]{2}$/i.test(w) && STATES.test(w) && a.length > 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ').replace(/ ([A-Z]{2})$/, ', $1').replace(/,,/g, ',');

/** A place named in a reply or statement, or null. `pending` = Jarvis just asked for it, so a bare "Oconomowoc WI" counts. */
export function parsePlace(text: string, pending: boolean): string | null {
  const t = text.trim().replace(/[.!?]+$/, ''); if (t.length < 3 || t.length > 60) return null;
  let m = t.match(/^(?:i\s+(?:live|am based|'m based|stay)\s+(?:in|at|near|around)|i(?:'m| am)\s+(?:currently\s+|now\s+)?(?:living|located|based|staying)\s+(?:in|at|near|around)|we\s+(?:live|are based|'re based)\s+(?:in|near)|my\s+(?:city|town|location|home(?:\s*town)?)\s+is|i(?:'m| am)\s+from)\s+(.+)$/i);
  let raw = m?.[1] ?? null, explicit = !!raw;
  if (!raw && pending) { m = t.match(/^(?:i(?:'m| am)(?:\s+currently|\s+now)?(?:\s+in|\s+at|\s+near|\s+around)?|we(?:'re| are)(?:\s+in|\s+near)?|it(?:'s| is)|in|near|around|at)\s+(.+)$/i); raw = m?.[1] ?? t; }
  if (!raw) return null;
  raw = raw.replace(/^the\s+/i, '').replace(/[^A-Za-z .,'-]/g, '').trim();
  const words = raw.split(/\s+/).filter(Boolean); if (!words.length || words.length > 5 || raw.length < 3) return null;
  if (NOT_A_PLACE.has(raw.toLowerCase()) || words.some((w) => CHAT_WORDS.has(w.toLowerCase()))) return null;
  if (/\b(is|are|was|want|need|can|could|should|would|will|the weather|forecast|please|tomorrow|today|tonight|what|how|when|why|who|calendar|task|remind)\b/i.test(raw)) return null;
  if (!explicit && !(STATES.test(raw) || /,/.test(raw) || words.length <= 3)) return null;
  return title(raw.replace(/,\s*/g, ' ').replace(/\s+/g, ' '));
}
export function setPlace(db: DB, place: string) {
  setMeta(db, 'home:place', place); audit(db, 'luke', 'place.set', '', {});
  try { memory.remember(db, `Based in ${place}.`, { source: 'luke', kind: 'fact', status: 'confirmed' }); } catch { /* the setting is what matters */ }
}
export function clearPlace(db: DB): boolean {
  const had = !!getPlace(db); setMeta(db, 'home:place', ''); audit(db, 'luke', 'place.cleared', '');
  for (const r of db.prepare("SELECT id FROM memories WHERE content LIKE 'Based in %' AND source='luke'").all() as { id: string }[]) memory.forget(db, r.id);
  return had;
}

const WEATHERISH = /\b(weather|forecast|temperature|rain(?:ing)?|snow(?:ing)?|traffic|how (?:hot|cold|warm)|near me|nearby|closest|nearest)\b/i;
const NAMED = /\b(?:in|for|at|near|around)\s+[A-Z][A-Za-z.'-]+(?:[ ,]+[A-Z][A-Za-z.'-]+)*|,\s*[A-Z]{2}\b/;
export const isLocal = (q: string) => WEATHERISH.test(q);
export const namesPlace = (q: string) => NAMED.test(q);
/** The search text with his city added when the question is local and names no place. */
export function withPlace(db: DB, q: string): string { const p = getPlace(db); return p && isLocal(q) && !namesPlace(q) ? `${q} (in ${p})` : q; }
export const needsPlace = (db: DB, q: string) => isLocal(q) && !namesPlace(q) && !getPlace(db);

export function setPending(db: DB, original: string, now = Date.now()) { setMeta(db, 'place:pending', JSON.stringify({ original: original.slice(0, 400), at: now })); }
export function pending(db: DB, now = Date.now()): { original: string } | null { try { const j = JSON.parse(getMeta(db, 'place:pending') || 'null'); return j && now - j.at <= PENDING_MS ? { original: String(j.original) } : null; } catch { return null; } }
export const clearPending = (db: DB) => setMeta(db, 'place:pending', '');
export const ASK = 'Where are you, sir? Tell me your city (for example “Oconomowoc, WI”) and I\'ll look it up, and remember it for next time.';
