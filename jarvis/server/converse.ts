import type { DB } from './db.ts';
import { now } from './db.ts';
import { handleChat, type ChatReply } from './chat.ts';
import { complete, ready, getConfig } from './llm/gateway.ts';
import { buildSystemPrompt } from './persona.ts';
import { buildContext } from './context.ts';
import { keywords } from './extract.ts';
import { publish } from './events.ts';
import type { ChatMessage } from './llm/types.ts';
import { extractProposals, createProposals } from './proposals.ts';

function relevantMemories(db: DB, text: string): string[] {
  const rows = new Map<string, string>();
  for (const k of keywords(text).slice(0, 6))
    for (const m of db.prepare("SELECT id, content FROM memories WHERE superseded_by IS NULL AND content LIKE ? ESCAPE '\\' LIMIT 3").all(`%${k.replace(/[\\%_]/g, '')}%`) as any[]) rows.set(m.id, m.content);
  for (const m of db.prepare('SELECT id, content FROM memories WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT 4').all() as any[]) rows.set(m.id, m.content);
  return [...rows.values()].slice(0, 8);
}

function history(db: DB): ChatMessage[] {
  const rows = db.prepare('SELECT role, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 12) ORDER BY id').all() as { role: 'luke' | 'jarvis'; content: string }[];
  const msgs: ChatMessage[] = rows.map((r) => ({ role: r.role === 'luke' ? 'user' : 'assistant', content: r.content }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();   // conversations must open with a user turn
  return msgs;
}

/**
 * Chat entry point. Deterministic commands always win (so "pause", "add task…" stay instant, free and exact).
 * Anything else goes to the model if one is configured and allowed; the model returns TEXT ONLY and has no tools,
 * so nothing it says can create, change, approve, send or spend anything. Prefix a message with "deep:" for the stronger model.
 */
export async function converse(db: DB, textIn: string, o: { private?: boolean; channel?: string; brief?: boolean } = {}): Promise<ChatReply> {
  const text = textIn.trim().slice(0, 2000), priv = !!o.private, cfg = getConfig(db);
  const modelOk = ready(db, 'chat') && (!priv || cfg.allowInPrivate);
  const cmd = handleChat(db, text, { private: priv, deferFallback: modelOk, channel: o.channel });
  if (!cmd.fallback) return { ...cmd, source: 'command' };

  const strong = /^deep:\s*/i.test(text); const prompt = text.replace(/^deep:\s*/i, '');
  const messages: ChatMessage[] = [...(priv ? [] : history(db)), { role: 'user', content: prompt }];
  publish({ type: 'thinking', on: true });
  try {
    const r = await complete(db, { task: 'chat', system: buildSystemPrompt(db, { memories: priv ? [] : relevantMemories(db, prompt), context: priv ? undefined : buildContext(db, Date.now(), o.channel ?? 'dashboard'), proposals: !priv, brief: o.brief }), messages, strong });
    const raw = r.ok ? r.text.trim() || '…' : `I couldn't reach a language model just now, sir (${r.error}). Command mode is still available: type "help".`;
    // The model may PROPOSE actions; they become Confirm cards and do nothing until Luke clicks. In private mode nothing is stored, so proposals are dropped.
    const ex = r.ok ? extractProposals(raw) : { text: raw, actions: [], dropped: 0 };
    const reply = ex.text; const proposals = r.ok && !priv ? createProposals(db, ex.actions) : [];
    if (!priv) {
      db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', text, now(), o.channel ?? 'dashboard');
      db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', reply, now(), o.channel ?? 'dashboard');
      publish({ type: 'chat' });
    }
    return { text: reply, persisted: !priv, source: r.ok ? 'model' : 'command', model: r.ok ? r.model : undefined, costMicroUsd: r.ok ? r.costMicroUsd : 0, proposals };
  } finally { publish({ type: 'thinking', on: false }); }
}
