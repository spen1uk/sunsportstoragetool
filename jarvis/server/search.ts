import { type DB } from './db.ts';
import * as ex from './exclusions.ts';

/**
 * Universal search over what Jarvis holds for Luke. Plain word matching (every word must appear), no model, nothing leaves the machine.
 * Every result names where it came from and links to it. Anything matching an exclusion is left out. Imported chats are only included
 * on Luke's own search page, never in a chat reply (chat replies are stored and later shown to the model; imports are private).
 */
export type Hit = { kind: string; id: string; title: string; snippet: string; at: number | null; link: string; score: number };
export const LABELS: Record<string, string> = { memory: 'Memory', task: 'Tasks', research: 'Research', note: 'Notes', calendar: 'Calendar', decision: 'Decisions', knowledge: 'Knowledge', mission: 'Missions', person: 'People', project: 'Projects', report: 'Reports', brief: 'Claude Code briefs', chat: 'Conversations', import: 'Imported chats', gap: 'Improvements', goal: 'Goals' };

const esc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
export const terms = (q: string) => [...new Set(q.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((t) => t.length >= 2))].slice(0, 6);
const snip = (text: string, ts: string[]) => { const t = text.replace(/\s+/g, ' ').trim(); const l = t.toLowerCase(); const i = Math.min(...ts.map((x) => { const k = l.indexOf(x); return k < 0 ? 1e9 : k; })); const s = i > 1e8 ? 0 : Math.max(0, i - 50); return (s ? '…' : '') + t.slice(s, s + 170) + (t.length > s + 170 ? '…' : ''); };
const ms = (v: string | number | null) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v) || null);

type Src = { kind: string; sql: string; cols: string[]; title: string; body: string[]; id: string; at: string; link: (r: any) => string; where?: string };
const SOURCES: Src[] = [
  { kind: 'memory', sql: 'FROM memories WHERE superseded_by IS NULL AND status NOT IN (\'historical\',\'disproven\')', cols: ['content'], title: 'content', body: ['content'], id: 'id', at: 'created_at', link: () => '#/memory' },
  { kind: 'task', sql: "FROM tasks WHERE kind='manual' AND is_demo=0", cols: ['title', 'description'], title: 'title', body: ['description', 'title'], id: 'id', at: 'updated_at', link: () => '#/tasks' },
  { kind: 'research', sql: "FROM tasks WHERE kind='research' AND is_demo=0", cols: ['title', 'description'], title: 'title', body: ['description', 'title'], id: 'id', at: 'updated_at', link: (r) => `#/research/${r.id}` },
  { kind: 'research', sql: 'FROM evidence', cols: ['claim', 'cited_text', 'source_title'], title: 'claim', body: ['cited_text', 'claim'], id: 'task_id', at: 'retrieved_at', link: (r) => `#/research/${r.task_id}` },
  { kind: 'note', sql: 'FROM notes_cache', cols: ['title', 'body'], title: 'title', body: ['body', 'title'], id: 'id', at: 'modified_ms', link: () => '#/notes' },
  { kind: 'calendar', sql: 'FROM calendar_events', cols: ['title', 'location'], title: 'title', body: ['location', 'title'], id: 'uid', at: 'start_ms', link: () => '#/calendar' },
  { kind: 'decision', sql: 'FROM decisions', cols: ['title', 'context', 'chosen', 'rationale', 'outcome'], title: 'title', body: ['context', 'rationale', 'outcome', 'title'], id: 'id', at: 'updated_at', link: () => '#/knowledge' },
  { kind: 'knowledge', sql: "FROM entities WHERE kind NOT IN ('decision','mission','project','person','agent')", cols: ['name', 'aliases', 'notes'], title: 'name', body: ['notes', 'name'], id: 'id', at: 'updated_at', link: () => '#/knowledge' },
  { kind: 'mission', sql: 'FROM missions', cols: ['title', 'goal', 'report'], title: 'title', body: ['goal', 'title'], id: 'id', at: 'updated_at', link: () => '#/missions' },
  { kind: 'person', sql: 'FROM people', cols: ['name', 'relationship', 'notes'], title: 'name', body: ['notes', 'relationship', 'name'], id: 'id', at: 'created_at', link: () => '#/life' },
  { kind: 'project', sql: 'FROM projects WHERE is_demo=0', cols: ['title'], title: 'title', body: ['title'], id: 'id', at: 'created_at', link: () => '#/tasks' },
  { kind: 'report', sql: "FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.is_demo=0 AND a.status<>'deleted' AND v.version=a.current_version", cols: ['a.title', 'v.content'], title: 'a.title', body: ['v.content', 'a.title'], id: 'a.id', at: 'v.created_at', link: () => '#/review' },
  { kind: 'brief', sql: 'FROM briefs', cols: ['title', 'goal', 'context', 'result_note'], title: 'title', body: ['goal', 'context', 'title'], id: 'id', at: 'updated_at', link: () => '#/integrations' },
  { kind: 'chat', sql: 'FROM messages', cols: ['content'], title: 'content', body: ['content'], id: 'id', at: 'at', link: () => '#/command' },
  { kind: 'goal', sql: "FROM goals WHERE status<>'dropped'", cols: ['title', 'why', 'notes'], title: 'title', body: ['why', 'notes', 'title'], id: 'id', at: 'updated_at', link: () => '#/goals' },
  { kind: 'gap', sql: 'FROM gaps', cols: ['title', 'detail'], title: 'title', body: ['detail', 'title'], id: 'id', at: 'last_seen', link: () => '#/improve' },
  { kind: 'import', sql: 'FROM chat_import_messages m JOIN chat_imports c ON c.id=m.import_id', cols: ['c.title', 'm.text'], title: 'c.title', body: ['m.text', 'c.title'], id: 'c.id', at: 'c.imported_at', link: () => '#/integrations' },
];
const short = (c: string) => c.replace(/^[a-z]+\./, '');

