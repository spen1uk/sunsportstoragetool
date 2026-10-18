import crypto from 'node:crypto';
import { z } from 'zod';
import { type DB, id } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import * as gw from './llm/gateway.ts';
import * as memory from './memory.ts';
import { isExcluded } from './exclusions.ts';
import { SYSTEM, parseSuggestions } from './memsuggest.ts';

/**
 * Chats Luke hands over from another assistant (his own data export or a pasted conversation). Nothing is fetched from any
 * account. Imported chats are PRIVATE by default: stored for Luke to read, never shown to the model, never used in context,
 * memory suggestions or the knowledge graph unless he asks. Secrets and excluded names are removed on the way in.
 */
export const MAX_MESSAGES = 400, MAX_TEXT = 20_000, MAX_BATCH = 20;
const conv = z.object({ title: z.string().min(1).max(200), createdAt: z.number().int().nullable(), messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(200_000) }).strict()).min(1).max(5000) }).strict();
const batch = z.object({ conversations: z.array(conv).min(1).max(MAX_BATCH), project: z.string().max(80).default('') }).strict();

export function importChats(db: DB, raw: unknown, now = Date.now()) {
  const b = batch.parse(raw); const out = { imported: 0, duplicates: 0, skipped: 0, redactedMessages: 0 };
  for (const c of b.conversations) {
    if (isExcluded(db, c.title) || memory.looksSecret(c.title)) { out.skipped++; continue; }
    let redacted = 0; const truncated = c.messages.length > MAX_MESSAGES;
    const msgs = c.messages.slice(0, MAX_MESSAGES).map((m) => {
      const t = m.text.slice(0, MAX_TEXT);
      if (t.split('\n').some((l) => memory.looksSecret(l))) { redacted++; return { role: m.role, text: '[removed: this looked like a secret]' }; }
      if (isExcluded(db, t)) { redacted++; return { role: m.role, text: '[removed: mentions something you asked me never to store]' }; }
      return { role: m.role, text: t };
    });
    const sha = crypto.createHash('sha256').update(JSON.stringify([c.title, msgs])).digest('hex');
    if (db.prepare('SELECT 1 FROM chat_imports WHERE sha256=?').get(sha)) { out.duplicates++; continue; }
    const iid = id();
    db.prepare('INSERT INTO chat_imports(id,title,source_created_at,imported_at,message_count,redacted,truncated,project,sha256) VALUES(?,?,?,?,?,?,?,?,?)').run(iid, c.title, c.createdAt, now, msgs.length, redacted, truncated ? 1 : 0, b.project, sha);
    const ins = db.prepare('INSERT INTO chat_import_messages(import_id,idx,role,text) VALUES(?,?,?,?)'); msgs.forEach((m, i) => ins.run(iid, i, m.role, m.text));
    out.imported++; out.redactedMessages += redacted;
  }
  audit(db, 'luke', 'chatimport.imported', '', out); publish({ type: 'imports' }); return out;
}
export const list = (db: DB) => db.prepare('SELECT id,title,source_created_at,imported_at,message_count,redacted,truncated,visibility,project,suggested_at FROM chat_imports ORDER BY imported_at DESC, rowid DESC LIMIT 500').all();
export function messages(db: DB, iid: string) { const h = db.prepare('SELECT * FROM chat_imports WHERE id=?').get(iid); if (!h) return null; return { chat: h, messages: db.prepare('SELECT idx,role,text FROM chat_import_messages WHERE import_id=? ORDER BY idx').all(iid) }; }
export function update(db: DB, iid: string, raw: unknown) {
  const v = z.object({ visibility: z.enum(['private', 'searchable']).optional(), project: z.string().max(80).optional() }).strict().parse(raw);
  const cur = db.prepare('SELECT visibility FROM chat_imports WHERE id=?').get(iid) as { visibility: string } | undefined; if (!cur) return false;
  if (v.visibility) db.prepare('UPDATE chat_imports SET visibility=? WHERE id=?').run(v.visibility, iid);
  if (v.project !== undefined) db.prepare('UPDATE chat_imports SET project=? WHERE id=?').run(v.project, iid);
  audit(db, 'luke', 'chatimport.updated', iid, { visibility: v.visibility, before: cur.visibility }); publish({ type: 'imports' }); return true;
}
export function remove(db: DB, iid: string) { const r = db.prepare('DELETE FROM chat_imports WHERE id=?').run(iid); if (r.changes) { audit(db, 'luke', 'chatimport.deleted', iid); publish({ type: 'imports' }); } return r.changes > 0; }
export function removeAll(db: DB) { const n = Number(db.prepare('DELETE FROM chat_imports').run().changes); audit(db, 'luke', 'chatimport.deleted_all', '', { n }); publish({ type: 'imports' }); return n; }

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
/** Luke's own search across everything he has imported (private ones included; this view is his alone). */
export function search(db: DB, q: string) {
  const t = q.trim(); if (t.length < 2) return [];
  return (db.prepare("SELECT c.id, c.title, c.visibility, m.idx, m.role, m.text FROM chat_import_messages m JOIN chat_imports c ON c.id=m.import_id WHERE m.text LIKE ? ESCAPE '\\' ORDER BY c.imported_at DESC LIMIT 30").all(`%${esc(t)}%`) as any[]).map((r) => {
    const i = r.text.toLowerCase().indexOf(t.toLowerCase()); return { id: r.id, title: r.title, visibility: r.visibility, idx: r.idx, role: r.role, snippet: r.text.slice(Math.max(0, i - 60), i + 120) };
  });
}
/** Titles only, and only of chats Luke made searchable, for "what do you know about X". */
export const mentions = (db: DB, q: string) => (db.prepare("SELECT DISTINCT c.title FROM chat_import_messages m JOIN chat_imports c ON c.id=m.import_id WHERE c.visibility='searchable' AND m.text LIKE ? ESCAPE '\\' LIMIT 5").all(`%${esc(q.trim())}%`) as { title: string }[]).map((r) => r.title);

