import { type DB, getMeta, setMeta, sha256 } from './db.ts';
import { audit } from './audit.ts';
import { looksSecret, ACTIVE } from './memory.ts';
import { isExcluded } from './exclusions.ts';

/**
 * Meaning-based search. A small embedding model running on THIS Mac (through Ollama) turns text into a list of numbers; texts with similar meaning get similar numbers.
 * Safety, all in code:
 *  - the address must be this computer (localhost, 127.0.0.1, ::1); redirects are never followed; replies are size-capped and checked to be plain numbers;
 *  - only the model names in MODELS are used, and Jarvis never asks Ollama to download or run anything else (the one-time `ollama pull` is done by Luke himself);
 *  - memories that look like secrets, texts that mention an excluded name, and inactive memories are never embedded;
 *  - if Ollama is off, slow or wrong, everything quietly falls back to the word search Jarvis already had.
 */
export const MODELS = ['nomic-embed-text', 'all-minilm', 'mxbai-embed-large'] as const;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_REPLY = 24 * 1024 * 1024, BATCH = 16, TIMEOUT_MS = 60_000, MAX_ROWS = 20_000;
type Resp = { status: number; text(): Promise<string> };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'manual'; signal: AbortSignal }) => Promise<Resp>;
let doFetch: Fetch = (u, i) => fetch(u, i) as unknown as Promise<Resp>;
export const _hooks = { setFetch: (f: Fetch | null) => { doFetch = f ?? ((u, i) => fetch(u, i) as unknown as Promise<Resp>); } };

export function cleanUrl(raw: string): string | null { let u: URL; try { u = new URL(raw.trim()); } catch { return null; } return /^https?:$/.test(u.protocol) && LOCAL.has(u.hostname) && !u.username && !u.password ? u.origin : null; }
export const baseUrl = (db: DB) => cleanUrl(getMeta(db, 'embed:url') || '') ?? 'http://127.0.0.1:11434';
export const modelName = (db: DB) => { const m = getMeta(db, 'embed:model') || 'nomic-embed-text'; return (MODELS as readonly string[]).includes(m) ? m : 'nomic-embed-text'; };
export const isOn = (db: DB) => getMeta(db, 'embed:on') !== '0';
export function setSettings(db: DB, s: { on?: boolean; model?: string; url?: string }): boolean {
  if (s.url !== undefined && s.url !== '' && !cleanUrl(s.url)) return false; if (s.model !== undefined && !(MODELS as readonly string[]).includes(s.model)) return false;
  if (s.on !== undefined) setMeta(db, 'embed:on', s.on ? '1' : '0'); if (s.model !== undefined) setMeta(db, 'embed:model', s.model); if (s.url !== undefined) setMeta(db, 'embed:url', s.url ? cleanUrl(s.url)! : '');
  audit(db, 'luke', 'embed.settings', '', { on: s.on, model: s.model }); return true;
}

async function call(db: DB, path: string, body?: unknown, ms = TIMEOUT_MS): Promise<any | null> {
  const base = baseUrl(db); if (!cleanUrl(base)) return null;
  try {
    const res = await doFetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(ms) });
    if (res.status !== 200) return null; const t = await res.text(); if (t.length > MAX_REPLY) return null; return JSON.parse(t);
  } catch { return null; }
}

/** Is Ollama there, which version, and is the model pulled? Cheap; used by the Memory page. */
export async function status(db: DB) {
  const model = modelName(db), on = isOn(db);
  const v = on ? await call(db, '/api/version', undefined, 2500) : null, reachable = !!v && typeof v.version === 'string';
  let have = false; if (reachable) { const t = await call(db, '/api/tags', undefined, 2500); have = Array.isArray(t?.models) && t.models.some((m: any) => typeof m?.name === 'string' && (m.name === model || m.name.startsWith(`${model}:`))); }
  const n = (k: string) => (db.prepare('SELECT COUNT(*) c FROM embeddings WHERE kind=? AND model=?').get(k, model) as { c: number }).c;
  const total = { memories: (db.prepare(`SELECT COUNT(*) c FROM memories WHERE ${ACTIVE}`).get() as { c: number }).c, chunks: (db.prepare('SELECT COUNT(*) c FROM document_chunks').get() as { c: number }).c };
  return { on, url: baseUrl(db), model, reachable, version: reachable ? String(v.version).slice(0, 20) : null, modelPulled: have, indexed: { memories: n('memory'), chunks: n('chunk') }, total };
}

const prefix = (model: string, kind: 'document' | 'query') => (model === 'nomic-embed-text' ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '');
const unit = (v: number[]) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / s); };
/** Ask the local model for vectors. Returns null on any problem (the caller falls back to words). */
export async function embed(db: DB, texts: string[], kind: 'document' | 'query'): Promise<Float32Array[] | null> {
  if (!isOn(db) || !texts.length) return texts.length ? null : [];
  const model = modelName(db), out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const part = texts.slice(i, i + BATCH).map((t) => prefix(model, kind) + t.slice(0, 2000)), r = await call(db, '/api/embed', { model, input: part, truncate: true, keep_alive: '5m' });
    const e = r?.embeddings; if (!Array.isArray(e) || e.length !== part.length) return null;
    for (const v of e) { if (!Array.isArray(v) || v.length < 8 || v.length > 4096 || !v.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))) return null; out.push(unit(v)); }
    if (out.length > 1 && out.some((v) => v.length !== out[0].length)) return null;
  }
  return out;
}
const blob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const unblob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