export function search(db: DB, q: string, o: { includeImports?: boolean; kinds?: string[]; perKind?: number } = {}) {
  const ts = terms(q); const per = o.perKind ?? 6;
  if (!ts.length || ex.isExcluded(db, q)) return { query: q.trim(), terms: ts, total: 0, groups: [] as { kind: string; label: string; items: Hit[] }[], excluded: ex.isExcluded(db, q) };
  const hits: Hit[] = [];
  for (const s of SOURCES) {
    if (s.kind === 'import' && !o.includeImports) continue; if (o.kinds && !o.kinds.includes(s.kind)) continue;
    const hay = `(${s.cols.map((c) => `COALESCE(${c},'')`).join(" || ' ' || ")})`;
    const where = ts.map(() => `${hay} LIKE ? ESCAPE '\\'`).join(' AND ');
    const sel = [...new Set([s.title, ...s.body, s.id, s.at])].map((c, i) => `${c} AS c${i}`);
    const idx = (c: string) => [...new Set([s.title, ...s.body, s.id, s.at])].indexOf(c);
    let rows: any[] = []; try { rows = db.prepare(`SELECT ${sel.join(', ')} ${s.sql}${s.sql.includes(' WHERE ') ? ' AND ' : ' WHERE '}${where} ORDER BY ${s.at} DESC LIMIT 40`).all(...ts.map((t) => `%${esc(t)}%`)) as any[]; } catch { continue; }
    for (const r of rows) {
      const title = String(r[`c${idx(s.title)}`] ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), body = s.body.map((b) => String(r[`c${idx(b)}`] ?? '')).filter(Boolean).join(' ');
      const tl = title.toLowerCase(), score = ts.reduce((a, t) => a + (tl.includes(t) ? 3 : 0) + 1, 0);
      const id = String(r[`c${idx(s.id)}`]); const h: Hit = { kind: s.kind, id, title: title || '(untitled)', snippet: snip(body, ts), at: ms(r[`c${idx(s.at)}`]), link: s.link({ id, task_id: id }), score };
      if (!ex.isExcluded(db, `${h.title} ${h.snippet}`)) hits.push(h);
    }
  }
  const groups = new Map<string, Hit[]>();
  for (const h of hits.sort((a, b) => b.score - a.score || (b.at ?? 0) - (a.at ?? 0))) { const g = groups.get(h.kind) ?? []; if (g.length < per && !g.some((x) => x.id === h.id && x.title === h.title)) g.push(h); groups.set(h.kind, g); }
  const out = [...groups].map(([kind, items]) => ({ kind, label: LABELS[kind] ?? kind, items })).sort((a, b) => b.items[0].score - a.items[0].score);
  return { query: q.trim(), terms: ts, total: out.reduce((n, g) => n + g.items.length, 0), groups: out, excluded: false };
}
void short;

/** A short plain reply for chat. Imported chats are only counted, never quoted. */
export function describeForChat(db: DB, q: string): string {
  const r = search(db, q, { perKind: 3 }); if (r.excluded) return `You asked me never to keep anything about that, so I have nothing to show.`;
  if (!r.total) return `I couldn't find anything of yours about "${r.query}".`;
  const lines = r.groups.slice(0, 8).map((g) => { const h = g.items[0], more = g.items.length > 1 ? ` (+${g.items.length - 1} more)` : ''; const extra = h.snippet && !h.snippet.toLowerCase().includes(h.title.toLowerCase().slice(0, 40)) ? ` — ${h.snippet.slice(0, 100)}` : ''; return `- ${LABELS[g.kind] ?? g.kind}: ${h.title.slice(0, 80)}${extra}${more}`; });
  const imp = search(db, q, { kinds: ['import'], includeImports: true, perKind: 20 }).total;
  return `Here's what I found about "${r.query}" (${r.total} match${r.total === 1 ? '' : 'es'}):\n${lines.join('\n')}${imp ? `\nAlso ${imp} match${imp === 1 ? '' : 'es'} in chats you imported; open the Search page to see them.` : ''}`;
}
