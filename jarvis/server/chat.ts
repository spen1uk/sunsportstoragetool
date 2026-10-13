import type { DB } from './db.ts';
import { now } from './db.ts';
import { createTask, completeTask } from './tasks.ts';
import * as memory from './memory.ts';
import { researchInput } from './research.ts';
import { setPaused, pauseStatus } from './pause.ts';
import { publish } from './events.ts';
import { upcoming, syncState } from './calendar.ts';
import { listNotes } from './notes.ts';
import { findHabit, findPerson, toggleHabit, markContacted, findGoal, logLearning } from './life.ts';
import { chicagoParts, chicagoInstant, addDays } from './tz.ts';

export type ChatReply = { text: string; action?: { navigate?: string }; persisted: boolean; fallback?: boolean; source?: 'command' | 'model'; model?: string; costMicroUsd?: number };

const NAV: [RegExp, string][] = [
  [/(go (back )?to|back to|open|show( me)?|return to) (the )?(command center|jarvis( home)?|home)\b/i, '#/command'],
  [/(open|show( me)?|go to|bring up) (the )?(agent )?universe\b/i, '#/universe'],
  [/(open|show( me)?|bring up) sun sport marine/i, '#/system/ssm'],
  [/(show( me)?|open) sales/i, '#/dept/ssm-sales'],
  [/(bring up|show|open) (my )?projects/i, '#/tasks'],
  [/(show|open) (my )?(approvals?)/i, '#/approvals'],
  [/(show|open) (the )?(review|ready for review)/i, '#/review'],
  [/(show|open|bring up) (my )?(calendar|schedule)\b/i, '#/calendar'],
  [/(show|open|bring up) (my )?notes\b/i, '#/notes'],
  [/(show|open|bring up) (my )?(life|habits|people)\b/i, '#/life'],
  [/(show|open|bring up) (my |the )?workspace\b/i, '#/workspace'],
];

/**
 * Command mode: deterministic intent handling. NO language model is connected yet, and Jarvis says so rather than improvising.
 * Voice navigation is navigation only — nothing here approves a protected action.
 */
