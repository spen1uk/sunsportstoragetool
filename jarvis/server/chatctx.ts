import type { DB } from './db.ts';
import type { ChatMessage } from './llm/types.ts';
import { keywords } from './extract.ts';
import { ACTIVE } from './memory.ts';
import * as embed from './embed.ts';

// What the chat model is shown about Luke and the conversation so far. Shared by the ordinary chat path and the agent.
/** Memories that match what he said, plus the latest few. Each carries how sure we are: his own words are plain, anything unconfirmed or old is labelled so the model does not state it as fact. Out-of-date and wrong ones are never used. */
const tagOf = (m: any) => `${m.content}${m.status === 'unverified' ? ' (unconfirmed)' : m.status === 'preference' ? ' (a preference)' : ''}${Date.now() - Date.parse(m.created_at) > 365 * 86_400_000 && m.status !== 'confirmed' ? ' (saved over a year ago, may be out of date)' : ''}`;
export function relevantMemories(db: DB, text: string, byMeaning: string[] = []): string[] {
  const rows = new Map<string, string>(); const tag = tagOf;
  for (const k of keywords(text).slice(0, 6))
    for (const m of db.prepare(`SELECT id, content, status, created_at FROM memories WHERE ${ACTIVE} AND content LIKE ? ESCAPE '\\' LIMIT 3`).all(`%${k.replace(/[\\%_]/g, '')}%`) as any[]) rows.set(m.id, tag(m));
  for (const m of db.prepare(`SELECT id, content, status, created_at FROM memories WHERE ${ACTIVE} ORDER BY created_at DESC LIMIT 4`).all() as any[]) rows.set(m.id, tag(m));
  return [...byMeaning, ...rows.values()].filter((v, i, a) => a.indexOf(v) === i).slice(0, 9);
}
/** Memories whose MEANING is close to what he said (when the local model is available); these go first. */
export async function memoriesByMeaning(db: DB, text: string): Promise<string[]> {
  try {
    const hits = await embed.similar(db, text, { kind: 'memory', limit: 3 }); if (!hits) return [];
    const get = db.prepare(`SELECT id, content, status, created_at FROM memories WHERE id=? AND ${ACTIVE}`);
    return hits.filter((h) => h.score >= embed.MIN_SIMILARITY).map((h) => get.get(h.ref) as any).filter(Boolean).map(tagOf);
  } catch { return []; }
}


export function history(db: DB, limit = 12): ChatMessage[] {
  const rows = db.prepare(`SELECT role, content, web FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ${Math.max(1, Math.min(60, Math.floor(limit)))}) ORDER BY id`).all() as { role: 'luke' | 'jarvis'; content: string; web: number }[];
  // An earlier answer that came from the internet stays in history only as a clipped, labelled, unverified note (page text must not steer later private chats).
  const msgs: ChatMessage[] = rows.map((r) => ({ role: r.role === 'luke' ? 'user' : 'assistant', content: r.web && r.role === 'jarvis' ? `(Earlier answer from a web search, unverified:) ${r.content.split('\n\nFrom the internet')[0].slice(0, 500)}` : r.content }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();   // conversations must open with a user turn
  return msgs;
}
