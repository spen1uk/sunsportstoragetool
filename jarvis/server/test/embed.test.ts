import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDb } from './helpers.ts';
import * as E from '../embed.ts';
import * as docs from '../documents.ts';
import * as memory from '../memory.ts';
import * as X from '../exclusions.ts';
import * as gw from '../llm/gateway.ts';
import type { CompletionRequest, Completion, Provider } from '../llm/types.ts';
import { converse } from '../converse.ts';

const orig = gw.registry.providers; afterEach(() => { E._hooks.setFetch(null); E._stopTimer(); gw.registry.providers = orig; });
/** A fake local Ollama. Meaning is simulated with concept groups: words in the same group point the same way, so "cost" and "rate" are close without sharing a word. */
const CONCEPTS = [['price', 'cost', 'rate', 'fee', 'charge', 'pay', 'expensive', 'cheap'], ['winter', 'cold', 'season', 'freeze', 'snow'], ['boat', 'vessel', 'yacht', 'pontoon'], ['storage', 'store', 'barn', 'warehouse', 'indoor'], ['wife', 'spouse', 'married'], ['prefer', 'like', 'favourite', 'favorite', 'love']];
const vec = (t: string) => { const w = t.toLowerCase().split(/[^a-z]+/); const v = CONCEPTS.map((g) => g.filter((x) => w.includes(x)).length); return [...v, 0.05, 0.05, 0.05, 0.05]; };
function ollama(o: { version?: string; models?: string[]; fail?: boolean; status?: number; bad?: (b: any) => any } = {}) {
  const log: { path: string; body: any }[] = [];
  E._hooks.setFetch(async (url, init) => {
    const path = new URL(url).pathname; log.push({ path, body: init.body ? JSON.parse(init.body) : null });
    if (o.fail) throw new Error('connection refused'); const reply = (j: unknown, status = o.status ?? 200) => ({ status, text: async () => JSON.stringify(j) });
    if (path === '/api/version') return reply({ version: o.version ?? '0.99.0' }); if (path === '/api/tags') return reply({ models: (o.models ?? ['nomic-embed-text:latest']).map((name) => ({ name })) });
    if (path === '/api/embed') { const b = JSON.parse(init.body!); return reply(o.bad ? o.bad(b) : { embeddings: b.input.map((t: string) => vec(t.replace(/^search_(?:document|query): /, ''))) }); }
    return reply({}, 404);
  });
  return log;
}

test('the address must be this computer and the model must be on the list; nothing else is accepted', () => {
  const db = makeDb(); for (const bad of ['https://example.com', 'http://192.168.1.4:11434', 'http://localhost.evil.com', 'http://u:p@localhost:11434', 'nope']) assert.equal(E.setSettings(db, { url: bad }), false, bad);
  assert.equal(E.setSettings(db, { model: 'some-random-model' }), false); assert.equal(E.baseUrl(db), 'http://127.0.0.1:11434'); assert.ok(E.setSettings(db, { url: 'http://localhost:11434/x', model: 'all-minilm' })); assert.equal(E.baseUrl(db), 'http://localhost:11434'); assert.equal(E.modelName(db), 'all-minilm');
});

test('status: finds Ollama and the model, says what is missing, and stays quiet when switched off', async () => {
  const db = makeDb(); ollama(); let s = await E.status(db); assert.deepEqual([s.reachable, s.version, s.modelPulled], [true, '0.99.0', true]);
  ollama({ models: ['llama3:latest'] }); s = await E.status(db); assert.deepEqual([s.reachable, s.modelPulled], [true, false]);
  ollama({ fail: true }); s = await E.status(db); assert.deepEqual([s.reachable, s.version], [false, null]);
  const log = ollama(); E.setSettings(db, { on: false }); s = await E.status(db); assert.equal(s.on, false); assert.equal(log.length, 0, 'switched off: no calls at all');
});

test('an empty shelf says so instead of claiming success', async () => { const db = makeDb(); ollama(); assert.match((await E.indexAll(db)).message, /nothing to index yet/); });

test('indexing: only memories in force that are not secret or excluded, document pieces, nothing twice; forgotten and replaced things leave the index; works in batches', async () => {
  const db = makeDb(); X.add(db, 'Project Nightingale'); const log = ollama();
  const a = memory.remember(db, 'Prefers text messages in the morning.', { source: 'luke' }); memory.remember(db, 'Wife is Sarah.', { source: 'luke' }); db.prepare("INSERT INTO memories(id,kind,content,scope,source,confidence,created_at,status) VALUES('s1','fact','the wifi password is hunter2hunter2','personal','luke',0.9,?,'stated')").run(new Date().toISOString());
  db.prepare("INSERT INTO memories(id,kind,content,scope,source,confidence,created_at,status) VALUES('x1','fact','Project Nightingale budget','personal','luke',0.9,?,'stated')").run(new Date().toISOString()); db.prepare("INSERT INTO memories(id,kind,content,scope,source,confidence,created_at,status) VALUES('h1','fact','Old fact','personal','luke',0.9,?,'historical')").run(new Date().toISOString());
  const r1 = await E.indexAll(db); assert.deepEqual([r1.ok, r1.added, r1.remaining], [true, 2, 0]); const refs = (db.prepare('SELECT ref FROM embeddings').all() as any[]).map((x) => x.ref); assert.ok(!refs.includes('s1') && !refs.includes('x1') && !refs.includes('h1'));
  const bodies = log.filter((l) => l.path === '/api/embed').flatMap((l) => l.body.input as string[]); assert.ok(bodies.every((b) => b.startsWith('search_document: ')), 'document prefix for nomic'); assert.ok(!bodies.join(' ').includes('hunter2'));
  assert.match((await E.indexAll(db)).message, /already indexed \(2 items\)/); const before = log.length; assert.equal((await E.indexAll(db)).added, 0); assert.equal(log.length, before, 'nothing to do, no calls');
  memory.forget(db, a.ok ? a.id : ''); assert.equal((db.prepare("SELECT COUNT(*) c FROM embeddings WHERE kind='memory'").get() as any).c, 1);
  db.prepare("UPDATE memories SET content='Wife is Sarah and married ten years.' WHERE content='Wife is Sarah.'").run(); assert.equal((await E.indexAll(db)).added, 1, 'changed text is re-embedded');
  for (let i = 0; i < 40; i++) memory.remember(db, `Fact number ${i} about the dock lights at the shop.`, { source: 'luke' });
  const part = await E.indexAll(db, 20); assert.deepEqual([part.ok, part.added, part.remaining > 0], [true, 20, true]); assert.equal((await E.indexAll(db)).remaining, 0);
});

