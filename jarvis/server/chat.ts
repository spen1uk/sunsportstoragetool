import type { DB } from './db.ts';
import { now } from './db.ts';
import { createTask, completeTask } from './tasks.ts';
import * as memory from './memory.ts';
import { researchInput } from './research.ts';
import { setPaused, pauseStatus } from './pause.ts';
import { publish } from './events.ts';

export type ChatReply = { text: string; action?: { navigate?: string }; persisted: boolean };

const NAV: [RegExp, string][] = [
  [/(go back to|back to|return to) the universe|^universe$/i, '#/universe'],
  [/(open|show( me)?|bring up) sun sport marine/i, '#/system/ssm'],
  [/(show( me)?|open) sales/i, '#/dept/ssm-sales'],
  [/(bring up|show|open) (my )?projects/i, '#/tasks'],
  [/(show|open) (my )?(approvals?)/i, '#/approvals'],
  [/(show|open) (the )?(review|ready for review)/i, '#/review'],
];

/**
 * Command mode: deterministic intent handling. NO language model is connected yet, and Jarvis says so rather than improvising.
 * Voice navigation is navigation only — nothing here approves a protected action.
 */
export function handleChat(db: DB, textIn: string, o: { private?: boolean } = {}): ChatReply {
  const text = textIn.trim().slice(0, 2000);
  const priv = !!o.private;
  const persistTurn = (reply: string) => {
    if (priv) return;
    db.prepare('INSERT INTO messages(role,content,at) VALUES(?,?,?)').run('luke', text, now());
    db.prepare('INSERT INTO messages(role,content,at) VALUES(?,?,?)').run('jarvis', reply, now());
    publish({ type: 'chat' });
  };
  const reply = (r: string, extra: Partial<ChatReply> = {}): ChatReply => { persistTurn(r); return { text: r, persisted: !priv, ...extra }; };

  for (const [re, hash] of NAV) if (re.test(text)) return reply('Certainly, sir.', { action: { navigate: hash } });

  let m: RegExpMatchArray | null;
  if ((m = text.match(/^(?:research|look into|investigate)\s+(.+?)\s+(?:from|using|at)\s+(https?:\/\/\S.*)$/i))) {
    if (priv) return reply('Private mode does not create records, sir. Leave private mode and ask again.');
    const urls = m[2].split(/[\s,]+/).filter(Boolean);
    const parsed = researchInput.safeParse({ question: m[1], urls });
    if (!parsed.success) return reply('I need a question of at least a few words and up to eight valid URLs, sir.');
    const tid = createTask(db, { title: `Research: ${parsed.data.question.slice(0, 80)}`, kind: 'research', priority: 2, input: parsed.data });
    return reply(`Understood, sir. Research task queued (${tid.slice(0, 8)}). If any source domain is not yet on the allow-list I will ask for your approval before fetching.`);
  }
  if ((m = text.match(/^(?:add task|new task|task:)\s+(.+)$/i))) {
    if (priv) return reply('Private mode does not create records, sir.');
    createTask(db, { title: m[1], kind: 'manual' });
    return reply(`Added: "${m[1].slice(0, 100)}".`);
  }
  if ((m = text.match(/^(?:complete|done with|finish|check off)\s+(?:task\s+)?(.+)$/i))) {
    const hits = db.prepare("SELECT id,title FROM tasks WHERE kind='manual' AND state NOT IN ('completed','canceled') AND is_demo=0 AND lower(title) LIKE ? ESCAPE '\\'")
      .all(`%${m[1].toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`) as { id: string; title: string }[];
    if (hits.length === 0) return reply(`I can't find an open task matching "${m[1]}", sir.`);
    if (hits.length > 1) return reply(`That matches ${hits.length} tasks: ${hits.map((h) => `"${h.title}"`).join('; ')}. Which did you mean?`);
    if (priv) return reply('Private mode does not modify records, sir.');
    completeTask(db, hits[0].id, 'luke', 'stated complete in chat');
    return reply(`Marked "${hits[0].title}" complete.`);
  }
  if ((m = text.match(/^remember(?: that)?\s+(.+)$/i))) {
    if (priv) return reply('Private mode does not write memory, sir.');
    const r = memory.remember(db, m[1], { source: 'chat' });
    return reply(r.ok ? 'Noted, sir. You can review or correct it on the Memory page.' : r.error);
  }
  if ((m = text.match(/^forget\s+(.+)$/i))) {
    if (priv) return reply('Private mode does not modify memory, sir.');
    const hits = memory.search(db, m[1]) as { id: string; content: string }[];
    if (hits.length === 0) return reply('Nothing matching that in memory, sir.');
    if (hits.length > 1) return reply(`${hits.length} memories match; please remove the one you mean from the Memory page.`);
    memory.forget(db, hits[0].id);
    return reply(`Forgotten: "${hits[0].content.slice(0, 80)}".`);
  }
  if (/^pause( jarvis)?$/i.test(text)) { setPaused(db, true); const p = pauseStatus(db); return reply(`Paused. No new automated work will start. ${p.inflight} task(s) already in flight cannot be recalled instantly.`); }
  if (/^resume( jarvis)?$/i.test(text)) { setPaused(db, false); return reply('Resumed, sir.'); }
  if (/^(status|what'?s pending|what is pending)\??$/i.test(text)) {
    const c = (s: string) => (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE ${s}`).get() as { c: number }).c;
    const ap = (db.prepare("SELECT COUNT(*) c FROM approvals WHERE status='pending'").get() as { c: number }).c;
    return reply(`${c("state='ready' OR state='running'")} task(s) active, ${c("state='waiting_input'")} awaiting you, ${ap} approval(s) pending.`);
  }
  return reply(
    "I'm in command mode, sir — no language model is connected yet, so I won't pretend to reason. I can: \"research <question> from <https url>\", \"add task …\", \"complete …\", \"remember …\", \"forget …\", \"status\", \"pause\"/\"resume\", and navigate (\"open Sun Sport Marine\", \"show me Sales\", \"bring up my projects\").");
}
