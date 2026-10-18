import type { DB } from './db.ts';
import { now, getMeta, setMeta } from './db.ts';
import { handleChat, type ChatReply } from './chat.ts';
import { complete, ready, getConfig } from './llm/gateway.ts';
import { buildSystemPrompt } from './persona.ts';
import { buildContext } from './context.ts';
import { keywords } from './extract.ts';
import { publish } from './events.ts';
import type { ChatMessage } from './llm/types.ts';
import { extractProposals, createProposals } from './proposals.ts';
import { autoRun } from './standing.ts';
import { getDefaults } from './missionbudget.ts';
import { refresh as refreshWeather } from './weather.ts';
import { parseWebRequest, looksLikeWebQuestion, needsWebModel, asksForSources, lastSources, ask as askWeb, gate as webGate } from './websearch.ts';
import { startDeep } from './deepresearch.ts';
import { describe as knowDescribe } from './knowledge.ts';
import { mentions as chatMentions } from './chatimport.ts';
import { createAssigned, ASSIGNED_DEFAULT_CAP } from './missions.ts';

function relevantMemories(db: DB, text: string): string[] {
  const rows = new Map<string, string>();
  for (const k of keywords(text).slice(0, 6))
    for (const m of db.prepare("SELECT id, content FROM memories WHERE superseded_by IS NULL AND content LIKE ? ESCAPE '\\' LIMIT 3").all(`%${k.replace(/[\\%_]/g, '')}%`) as any[]) rows.set(m.id, m.content);
  for (const m of db.prepare('SELECT id, content FROM memories WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT 4').all() as any[]) rows.set(m.id, m.content);
  return [...rows.values()].slice(0, 8);
}

