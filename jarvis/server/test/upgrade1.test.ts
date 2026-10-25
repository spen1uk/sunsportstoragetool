import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeDb } from './helpers.ts';
import { anthropicProvider } from '../llm/anthropic.ts';
import { LlmError, type Provider, type CompletionRequest, type Completion } from '../llm/types.ts';
import * as gw from '../llm/gateway.ts';
import { costMicro } from '../llm/prices.ts';
import { converse } from '../converse.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
async function api(handler: (body: any, res: http.ServerResponse) => void) {
  const seen: any[] = []; const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const body = b ? JSON.parse(b) : {}; seen.push(body); handler(body, res); }); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); return { url: `http://127.0.0.1:${(srv.address() as any).port}`, seen, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
const msg = (usage: any = {}) => JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '{"ok":true,"word":"ready"}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10, ...usage } });
const reply = (res: http.ServerResponse, status: number, body: string) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(body); };

test('adapter: cache and schema reach the API in the documented shape; cache read and write tokens are parsed', async () => {
  const s = await api((_b, res) => reply(res, 200, msg({ cache_read_input_tokens: 4000, cache_creation_input_tokens: 600 })));
  try {
    const p = anthropicProvider({ baseURL: s.url, apiKey: 'sk-test-canary-0000000000000000', maxRetries: 0 }); const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const r = await p.complete({ model: 'claude-haiku-5-5', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, effort: 'low', cache: true, schema });
    assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 4000, cacheWriteTokens: 600 });
    assert.deepEqual(s.seen[0].cache_control, { type: 'ephemeral' }); assert.deepEqual(s.seen[0].output_config, { effort: 'low', format: { type: 'json_schema', schema } });
    await p.complete({ model: 'claude-haiku-5-5', system: 'SYS', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }); assert.ok(!('cache_control' in s.seen[1]) && !('output_config' in s.seen[1]), 'nothing extra unless asked');
  } finally { await s.close(); }
});

test('cost: cache reads are a tenth of input price and writes 1.25x; the ledger records both and the daily total uses them', async () => {
  const base = costMicro('claude-sonnet-5-5', 1000, 100); assert.equal(base, Math.ceil(1000 * 2 + 100 * 10));
  assert.equal(costMicro('claude-sonnet-5-5', 1000, 100, 10_000, 2_000), Math.ceil(1000 * 2 + 100 * 10 + 10_000 * 2 * 0.1 + 2_000 * 2 * 1.25));
  assert.ok(costMicro('claude-sonnet-5-5', 100, 100, 20_000, 0) < costMicro('claude-sonnet-5-5', 20_100, 100), 'a cached prefix is far cheaper than the same tokens uncached');
  const db = makeDb(); gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete() { return { text: 'ok', model: 'x', stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5000, cacheWriteTokens: 300 } } as Completion; } } as Provider };
  const r = await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }], cache: true }); assert.ok(r.ok && r.costMicroUsd === costMicro('claude-haiku-5-5', 100, 10, 5000, 300));
  const u = gw.usageSummary(db); assert.equal(u.today.cr, 5000); assert.equal(u.today.cw, 300);
});

test('structured answers: off by default; a schema is sent only after the live test passes; a rejected schema retries the old way and switches itself off', async () => {
  const db = makeDb(); const calls: CompletionRequest[] = []; let reject = false;
  const SCHEMA = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: CompletionRequest) { calls.push(req); if (req.schema && reject) throw new LlmError('bad_request', 'schema not accepted'); return { text: req.schema && !reject ? '{"ok":true,"word":"ready"}' : '{"x":"a"}', model: 'x', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0 } } as Completion; } } as Provider };
  assert.equal(gw.structuredOn(db), false); await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA }); assert.equal(calls[0].schema, undefined, 'off: no schema is sent');
  assert.match((await converse(db, 'test structured answers')).text, /Structured answers work on the real API/); assert.equal(gw.structuredOn(db), true);
  await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA }); assert.deepEqual(calls[calls.length - 1].schema, SCHEMA, 'on: the schema is sent');
  reject = true; const before = calls.length; const r = await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }], schema: SCHEMA }); assert.ok(r.ok, 'the feature still works'); assert.equal(calls.length - before, 2, 'tried with the schema, then without'); assert.equal(gw.structuredOn(db), false, 'switched itself off');
  assert.ok((db.prepare("SELECT COUNT(*) c FROM audit WHERE action='llm.structured'").get() as any).c >= 2);
  // a failed live test leaves it off
  const db2 = makeDb(); reject = true; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: CompletionRequest) { if (req.schema) throw new LlmError('bad_request', 'nope'); return { text: 'ready', model: 'x', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } } as Completion; } } as Provider };
  assert.match(await gw.testStructured(db2), /stay off/); assert.equal(gw.structuredOn(db2), false);
});

test('the founder loop asks for caching and the schema; the sub-agents do not', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path'); process.env.JARVIS_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'jv-up1-'));
  const F = await import('../founder.ts'); const db = makeDb(); gw.setStructured(db, true, 'test'); const seen: { sys: string; cache?: boolean; schema?: unknown }[] = []; let n = 0;
  gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req: CompletionRequest) { seen.push({ sys: req.system, cache: req.cache, schema: req.schema }); n++; const text = req.system.includes('Founder pack for Luke') ? JSON.stringify(n === 1 ? { do: 'agents', tasks: [{ name: 'a', prompt: 'p' }] } : { do: 'finish', summary: 'done' }) : 'memo.'; return { text, model: 'x', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0 } } as Completion; } } as Provider };
  await F.start(db, { mode: 'cfo', request: 'run the numbers for my boat storage business' }); const t0 = Date.now(); while (db.prepare("SELECT status FROM founder_runs").get() && (db.prepare("SELECT status FROM founder_runs").get() as any).status === 'running' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 15));
  const loop = seen.filter((c) => c.sys.includes('Founder pack for Luke')), sub = seen.filter((c) => !c.sys.includes('Founder pack for Luke')); assert.ok(loop.length >= 2 && loop.every((c) => c.cache === true && !!c.schema)); assert.ok(sub.length === 1 && !sub[0].cache && !sub[0].schema);
});