test('bad replies from the model are refused whole: wrong count, NaN, wrong or mixed sizes, errors, redirects, huge replies; the caller falls back to words', async () => {
  const db = makeDb(); memory.remember(db, 'Prefers text messages in the morning.', { source: 'luke' });
  for (const o of [{ bad: () => ({ embeddings: [] }) }, { bad: (b: any) => ({ embeddings: b.input.map(() => [NaN, 1, 1, 1, 1, 1, 1, 1, 1]) }) }, { bad: (b: any) => ({ embeddings: b.input.map(() => [1, 2]) }) }, { bad: () => ({ nope: 1 }) }, { status: 302 }, { status: 500 }, { fail: true }]) {
    ollama(o as any); const r = await E.indexAll(db); assert.equal(r.ok, false); assert.match(r.message, /couldn't reach the model/); assert.equal((db.prepare('SELECT COUNT(*) c FROM embeddings').get() as any).c, 0);
  }
  ollama({ bad: (b: any) => ({ embeddings: b.input.map((_: string, i: number) => (i === 0 ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7, 8, 9])) }) }); memory.remember(db, 'Second fact for a mixed batch here.', { source: 'luke' }); assert.equal((await E.indexAll(db)).ok, false);
  ollama({ fail: true }); assert.equal(await E.similar(db, 'anything', { kind: 'memory' }), null);
});

test('the point of it: a question with NO words in common finds the right document piece and memory by meaning, and falls back cleanly when Ollama is off', async () => {
  const db = makeDb(); ollama();
  const filler = Array.from({ length: 6 }, (_, i) => `Dock maintenance notes ${i}: lights, cleats and bumpers need checking before spring.`).join(' ');
  const text = `${filler}\n\nHeated indoor barn charge is fourteen dollars per foot each cold season month.\n\n${filler}`;
  assert.ok((await docs.add(db, 'Service Guide.txt', Buffer.from(text))).ok); memory.remember(db, 'Prefers a pontoon vessel over a yacht.', { source: 'luke' }); await E.indexAll(db);
  const q = 'how expensive is it to keep my boat in winter'; assert.equal(docs.search(db, q).length > 0 && /barn charge/.test(docs.search(db, q)[0].text), false, 'word search alone misses it');
  const hits = await docs.searchHybrid(db, q); assert.match(hits[0].text, /barn charge is fourteen dollars/);
  const m = await E.similar(db, 'which boat do I like', { kind: 'memory', limit: 2 }); assert.match((db.prepare('SELECT content FROM memories WHERE id=?').get(m![0].ref) as any).content, /pontoon/);
  ollama({ fail: true }); const fb = await docs.searchHybrid(db, 'heated indoor barn charge'); assert.match(fb[0].text, /barn charge/, 'Ollama off: the word search still works');
});

test('in chat: a memory that matches by meaning is given to the model even with no shared words; a forgotten one is not', async () => {
  const db = makeDb(); ollama(); const calls: CompletionRequest[] = [];
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); return { text: 'ok', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } } as Completion; } } as Provider };
  const mem = memory.remember(db, 'Prefers a pontoon vessel over a yacht.', { source: 'luke' }); for (let i = 0; i < 6; i++) memory.remember(db, `Unrelated reminder number ${i} about printer paper orders.`, { source: 'luke' }); await E.indexAll(db);
  await converse(db, 'which favourite boat should we rent this summer?'); const sys = () => calls.filter((c) => /You are Jarvis, the personal assistant/.test(c.system)).pop()!.system;
  assert.match(sys(), /Prefers a pontoon vessel over a yacht/); assert.ok(mem.ok); memory.forget(db, (mem as any).id); await converse(db, 'which favourite boat should we rent this summer?'); assert.doesNotMatch(sys(), /pontoon/);
});

test('wiring: the index refreshes in the background, removing a document clears its vectors, no source file prints text, and the routes exist', async () => {
  const db = makeDb(); ollama(); const d = await docs.add(db, 'a.txt', Buffer.from('Heated indoor barn charge is fourteen dollars per foot each cold season month. '.repeat(3))); assert.ok(d.ok); await E.indexAll(db); assert.ok((db.prepare("SELECT COUNT(*) c FROM embeddings WHERE kind='chunk'").get() as any).c > 0);
  docs.remove(db, (d as any).id); assert.equal((db.prepare("SELECT COUNT(*) c FROM embeddings WHERE kind='chunk'").get() as any).c, 0);
  const src = fs.readFileSync(new URL('../embed.ts', import.meta.url), 'utf8'); assert.doesNotMatch(src, /console\./); assert.match(src, /redirect: 'manual'/);
  const http = fs.readFileSync(new URL('../http.ts', import.meta.url), 'utf8'); assert.match(http, /'\/api\/embed\/index'/); assert.match(fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8'), /indexMeaning/);
});