function history(db: DB): ChatMessage[] {
  const rows = db.prepare('SELECT role, content, web FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 12) ORDER BY id').all() as { role: 'luke' | 'jarvis'; content: string; web: number }[];
  // An earlier answer that came from the internet stays in history only as a clipped, labelled, unverified note (page text must not steer later private chats).
  const msgs: ChatMessage[] = rows.map((r) => ({ role: r.role === 'luke' ? 'user' : 'assistant', content: r.web && r.role === 'jarvis' ? `(Earlier answer from a web search, unverified:) ${r.content.split('\n\nFrom the internet')[0].slice(0, 500)}` : r.content }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();   // conversations must open with a user turn
  return msgs;
}

/**
 * Chat entry point. Deterministic commands always win (so "pause", "add task…" stay instant, free and exact).
 * Anything else goes to the model if one is configured and allowed; the model returns TEXT ONLY and has no tools,
 * so nothing it says can create, change, approve, send or spend anything. Prefix a message with "deep:" for the stronger model.
 */
export async function converse(db: DB, textIn: string, o: { private?: boolean; channel?: string; brief?: boolean; deviceId?: string } = {}): Promise<ChatReply> {
  const text = textIn.trim().slice(0, 2000), priv = !!o.private, cfg = getConfig(db);
  if (!priv && asksForSources(text)) {   // sources are shown only when he asks
    const reply = lastSources(db);
    db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', text, now(), o.channel ?? 'dashboard'); db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', reply, now(), o.channel ?? 'dashboard');
    return { text: reply, persisted: true, source: 'command', proposals: [] };
  }
  const knowQ = text.match(/^what (?:do|did|does) (?:you|we|jarvis) know about\s+(.{2,80}?)\s*[?.!]*$/i);
  if (knowQ && !priv && (o.channel ?? 'dashboard') !== 'sms') {   // deterministic: reads the knowledge graph, no model, nothing sent anywhere
    const said = chatMentions(db, knowQ[1]); const reply = knowDescribe(db, knowQ[1]) + (said.length ? `\nAlso in chats you imported and made searchable: ${said.join('; ')}.` : '');
    db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', text, now(), o.channel ?? 'dashboard'); db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', reply, now(), o.channel ?? 'dashboard');
    return { text: reply, persisted: true, source: 'command', proposals: [] };
  }
  const deepQ = text.match(/^(?:deep research|research deeply|prometheus)\s*:\s*(.{5,})$/is);
  if (deepQ && !priv && (o.channel ?? 'dashboard') !== 'sms') {   // hand a long question to Prometheus: queued, budget-capped, reviewed by Luke
    const why = webGate(db, { channel: o.channel ?? 'dashboard' });
    const reply = why ? why : `Understood, sir. I've asked Prometheus to research that. It runs in the background within a $${(getDefaults(db).deepMicro / 1e6).toFixed(2)} budget and I'll put the draft in Ready for Review when it's done.`;
    if (!why) startDeep(db, deepQ[1], 'deep');
    db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', text, now(), o.channel ?? 'dashboard'); db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', reply, now(), o.channel ?? 'dashboard'); publish({ type: 'chat' });
    return { text: reply, persisted: true, source: 'command', proposals: [] };
  }
  const missionQ = text.match(/^mission\s*:\s*(.{8,500})$/is);
  if (missionQ && !priv && (o.channel ?? 'dashboard') !== 'sms') {
    const gateMsg = webGate(db, { channel: o.channel ?? 'dashboard' }); let reply: string;
    if (gateMsg && /switched off/.test(gateMsg)) reply = gateMsg; else { createAssigned(db, { goal: missionQ[1] }); reply = `Understood, sir. Mission created: Prometheus will plan it in steps, within a $${(ASSIGNED_DEFAULT_CAP / 1e6).toFixed(2)} budget. Watch it on the Missions page; you can pause or stop it there.`; }
    db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', text, now(), o.channel ?? 'dashboard'); db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', reply, now(), o.channel ?? 'dashboard'); publish({ type: 'chat' });
    return { text: reply, persisted: true, source: 'command', proposals: [] };
  }
  if (!priv && /^(dig deeper|go deeper|research (this|that) properly)\b/i.test(text) && (o.channel ?? 'dashboard') !== 'sms') {
    const last = getMeta(db, 'web:last'); const why = webGate(db, { channel: o.channel ?? 'dashboard' });
    const reply = !last ? "There's nothing to dig into yet, sir. Ask me something that needs the internet first." : why ? why : (startDeep(db, last, 'deep'), `Understood, sir. I've handed that to Prometheus for a proper look: "${last.slice(0, 80)}". The results will be on its page when it's done.`);
    db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', text, now(), o.channel ?? 'dashboard'); db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', reply, now(), o.channel ?? 'dashboard'); publish({ type: 'chat' });
    return { text: reply, persisted: true, source: 'command', proposals: [] };
  }
  const webQ = parseWebRequest(text);
  if (webQ) return await webTurn(db, text, webQ, { private: priv, channel: o.channel, brief: o.brief, deviceId: o.deviceId });
  const modelOk = ready(db, 'chat') && (!priv || cfg.allowInPrivate);
  const cmd = handleChat(db, text, { private: priv, deferFallback: modelOk, channel: o.channel });
  if (!cmd.fallback) return { ...cmd, source: 'command' };
  if (!priv && (o.channel ?? 'dashboard') !== 'sms' && !webGate(db, { channel: o.channel ?? 'dashboard' }) && (looksLikeWebQuestion(text) || await needsWebModel(db, text)))   // everyday questions that need the internet just go there; if search is off or at its limit, fall through to a normal chat
    return await webTurn(db, text, text, { private: priv, channel: o.channel, brief: o.brief, deviceId: o.deviceId });

  const strong = /^deep:\s*/i.test(text); const prompt = text.replace(/^deep:\s*/i, '');
  const messages: ChatMessage[] = [...(priv ? [] : history(db)), { role: 'user', content: prompt }];
  publish({ type: 'thinking', on: true });
  try {
    if (!priv) await refreshWeather(db);   // no-op unless weather is on and the saved reading is over 15 minutes old; never throws
    const r = await complete(db, { task: 'chat', system: buildSystemPrompt(db, { memories: priv ? [] : relevantMemories(db, prompt), context: priv ? undefined : buildContext(db, Date.now(), o.channel ?? 'dashboard'), proposals: !priv, brief: o.brief }), messages, strong, channel: o.channel ?? 'dashboard', deviceId: o.deviceId });
    const raw = r.ok ? r.text.trim() || '…' : `I couldn't reach a language model just now, sir (${r.error}). Command mode is still available: type "help".`;
    // The model may PROPOSE actions; they become Confirm cards and do nothing until Luke clicks. In private mode nothing is stored, so proposals are dropped.
    const ex = r.ok ? extractProposals(raw) : { text: raw, actions: [], dropped: 0 };
    let reply = ex.text; const created = r.ok && !priv ? createProposals(db, ex.actions) : [];
    // A standing permission Luke granted (dashboard + step-up) may run a few narrow, undoable kinds without a click. Everything else still waits.
    const auto = autoRun(db, created, o.channel ?? 'dashboard'), proposals = auto.waiting;
    if (auto.done.length) reply += '\n\n' + auto.done.map((d) => `✓ Done under your standing permission: ${d.summary}`).join('\n');
    if (!priv) {
      db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('luke', text, now(), o.channel ?? 'dashboard');
      db.prepare('INSERT INTO messages(role,content,at,channel) VALUES(?,?,?,?)').run('jarvis', reply, now(), o.channel ?? 'dashboard');
      publish({ type: 'chat' });
    }
    return { text: reply, persisted: !priv, source: r.ok ? 'model' : 'command', model: r.ok ? r.model : undefined, costMicroUsd: r.ok ? r.costMicroUsd : 0, proposals };
  } finally { publish({ type: 'thinking', on: false }); }
}


/** A deliberate "search: …" turn: walled off from private data and from actions (see websearch.ts). */
async function webTurn(db: DB, text: string, query: string, o: { private: boolean; channel?: string; brief?: boolean; deviceId?: string }): Promise<ChatReply> {
  const channel = o.channel ?? 'dashboard';
  publish({ type: 'thinking', on: true });
  try {
    if (query.length >= 5) setMeta(db, 'web:last', query.slice(0, 400));
    const r = await askWeb(db, query, { channel, deviceId: o.deviceId, brief: o.brief, private: o.private });
    if (!o.private) {
      db.prepare('INSERT INTO messages(role,content,at,channel,web) VALUES(?,?,?,?,0)').run('luke', text, now(), channel);
      db.prepare('INSERT INTO messages(role,content,at,channel,web) VALUES(?,?,?,?,?)').run('jarvis', r.text, now(), channel, r.ok ? 1 : 0);
      publish({ type: 'chat' });
    }
    return { text: r.text, persisted: !o.private, source: r.ok ? 'model' : 'command', model: r.ok ? r.model : undefined, costMicroUsd: r.ok ? r.costMicroUsd : 0, proposals: [] };
  } finally { publish({ type: 'thinking', on: false }); }
}
