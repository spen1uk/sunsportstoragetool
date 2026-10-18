/** Reads the OpenAI "Export data" file (conversations.json) or a pasted chat, in the browser, so a huge file never has to be uploaded whole. Pure: no network, no storage. */
export type Msg = { role: 'user' | 'assistant'; text: string };
export type Conv = { title: string; createdAt: number | null; messages: Msg[] };

const partText = (parts: unknown): string => (Array.isArray(parts) ? parts.filter((p) => typeof p === 'string').join('\n') : '').trim();

/** One conversation: follow the chosen branch (current_node) back to the root, so edited/regenerated answers don't duplicate. */
export function fromMapping(c: any): Conv | null {
  const map = c?.mapping; if (!map || typeof map !== 'object') return null;
  const chain: any[] = []; const seen = new Set<string>(); let node = typeof c.current_node === 'string' ? c.current_node : null;
  if (!node) { const leaves = Object.keys(map).filter((k) => !(map[k]?.children?.length)); node = leaves[0] ?? null; }
  while (node && map[node] && !seen.has(node)) { seen.add(node); chain.push(map[node]); node = map[node].parent; }
  const messages: Msg[] = [];
  for (const n of chain.reverse()) {
    const m = n?.message; const role = m?.author?.role; if (role !== 'user' && role !== 'assistant') continue;
    if (m?.metadata?.is_visually_hidden_from_conversation) continue;
    const text = partText(m?.content?.parts); if (text) messages.push({ role, text });
  }
  return { title: typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 200) : 'Untitled chat', createdAt: typeof c.create_time === 'number' ? Math.round(c.create_time * 1000) : null, messages };
}
export function parseExport(json: unknown): Conv[] {
  const arr = Array.isArray(json) ? json : [];
  return arr.map(fromMapping).filter((c): c is Conv => !!c && c.messages.length > 0);
}
/** Text copied out of the ChatGPT page ("You said:" / "ChatGPT said:") or written as "User:" / "Assistant:". */
export function parsePasted(text: string, title = 'Pasted chat'): Conv | null {
  const lines = text.replace(/\r/g, '').split('\n'); const messages: Msg[] = []; let role: Msg['role'] | null = null, buf: string[] = [];
  const flush = () => { const t = buf.join('\n').trim(); if (role && t) messages.push({ role, text: t }); buf = []; };
  for (const l of lines) {
    const m = l.match(/^\s*(You said|User|You|ChatGPT said|ChatGPT|Assistant)\s*:\s*(.*)$/i);
    if (m) { flush(); role = /^(you|user)/i.test(m[1]) ? 'user' : 'assistant'; if (m[2]) buf.push(m[2]); } else buf.push(l);
  }
  flush(); return messages.length ? { title, createdAt: null, messages } : null;
}