export function handleChat(db: DB, textIn: string, o: { private?: boolean; deferFallback?: boolean } = {}): ChatReply {
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
  if ((m = text.match(/^(?:what(?:'s| is)(?: on)? (?:my )?(?:calendar|schedule|agenda)|what do i have|what(?:'s| is) next|what(?:'s| is) on (?:today|tomorrow)|my (?:calendar|schedule|agenda))(?:\s+(today|tomorrow))?[?.! ]*$/i)) || /^what do i have (today|tomorrow)[?.! ]*$/i.test(text)) {
    const cs = syncState(db, 'calendar');
    if (cs.status === 'planned' || cs.status === 'disconnected') return reply('Your calendar is not connected yet, sir. Choose which calendars I may read on the Calendar page (it reads from this Mac only).');
    const tomorrow = /tomorrow/i.test(text), t0 = Date.now(), p0 = chicagoParts(t0);
    const dayStart = (n: number) => { const a = addDays(p0.y, p0.m, p0.d, n); return chicagoInstant(a.y, a.m, a.d, 0, 0); };   // Chicago midnight, DST-safe
    const from = /next/i.test(text) ? t0 : tomorrow ? dayStart(1) : dayStart(0), to = /next/i.test(text) ? t0 + 3 * 86_400_000 : from + 86_400_000;
    const ev = upcoming(db, from, to).filter((e) => e.end >= t0).slice(0, 10);
    const fmt = (e: any) => `${e.allDay ? 'all day' : new Date(e.start).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} — ${e.title}`;
    const stale = cs.status === 'stale' ? ' (My copy is stale, so this may be out of date; recurring events can be missing.)' : ' (Unusual repeat patterns can be missing from my copy.)';
    return reply(ev.length ? `${/next/i.test(text) ? 'Coming up' : tomorrow ? 'Tomorrow' : 'Today'}, sir:\n${ev.map(fmt).join('\n')}${stale}` : `Nothing on the calendar ${/next/i.test(text) ? 'in the next three days' : tomorrow ? 'tomorrow' : 'for the rest of today'}, sir.${stale}`);
  }
  if ((m = text.match(/^(?:i )?(?:did|logged|log|worked out|went to)\s+(?:my\s+)?(.+?)(?:\s+today)?[.!]*$/i))) {
    const h = findHabit(db, m[1]);
    if (h) {   // only when the sentence clearly names exactly one of Luke's habits; otherwise it falls through to normal chat
      if (priv) return reply('Private mode does not modify records, sir.');
      if (h.doneToday) return reply(`"${h.name}" is already checked off today, sir. ${h.streak} day streak.`);
      toggleHabit(db, h.id); return reply(`Logged "${h.name}" for today, sir. ${h.streak + 1} day streak.`);
    }
    const g = findGoal(db, m[1].replace(/^(?:a|an|one|1)\s+/i, ''));
    if (g) { if (priv) return reply('Private mode does not modify records, sir.'); logLearning(db, g.id, 1); return reply(`Logged one ${g.unit.replace(/s$/, '')} toward "${g.name}", sir: ${g.weekTotal + 1} of ${g.perWeek} this week.`); }
  }
  if ((m = text.match(/^(?:i )?(?:talked to|spoke (?:to|with)|called|texted|contacted|caught up with)\s+(.+?)[.!]*$/i))) {
    const pr = findPerson(db, m[1]);
    if (pr) { if (priv) return reply('Private mode does not modify records, sir.'); markContacted(db, pr.id); return reply(`Noted, sir: you were in touch with ${pr.name} today.`); }
  }
  if ((m = text.match(/^(?:search|find)(?: my)? notes?(?: for| about)?\s+(.+)$/i))) {
    const ns = syncState(db, 'notes');
    if (ns.status === 'planned' || ns.status === 'disconnected') return { text: 'Notes are not connected yet, sir. Choose a folder on the Notes page.', persisted: false };
    const hits = listNotes(db, m[1], 6);
    // Note contents are never put into chat history (history can reach the language model); titles only, shown here, not saved.
    return { text: hits.length ? `${hits.length === 6 ? 'At least 6' : hits.length} note(s) match, sir: ${hits.map((h) => `"${h.title}"`).join('; ')}. Open the Notes page to read them. (I keep note text out of our chat history and never send it to the language model.)` : 'Nothing in your connected Notes folders matches that, sir.', persisted: false };
  }
  if (/^pause( jarvis)?$/i.test(text)) { setPaused(db, true); const p = pauseStatus(db); return reply(`Paused. No new automated work will start. ${p.inflight} task(s) already in flight cannot be recalled instantly.`); }
  if (/^resume( jarvis)?$/i.test(text)) { setPaused(db, false); return reply('Resumed, sir.'); }
  if (/^(status|what'?s pending|what is pending)\??$/i.test(text)) {
    const c = (s: string) => (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE ${s}`).get() as { c: number }).c;
    const ap = (db.prepare("SELECT COUNT(*) c FROM approvals WHERE status='pending'").get() as { c: number }).c;
    return reply(`${c("state='ready' OR state='running'")} task(s) active, ${c("state='waiting_input'")} awaiting you, ${ap} approval(s) pending.`);
  }
  if (o.deferFallback) return { text: '', persisted: false, fallback: true }; // not a command: caller may hand it to the model
  return reply(
    "I'm in command mode, sir — no language model is connected yet, so I won't pretend to reason. I can: \"research <question> from <https url>\", \"add task …\", \"complete …\", \"remember …\", \"forget …\", \"status\", \"pause\"/\"resume\", and navigate (\"open Sun Sport Marine\", \"show me Sales\", \"bring up my projects\").");
}
