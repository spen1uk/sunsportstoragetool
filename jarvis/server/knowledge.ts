import crypto from 'node:crypto';
import { z } from 'zod';
import { type DB, id, getMeta, setMeta, tx } from './db.ts';
/** Like tx, but joins a transaction already open (refresh/forget are called from inside others). */
const atomic = <T,>(db: DB, fn: () => T): T => (db.isTransaction ? fn() : tx(db, fn));
import { audit } from './audit.ts';
import { publish } from './events.ts';
import * as ex from './exclusions.ts';
import * as memory from './memory.ts';

export const KINDS = ['person', 'business', 'agent', 'project', 'goal', 'decision', 'file', 'topic', 'place', 'source', 'mission'] as const;
export const RELS = ['works_with', 'owns', 'part_of', 'related_to', 'decided_by', 'affects', 'depends_on', 'mentions', 'supports', 'contradicts', 'cites', 'about'] as const;
export const SCOPES = ['personal', 'business', 'public'] as const;
const ORIGINS = ['luke', 'derived', 'prometheus', 'chat'] as const;
const LINK_KINDS = ['memory', 'task', 'project', 'artifact', 'research', 'person', 'goal', 'mission', 'decision'] as const;

export type Entity = { id: string; kind: string; name: string; aliases: string[]; notes: string; scope: string; confidence: number; origin: string; source_ref: string | null; created_at: number; updated_at: number };
const hydrate = (r: any): Entity => ({ ...r, aliases: JSON.parse(r.aliases) });
const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const entityIn = z.object({
  kind: z.enum(KINDS), name: z.string().min(2).max(80), aliases: z.array(z.string().min(2).max(60)).max(8).default([]),
  notes: z.string().max(1000).default(''), scope: z.enum(SCOPES).default('personal'),
}).strict();
const entityPatch = z.object(Object.fromEntries(Object.entries(entityIn.shape).map(([k, v]) => [k, v instanceof z.ZodDefault ? v.unwrap() : v]))).partial().strict();   // defaults must not apply to a patch

function textOf(e: { name: string; aliases?: string[]; notes?: string }) { return [e.name, ...(e.aliases ?? []), e.notes ?? ''].join(' '); }