type Item = { kind: 'memory' | 'chunk'; ref: string; text: string };
function wanted(db: DB): Item[] {
  const out: Item[] = [];
  for (const m of db.prepare(`SELECT id, content FROM memories WHERE ${ACTIVE}`).all() as { id: string; content: string }[]) if (!looksSecret(m.content) && !isExcluded(db, m.content)) out.push({ kind: 'memory', ref: m.id, text: m.content });
  for (const c of db.prepare('SELECT doc_id, idx, text FROM document_chunks').all() as { doc_id: string; idx: number; text: string }[]) if (!isExcluded(db, c.text)) out.push({ kind: 'chunk', ref: `${c.doc_id}:${c.idx}`, text: c.text });
  return out;
}
let indexing = false;
/** Make sure every memory and document piece has a vector. Safe to call often: it only does the missing work, at most `limit` pieces per call. */
export async function indexAll(db: DB, limit = 400): Promise<{ ok: boolean; added: number; remaining: number; message: string }> {
  if (!isOn(db)) return { ok: false, added: 0, remaining: 0, message: 'Meaning search is switched off.' };
  if (indexing) return { ok: false, added: 0, remaining: 0, message: 'Already building the index.' };
  indexing = true;
  try {
    const model = modelName(db), items = wanted(db), live = new Set(items.map((i) => `${i.kind}|${i.ref}`));
    for (const r of db.prepare('SELECT kind, ref FROM embeddings').all() as { kind: string; ref: string }[]) if (!live.has(`${r.kind}|${r.ref}`)) db.prepare('DELETE FROM embeddings WHERE kind=? AND ref=?').run(r.kind, r.ref);   // forgotten or inactive things leave the index
    const have = new Map((db.prepare('SELECT kind, ref, hash, model FROM embeddings').all() as { kind: string; ref: string; hash: string; model: string }[]).map((r) => [`${r.kind}|${r.ref}`, `${r.model}|${r.hash}`]));
    const todo = items.filter((i) => have.get(`${i.kind}|${i.ref}`) !== `${model}|${sha256(i.text)}`);
    const batch = todo.slice(0, limit); let added = 0;
    for (let i = 0; i < batch.length; i += BATCH) {
      const part = batch.slice(i, i + BATCH), vs = await embed(db, part.map((p) => p.text), 'document');
      if (!vs) return { ok: false, added, remaining: todo.length - added, message: 'I couldn\'t reach the model on this Mac. Check that Ollama is running and that "ollama pull ' + model + '" has been done.' };
      const ins = db.prepare('INSERT OR REPLACE INTO embeddings(kind,ref,model,dim,vec,hash,created_at) VALUES(?,?,?,?,?,?,?)');
      part.forEach((p, k) => { ins.run(p.kind, p.ref, model, vs[k].length, blob(vs[k]), sha256(p.text), Date.now()); added++; });
    }
    if (added) audit(db, 'jarvis', 'embed.index', '', { added, model });
    const remaining = todo.length - added; return { ok: true, added, remaining, message: remaining ? `Indexed ${added}; ${remaining} still to do (press again).` : added ? `Indexed ${added} items. Meaning search is ready.` : 'Everything is already indexed.' };
  } finally { indexing = false; }
}
let timer: ReturnType<typeof setTimeout> | null = null;
/** After a memory or document is added: index in the background a few seconds later. Never throws, never blocks. */
export function indexSoon(db: DB) { if (timer || !isOn(db)) return; timer = setTimeout(() => { timer = null; void indexAll(db).catch(() => {}); }, 5000); timer.unref?.(); }
export const _stopTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

/** The closest items by meaning, best first, or null if meaning search is unavailable. Brute force over stored vectors (a personal corpus is small). */
export async function similar(db: DB, query: string, o: { kind: 'memory' | 'chunk'; limit?: number; refs?: string[] }): Promise<{ ref: string; score: number }[] | null> {
  const model = modelName(db); if (!isOn(db)) return null;
  const rows = db.prepare('SELECT ref, vec FROM embeddings WHERE kind=? AND model=? LIMIT ?').all(o.kind, model, MAX_ROWS) as { ref: string; vec: Uint8Array }[]; if (!rows.length) return null;
  const q = await embed(db, [query.slice(0, 500)], 'query'); if (!q) return null; const qv = q[0], allow = o.refs ? new Set(o.refs) : null;
  const scored: { ref: string; score: number }[] = [];
  for (const r of rows) { if (allow && !allow.has(r.ref)) continue; const v = unblob(r.vec); if (v.length !== qv.length) continue; let d = 0; for (let i = 0; i < v.length; i++) d += v[i] * qv[i]; scored.push({ ref: r.ref, score: d }); }
  return scored.sort((a, b) => b.score - a.score).slice(0, o.limit ?? 5);
}
export const MIN_SIMILARITY = 0.45;   // below this a "closest" match is only the least-unrelated thing, not a real match