/** On demand: sends this one chat (Luke's side only, fenced) to the model and queues suggestions for him to accept or reject. */
export async function suggestMemories(db: DB, iid: string, now = Date.now()) {
  const m = messages(db, iid) as any; if (!m) return { ok: false as const, error: 'not found' };
  if (!gw.ready(db, 'chat')) return { ok: false as const, error: 'No language model is connected.' };
  const fence = (s: string) => s.replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  const mine = (m.messages as any[]).filter((x) => x.role === 'user' && !x.text.startsWith('[removed')).slice(0, 40);
  if (!mine.length) return { ok: true as const, added: 0 };
  const known = (db.prepare('SELECT content FROM memories WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT 40').all() as { content: string }[]).map((r) => fence(r.content));
  const user = `<data kind="REMEMBERED">\n${known.map((k) => `- ${k}`).join('\n') || '(none)'}\n</data>\n<data kind="DECLINED">\n(none)\n</data>\n<data kind="conversation">\n${mine.map((x) => `LUKE: ${fence(x.text)}`).join('\n')}\n</data>`;
  const r = await gw.complete(db, { task: 'chat', system: SYSTEM, messages: [{ role: 'user', content: user }], ref: `import:${iid}` }, now);
  if (!r.ok) return { ok: false as const, error: r.error };
  const have = new Set([...known, ...(db.prepare("SELECT content FROM memory_suggestions WHERE status='pending'").all() as any[]).map((x) => x.content)].map((s) => s.toLowerCase()));
  let added = 0;
  for (const c of parseSuggestions(r.text)) { if (memory.looksSecret(c) || isExcluded(db, c) || have.has(c.toLowerCase())) continue; db.prepare('INSERT INTO memory_suggestions(id,content,created_at) VALUES(?,?,?)').run(id(), c, now); have.add(c.toLowerCase()); added++; }
  db.prepare('UPDATE chat_imports SET suggested_at=? WHERE id=?').run(now, iid); audit(db, 'luke', 'chatimport.suggest', iid, { added }); publish({ type: 'memory' });
  return { ok: true as const, added };
}