export function createEntity(db: DB, input: unknown, origin: (typeof ORIGINS)[number] = 'luke', sourceRef: string | null = null, confidence = 0.9): Entity {
  const v = entityIn.parse(input);
  if (ex.isExcluded(db, textOf(v))) throw new Error('That mentions something you asked me never to store.');
  const eid = id(), t = Date.now();
  db.prepare('INSERT INTO entities(id,kind,name,aliases,notes,scope,confidence,origin,source_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(eid, v.kind, clean(v.name, 80), JSON.stringify(v.aliases.map((a) => clean(a, 60))), v.notes, v.scope, confidence, origin, sourceRef, t, t);
  audit(db, origin === 'luke' ? 'luke' : 'system', 'knowledge.entity.created', eid, { kind: v.kind, origin });
  publish({ type: 'knowledge' }); return getEntity(db, eid)!;
}
export const getEntity = (db: DB, eid: string): Entity | null => { const r = db.prepare('SELECT * FROM entities WHERE id=?').get(eid); return r ? hydrate(r) : null; };
export const listEntities = (db: DB, kind?: string) => (db.prepare(kind ? 'SELECT * FROM entities WHERE kind=? ORDER BY lower(name)' : 'SELECT * FROM entities ORDER BY kind, lower(name)').all(...(kind ? [kind] : [])) as any[]).map(hydrate);

export function updateEntity(db: DB, eid: string, patch: unknown): Entity {
  const old = getEntity(db, eid); if (!old) throw new Error('not found');
  const p = entityPatch.parse(patch), next = { ...old, ...p };
  if (ex.isExcluded(db, textOf(next))) throw new Error('That mentions something you asked me never to store.');
  db.prepare('UPDATE entities SET kind=?, name=?, aliases=?, notes=?, scope=?, updated_at=?, origin=CASE WHEN origin=\'derived\' THEN \'luke\' ELSE origin END WHERE id=?')
    .run(next.kind, clean(next.name, 80), JSON.stringify(next.aliases), next.notes, next.scope, Date.now(), eid);   // an edited derived record becomes Luke's own and is no longer overwritten
  audit(db, 'luke', 'knowledge.entity.updated', eid, { before: { name: old.name, kind: old.kind, scope: old.scope }, after: { name: next.name, kind: next.kind, scope: next.scope } });
  publish({ type: 'knowledge' }); return getEntity(db, eid)!;
}

export function addEdge(db: DB, from: string, to: string, rel: string, o: { note?: string; origin?: (typeof ORIGINS)[number]; confidence?: number } = {}) {
  const v = z.object({ from: z.string().min(1), to: z.string().min(1), rel: z.enum(RELS), note: z.string().max(200).default('') }).parse({ from, to, rel, note: o.note ?? '' });
  if (v.from === v.to) throw new Error('A record cannot be linked to itself.');
  if (!getEntity(db, v.from) || !getEntity(db, v.to)) throw new Error('not found');
  if (ex.isExcluded(db, v.note)) throw new Error('That mentions something you asked me never to store.');
  const eid = id();
  const r = db.prepare('INSERT OR IGNORE INTO edges(id,from_id,to_id,rel,note,confidence,origin,created_at) VALUES(?,?,?,?,?,?,?,?)').run(eid, v.from, v.to, v.rel, v.note, o.confidence ?? 0.9, o.origin ?? 'luke', Date.now());
  if (r.changes && (o.origin ?? 'luke') === 'luke') audit(db, 'luke', 'knowledge.edge.created', eid, { rel: v.rel });
  publish({ type: 'knowledge' }); return { ok: true, created: r.changes > 0 };
}
export function removeEdge(db: DB, eid: string) { const r = db.prepare('DELETE FROM edges WHERE id=?').run(eid); if (r.changes) { audit(db, 'luke', 'knowledge.edge.removed', eid); publish({ type: 'knowledge' }); } return r.changes > 0; }
export function linkRecord(db: DB, entityId: string, kind: (typeof LINK_KINDS)[number], refId: string, origin = 'luke') {
  if (!LINK_KINDS.includes(kind)) throw new Error('unknown record kind');
  db.prepare('INSERT OR IGNORE INTO entity_links(entity_id,kind,ref_id,origin,created_at) VALUES(?,?,?,?,?)').run(entityId, kind, refId, origin, Date.now());
}

// ---------- suppression of derived records Luke has forgotten ----------
const suppressed = (db: DB): string[] => { try { return JSON.parse(getMeta(db, 'knowledge:suppressed') ?? '[]'); } catch { return []; } };

/** Remove an entity and everything hanging off it (edges, links). With alsoMemories, the memories linked to it are forgotten too. */
export function forgetEntity(db: DB, eid: string, o: { alsoMemories?: boolean } = {}) {
  const e = getEntity(db, eid); if (!e) return { ok: false as const, error: 'not found' };
  return atomic(db, () => {
    const mems = (db.prepare("SELECT ref_id FROM entity_links WHERE entity_id=? AND kind='memory'").all(eid) as { ref_id: string }[]).map((r) => r.ref_id);
    if (e.kind === 'decision') db.prepare('DELETE FROM decisions WHERE entity_id=?').run(eid);
    db.prepare('DELETE FROM entities WHERE id=?').run(eid);   // edges and links go with it (ON DELETE CASCADE)
    if (e.source_ref) setMeta(db, 'knowledge:suppressed', JSON.stringify([...new Set([...suppressed(db), e.source_ref])].slice(-500)));
    let forgotten = 0;
    if (o.alsoMemories) for (const m of mems) if (memory.forget(db, m)) forgotten++;
    audit(db, 'luke', 'knowledge.entity.forgotten', eid, { kind: e.kind, memories: forgotten });
    publish({ type: 'knowledge' });
    return { ok: true as const, memoriesForgotten: forgotten };
  });
}

// ---------- exclusions ----------
/** Adding an exclusion also removes anything already stored that matches it (entities, edge notes); memories are counted for Luke to decide. */
export function applyExclusion(db: DB, pattern: string, note = '') {
  const r = ex.add(db, pattern, note); if (!r.ok) return r;
  let removed = 0;
  for (const e of listEntities(db)) if (ex.isExcluded(db, textOf(e))) { forgetEntity(db, e.id); removed++; }
  db.prepare('SELECT id,note FROM edges').all().forEach((e: any) => { if (ex.isExcluded(db, e.note)) db.prepare('DELETE FROM edges WHERE id=?').run(e.id); });
  const mems = (db.prepare('SELECT id,content FROM memories WHERE superseded_by IS NULL AND status NOT IN (\'historical\',\'disproven\')').all() as { id: string; content: string }[]).filter((m) => m.content.toLowerCase().includes(pattern.trim().toLowerCase())).length;
  return { ok: true as const, id: r.id, entitiesRemoved: removed, memoriesMatching: mems };
}

// ---------- derivation: build the graph from what Jarvis already knows, deterministically (no model) ----------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (n: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(n)}($|[^\\p{L}\\p{N}])`, 'iu');

function upsertDerived(db: DB, kind: string, name: string, ref: string, notes: string, scope = 'personal') {
  if (suppressed(db).includes(ref) || ex.isExcluded(db, `${name} ${notes}`)) return null;
  const cur = db.prepare('SELECT * FROM entities WHERE source_ref=?').get(ref) as any;
  if (cur) { if (cur.origin === 'derived') db.prepare('UPDATE entities SET name=?, notes=?, scope=?, updated_at=? WHERE id=?').run(clean(name, 80), notes.slice(0, 1000), scope, Date.now(), cur.id); return cur.id as string; }
  const dupe = db.prepare('SELECT id FROM entities WHERE kind=? AND lower(name)=lower(?)').get(kind, clean(name, 80)) as { id: string } | undefined;
  if (dupe) return dupe.id;
  try { return createEntity(db, { kind, name, notes, scope }, 'derived', ref, 0.8).id; } catch { return null; }
}

export function refresh(db: DB) {
  return atomic(db, () => {
    const keep = new Set<string>();
    const note = (ref: string | null) => { if (ref) keep.add(ref); };
    const ids: Record<string, string> = {};
    const push = (ref: string, kind: string, name: string, notes: string, scope?: string) => { const eid = upsertDerived(db, kind, name, ref, notes, scope); if (eid) { ids[ref] = eid; note(ref); } };
    for (const p of db.prepare('SELECT id,title,status,scope FROM projects WHERE is_demo=0').all() as any[]) push(`project:${p.id}`, 'project', p.title, `Project (${p.status}).`, p.scope === 'business' ? 'business' : 'personal');
    for (const p of db.prepare('SELECT id,name,relationship,notes FROM people').all() as any[]) push(`person:${p.id}`, 'person', p.name, [p.relationship, p.notes].filter(Boolean).join('. '));
    for (const g of db.prepare('SELECT id,name,unit,per_week FROM learning_goals WHERE archived=0').all() as any[]) push(`goal:${g.id}`, 'goal', g.name, `Learning goal: ${g.per_week} ${g.unit} a week.`);
    for (const g of db.prepare("SELECT id,title,why,status FROM goals WHERE status<>'dropped'").all() as any[]) push(`ggoal:${g.id}`, 'goal', g.title, `Goal (${g.status}). ${g.why}`.trim());
    for (const a of db.prepare('SELECT id,name,role,description FROM agents').all() as any[]) push(`agent:${a.id}`, 'agent', a.name, `${a.role}. ${a.description}`.trim());
    for (const m of db.prepare("SELECT id,title,status FROM missions WHERE kind='assigned' OR status IN ('active','done')").all() as any[]) push(`mission:${m.id}`, 'mission', m.title, `Research mission (${m.status}).`);
    for (const a of db.prepare('SELECT id,parent_id FROM agents WHERE parent_id IS NOT NULL').all() as any[]) {
      const f = ids[`agent:${a.id}`], t = ids[`agent:${a.parent_id}`]; if (f && t && f !== t) db.prepare('INSERT OR IGNORE INTO edges(id,from_id,to_id,rel,note,confidence,origin,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id(), f, t, 'part_of', '', 0.95, 'derived', Date.now());
    }
    // purge derived entities whose source no longer exists (or was excluded since)
    let purged = 0;
    for (const e of db.prepare("SELECT id,source_ref FROM entities WHERE origin='derived' AND source_ref IS NOT NULL").all() as any[]) {
      if (!keep.has(e.source_ref)) { db.prepare('DELETE FROM entities WHERE id=?').run(e.id); purged++; }
    }
    // rebuild derived links and co-mention edges from scratch so nothing stale survives
    db.prepare("DELETE FROM entity_links WHERE origin='derived'").run();
    db.prepare("DELETE FROM edges WHERE origin='derived' AND rel IN ('related_to','mentions')").run();
    const ents = listEntities(db).filter((e) => e.name.length >= 3 && !['agent', 'mission', 'source', 'file', 'decision'].includes(e.kind));   // agent names like "Research" are common words; they are not matched against free text
    const pats = ents.map((e) => ({ e, res: [e.name, ...e.aliases].filter((n) => n.length >= 3).map(wordRe) }));
    const mems = db.prepare('SELECT id,content FROM memories WHERE superseded_by IS NULL AND status NOT IN (\'historical\',\'disproven\')').all() as { id: string; content: string }[];
    const tasks = db.prepare("SELECT id,title,description FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state NOT IN ('completed','canceled')").all() as { id: string; title: string; description: string }[];
    const ins = db.prepare("INSERT OR IGNORE INTO entity_links(entity_id,kind,ref_id,origin,created_at) VALUES(?,?,?,'derived',?)");
    const pairs = new Map<string, number>(); let links = 0;
    const scan = (kind: 'memory' | 'task', rid: string, text: string) => {
      if (ex.isExcluded(db, text)) return;
      const hit = pats.filter((p) => p.res.some((r) => r.test(text))).map((p) => p.e.id);
      for (const h of hit) { ins.run(h, kind, rid, Date.now()); links++; }
      if (kind === 'memory') for (let i = 0; i < hit.length; i++) for (let j = i + 1; j < hit.length; j++) { const k = [hit[i], hit[j]].sort().join('|'); pairs.set(k, (pairs.get(k) ?? 0) + 1); }
    };
    for (const m of mems) scan('memory', m.id, m.content);
    for (const t of tasks) scan('task', t.id, `${t.title} ${t.description}`);
    let edgesMade = 0;
    for (const [k, n] of pairs) { const [a, b] = k.split('|'); const r = db.prepare('INSERT OR IGNORE INTO edges(id,from_id,to_id,rel,note,confidence,origin,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id(), a, b, 'related_to', `mentioned together in ${n} memor${n === 1 ? 'y' : 'ies'}`, Math.min(0.6, 0.3 + 0.1 * n), 'derived', Date.now()); edgesMade += Number(r.changes); }
    audit(db, 'system', 'knowledge.refreshed', '', { entities: ents.length, links, purged });
    publish({ type: 'knowledge' });
    return { entities: ents.length, links, edges: edgesMade, purged };
  });
}

// ---------- "what do we know about X" ----------
type Rec = { kind: string; id: string; text: string };
function resolveLink(db: DB, kind: string, rid: string): Rec | null {
  const q = (sql: string) => db.prepare(sql).get(rid) as any;
  const r = kind === 'memory' ? q('SELECT content AS t FROM memories WHERE id=?')
    : kind === 'task' || kind === 'research' ? q('SELECT title AS t FROM tasks WHERE id=?')
    : kind === 'project' ? q('SELECT title AS t FROM projects WHERE id=?')
    : kind === 'person' ? q('SELECT name AS t FROM people WHERE id=?')
    : kind === 'mission' ? q('SELECT title AS t FROM missions WHERE id=?')
    : kind === 'decision' ? q('SELECT title AS t FROM decisions WHERE id=?')
    : kind === 'artifact' ? q('SELECT title AS t FROM artifacts WHERE id=?') : null;
  return r ? { kind, id: rid, text: String(r.t).slice(0, 300) } : null;
}
export function neighborhood(db: DB, eid: string) {
  const e = getEntity(db, eid); if (!e) return null;
  const out = (db.prepare('SELECT e.*, g.id AS edge, g.rel AS g_rel, g.note AS g_note, g.confidence AS g_conf, g.origin AS g_origin FROM edges g JOIN entities e ON e.id=g.to_id WHERE g.from_id=?').all(eid) as any[]).map((r) => ({ direction: 'out' as const, edge: r.edge, rel: r.g_rel, note: r.g_note, confidence: r.g_conf, origin: r.g_origin, entity: hydrate(r) }));
  const inn = (db.prepare('SELECT e.*, g.id AS edge, g.rel AS g_rel, g.note AS g_note, g.confidence AS g_conf, g.origin AS g_origin FROM edges g JOIN entities e ON e.id=g.from_id WHERE g.to_id=?').all(eid) as any[]).map((r) => ({ direction: 'in' as const, edge: r.edge, rel: r.g_rel, note: r.g_note, confidence: r.g_conf, origin: r.g_origin, entity: hydrate(r) }));
  const records = ex.filterOut(db, (db.prepare('SELECT kind,ref_id FROM entity_links WHERE entity_id=?').all(eid) as any[]).map((l) => resolveLink(db, l.kind, l.ref_id)).filter((x): x is Rec => !!x), (r) => r.text);
  return { entity: e, edges: ex.filterOut(db, [...out, ...inn], (x) => `${x.entity.name} ${x.note}`), records };
}
export function knowAbout(db: DB, query: string) {
  const q = clean(query, 80).toLowerCase();
  if (q.length < 2) return { query: q, excluded: false, matches: [] as NonNullable<ReturnType<typeof neighborhood>>[], memories: [] as Rec[] };
  if (ex.isExcluded(db, q)) return { query: q, excluded: true, matches: [], memories: [] };
  const hits = listEntities(db).filter((e) => [e.name, ...e.aliases].some((n) => n.toLowerCase().includes(q) || (q.includes(n.toLowerCase()) && n.length >= 4))).slice(0, 5);
  const matches = hits.map((h) => neighborhood(db, h.id)!).filter(Boolean);
  const seen = new Set(matches.flatMap((m) => m.records.filter((r) => r.kind === 'memory').map((r) => r.id)));
  const memories = ex.filterOut(db, (memory.search(db, q) as any[]).filter((m) => !seen.has(m.id)).map((m) => ({ kind: 'memory', id: m.id as string, text: String(m.content).slice(0, 300) })), (r) => r.text);
  return { query: q, excluded: false, matches, memories };
}
export function describe(db: DB, query: string): string {
  const r = knowAbout(db, query);
  if (r.excluded) return `You asked me never to keep anything about "${query}", so I have nothing stored.`;
  if (!r.matches.length && !r.memories.length) return `I do not have anything stored about "${query}" yet.`;
  const lines: string[] = [];
  for (const m of r.matches) {
    lines.push(`${m.entity.name} (${m.entity.kind}${m.entity.origin === 'derived' ? ', pieced together from your records' : ''})${m.entity.notes ? `: ${m.entity.notes}` : ''}`);
    for (const e of m.edges.slice(0, 6)) lines.push(`  - ${e.direction === 'out' ? e.rel.replace('_', ' ') : `${e.rel.replace('_', ' ')} (from)`}: ${e.entity.name}${e.note ? ` (${e.note})` : ''}`);
    for (const x of m.records.slice(0, 6)) lines.push(`  - ${x.kind}: ${x.text}`);
  }
  for (const x of r.memories.slice(0, 5)) lines.push(`- memory: ${x.text}`);
  return lines.join('\n');
}
export function graph(db: DB, centre?: string) {
  const ents = centre ? (() => { const n = neighborhood(db, centre); return n ? [n.entity, ...n.edges.map((e) => e.entity)] : []; })() : listEntities(db).slice(0, 60);
  const idsIn = new Set(ents.map((e) => e.id));
  const edges = (db.prepare('SELECT * FROM edges').all() as any[]).filter((e) => idsIn.has(e.from_id) && idsIn.has(e.to_id));
  return { nodes: ex.filterOut(db, ents, (e) => textOf(e)), edges };
}

// ---------- export / import ----------
const exportShape = z.object({
  version: z.literal(1), exportedAt: z.number(), sha256: z.string().length(64),
  data: z.object({
    entities: z.array(z.object({ id: z.string(), kind: z.enum(KINDS), name: z.string().max(80), aliases: z.array(z.string().max(60)).max(8), notes: z.string().max(1000), scope: z.enum(SCOPES), confidence: z.number(), origin: z.enum(ORIGINS), source_ref: z.string().nullable(), created_at: z.number(), updated_at: z.number() }).strict()).max(20000),
    edges: z.array(z.object({ id: z.string(), from_id: z.string(), to_id: z.string(), rel: z.enum(RELS), note: z.string().max(200), confidence: z.number(), origin: z.enum(ORIGINS), created_at: z.number() }).strict()).max(60000),
    links: z.array(z.object({ entity_id: z.string(), kind: z.enum(LINK_KINDS), ref_id: z.string(), origin: z.string(), created_at: z.number() }).strict()).max(100000),
    exclusions: z.array(z.object({ id: z.string(), pattern: z.string().min(3).max(80), note: z.string().max(200), created_at: z.number() }).strict()).max(500),
    decisions: z.array(z.record(z.string(), z.unknown())).max(5000),
    memories: z.array(z.object({ id: z.string(), kind: z.string().max(30), content: z.string().max(1000), scope: z.string().max(20), source: z.string().max(200), confidence: z.number(), created_at: z.string() }).strict()).max(20000),
  }).strict(),
}).strict();
export type KnowledgeExport = z.infer<typeof exportShape>;
const canon = (d: unknown) => JSON.stringify(d);
const sha = (d: unknown) => crypto.createHash('sha256').update(canon(d)).digest('hex');

export function exportAll(db: DB, nowMs = Date.now()): KnowledgeExport {
  const rows = (sql: string) => db.prepare(sql).all() as any[];
  const data: any = {
    entities: ex.filterOut(db, listEntities(db), textOf).map(({ ...e }) => e).sort((a, b) => a.id.localeCompare(b.id)),
    edges: rows('SELECT * FROM edges ORDER BY id').filter((e) => !ex.isExcluded(db, e.note)),
    links: rows('SELECT * FROM entity_links ORDER BY entity_id, kind, ref_id'),
    exclusions: rows('SELECT * FROM exclusions ORDER BY id'),
    decisions: rows('SELECT * FROM decisions ORDER BY id').filter((d) => !ex.isExcluded(db, `${d.title} ${d.context} ${d.rationale}`)),
    memories: ex.filterOut(db, rows('SELECT id,kind,content,scope,source,confidence,created_at FROM memories WHERE superseded_by IS NULL ORDER BY id').filter((m) => !memory.looksSecret(m.content)), (m) => m.content),
  };
  const ids = new Set(data.entities.map((e: any) => e.id));
  data.edges = data.edges.filter((e: any) => ids.has(e.from_id) && ids.has(e.to_id)); data.links = data.links.filter((l: any) => ids.has(l.entity_id));
  audit(db, 'luke', 'knowledge.exported', '', { entities: data.entities.length, memories: data.memories.length });
  return { version: 1, exportedAt: nowMs, sha256: sha(data), data: data as KnowledgeExport["data"] };
}

/** Additive: nothing existing is overwritten or deleted. Records matching an exclusion or looking like a secret are skipped. */
export function importAll(db: DB, raw: unknown) {
  const f = exportShape.parse(raw);
  if (sha(f.data) !== f.sha256) throw new Error('This file does not match its checksum; it may be damaged or edited.');
  return atomic(db, () => {
    const c = { entities: 0, edges: 0, links: 0, memories: 0, decisions: 0, exclusions: 0, skipped: 0 };
    for (const e of f.data.exclusions) { const r = db.prepare('INSERT OR IGNORE INTO exclusions(id,pattern,note,created_at) VALUES(?,?,?,?)').run(db.prepare('SELECT 1 FROM exclusions WHERE id=?').get(e.id) ? id() : e.id, e.pattern, e.note, e.created_at); c.exclusions += Number(r.changes); }
    const map = new Map<string, string>();
    for (const e of f.data.entities) {
      if (ex.isExcluded(db, textOf(e))) { c.skipped++; continue; }
      const same = db.prepare('SELECT id FROM entities WHERE kind=? AND lower(name)=lower(?)').get(e.kind, e.name) as { id: string } | undefined;
      if (same) { map.set(e.id, same.id); continue; }
      const nid = db.prepare('SELECT id FROM entities WHERE id=?').get(e.id) ? id() : e.id;
      const ref = e.source_ref && db.prepare('SELECT 1 FROM entities WHERE source_ref=?').get(e.source_ref) ? null : e.source_ref;
      db.prepare('INSERT INTO entities(id,kind,name,aliases,notes,scope,confidence,origin,source_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(nid, e.kind, e.name, JSON.stringify(e.aliases), e.notes, e.scope, e.confidence, e.origin, ref, e.created_at, e.updated_at);
      map.set(e.id, nid); c.entities++;
    }
    const mmap = new Map<string, string>();
    for (const m of f.data.memories) {
      if (memory.looksSecret(m.content) || ex.isExcluded(db, m.content)) { c.skipped++; continue; }
      const same = db.prepare('SELECT id FROM memories WHERE content=? AND superseded_by IS NULL').get(m.content) as { id: string } | undefined;
      if (same) { mmap.set(m.id, same.id); continue; }
      const nid = db.prepare('SELECT id FROM memories WHERE id=?').get(m.id) ? id() : m.id;
      db.prepare('INSERT INTO memories(id,kind,content,scope,source,confidence,created_at) VALUES(?,?,?,?,?,?,?)').run(nid, m.kind, m.content, m.scope, m.source, m.confidence, m.created_at);
      mmap.set(m.id, nid); c.memories++;
    }
    for (const e of f.data.edges) {
      const a = map.get(e.from_id), b = map.get(e.to_id); if (!a || !b || a === b) continue;
      const r = db.prepare('INSERT OR IGNORE INTO edges(id,from_id,to_id,rel,note,confidence,origin,created_at) VALUES(?,?,?,?,?,?,?,?)').run(db.prepare('SELECT 1 FROM edges WHERE id=?').get(e.id) ? id() : e.id, a, b, e.rel, e.note, e.confidence, e.origin, e.created_at); c.edges += Number(r.changes);
    }
    for (const l of f.data.links) {
      const a = map.get(l.entity_id); if (!a) continue;
      const ref = l.kind === 'memory' ? mmap.get(l.ref_id) : l.ref_id; if (!ref) continue;
      const r = db.prepare('INSERT OR IGNORE INTO entity_links(entity_id,kind,ref_id,origin,created_at) VALUES(?,?,?,?,?)').run(a, l.kind, ref, l.origin, l.created_at); c.links += Number(r.changes);
    }
    for (const d of f.data.decisions as any[]) {
      if (db.prepare('SELECT 1 FROM decisions WHERE id=?').get(d.id)) continue;
      if (ex.isExcluded(db, `${d.title} ${d.context} ${d.rationale}`)) { c.skipped++; continue; }
      const cols = ['id','title','context','options','assumptions','scenarios','chosen','rationale','expected_outcome','expected_by','confidence','status','outcome','outcome_rating','challenge','entity_id','created_at','decided_at','reviewed_at','updated_at'];
      db.prepare(`INSERT INTO decisions(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map((k) => k === 'entity_id' ? (map.get(d[k]) ?? null) : (d[k] ?? null))); c.decisions++;
    }
    audit(db, 'luke', 'knowledge.imported', '', c); publish({ type: 'knowledge' });
    return c;
  });
}

// ---------- retention ----------
export type Retention = { messagesDays: number | null; researchDays: number | null; missionsDays: number | null };
const RET_KEY = 'knowledge:retention';
const retSchema = z.object({ messagesDays: z.number().int().min(30).max(3650).nullable(), researchDays: z.number().int().min(30).max(3650).nullable(), missionsDays: z.number().int().min(30).max(3650).nullable() }).strict();
export function getRetention(db: DB): Retention { try { return retSchema.parse(JSON.parse(getMeta(db, RET_KEY) ?? 'null')); } catch { return { messagesDays: null, researchDays: null, missionsDays: null }; } }
export function setRetention(db: DB, r: unknown) { const v = retSchema.parse(r); setMeta(db, RET_KEY, JSON.stringify(v)); audit(db, 'luke', 'retention.set', '', v); return v; }
const cutoffs = (r: Retention, nowMs: number) => ({
  messages: r.messagesDays ? new Date(nowMs - r.messagesDays * 86_400_000).toISOString() : null,
  research: r.researchDays ? nowMs - r.researchDays * 86_400_000 : null,
  missions: r.missionsDays ? nowMs - r.missionsDays * 86_400_000 : null,
});
export function previewRetention(db: DB, nowMs = Date.now(), r = getRetention(db)) {
  const c = cutoffs(r, nowMs), n = (sql: string, ...p: any[]) => Number((db.prepare(sql).get(...p) as any).n);
  return {
    messages: c.messages ? n('SELECT COUNT(*) n FROM messages WHERE at<?', c.messages) : 0,
    research: c.research ? n('SELECT COUNT(*) n FROM research_results WHERE created_at<?', c.research) : 0,
    missions: c.missions ? n("SELECT COUNT(*) n FROM missions WHERE status IN ('done','stopped','failed') AND COALESCE(finished_at,updated_at)<?", c.missions) : 0,
  };
}
/** Deletes what the saved windows say. Never touches memories, entities, decisions or anything Luke wrote by hand. */
export function applyRetention(db: DB, nowMs = Date.now()) {
  const r = getRetention(db), c = cutoffs(r, nowMs);
  return atomic(db, () => {
    const out = { messages: 0, research: 0, missions: 0 };
    if (c.messages) { out.messages = Number(db.prepare('DELETE FROM messages WHERE at<?').run(c.messages).changes); if (out.messages) db.prepare('DELETE FROM conversation_summary WHERE id=1').run(); }   // a summary must not outlive the messages it came from
    if (c.research) out.research = Number(db.prepare('DELETE FROM research_results WHERE created_at<?').run(c.research).changes);
    if (c.missions) {
      const old = (db.prepare("SELECT id FROM missions WHERE status IN ('done','stopped','failed') AND COALESCE(finished_at,updated_at)<?").all(c.missions) as { id: string }[]).map((m) => m.id);
      for (const m of old) { db.prepare('DELETE FROM mission_events WHERE mission_id=?').run(m); db.prepare('DELETE FROM mission_steps WHERE mission_id=?').run(m); db.prepare('DELETE FROM missions WHERE id=?').run(m); }
      out.missions = old.length;
    }
    audit(db, 'system', 'retention.applied', '', { ...out, windows: r });
    if (out.messages + out.research + out.missions) { refresh(db); }
    return out;
  });
}
/** Called from the 30-second tick. Does nothing unless Luke has saved a window (with step-up); then runs at most once a day. */
export function maybeApplyRetention(db: DB, nowMs = Date.now()) {
  const r = getRetention(db); if (!r.messagesDays && !r.researchDays && !r.missionsDays) return null;
  if (Number(getMeta(db, 'knowledge:retention_last') ?? 0) > nowMs - 86_400_000) return null;
  setMeta(db, 'knowledge:retention_last', String(nowMs)); return applyRetention(db, nowMs);
}

/** After a research job finishes, keep what it found as a topic in the knowledge graph (with a link back to the full results). Never throws; excluded topics are simply not kept. */
export function saveFindings(db: DB, taskId: string, question: string, summary: string, now = Date.now()) {
  try {
    const ref = `research:${taskId}`, day = new Date(now).toISOString().slice(0, 10);
    const notes = `${clean(summary, 850)} (researched ${day})`.slice(0, 1000), base = clean(question.replace(/[?.!]+$/, ''), 70) || 'Research';
    const cur = db.prepare('SELECT id FROM entities WHERE source_ref=?').get(ref) as { id: string } | undefined;
    if (cur) { db.prepare('UPDATE entities SET notes=?, updated_at=? WHERE id=?').run(notes, now, cur.id); return cur.id; }
    for (const name of [base, `${base} (${day})`]) { if (db.prepare('SELECT 1 FROM entities WHERE kind=? AND lower(name)=lower(?)').get('topic', name)) continue; const e = createEntity(db, { kind: 'topic', name, notes, scope: 'public' }, 'prometheus', ref, 0.7); linkRecord(db, e.id, 'research', taskId, 'prometheus'); return e.id; }
  } catch { /* excluded or invalid: nothing is kept */ }
  return null;
}
