import { type DB, getMeta, setMeta } from '../db.ts';
import { audit } from '../audit.ts';
import { isPaused } from '../pause.ts';
import { reserve, settle, releaseReservation } from '../budget.ts';
import { chicagoInstant, chicagoParts } from '../tz.ts';
import { LlmError, type ChatMessage, type Effort, type Provider } from './types.ts';
import { anthropicProvider } from './anthropic.ts';
import { costMicro, estTokens, SEARCH_MICRO } from './prices.ts';
import { wouldExceed } from '../missionbudget.ts';
import { effective, order } from './routes.ts';

export type Task = 'chat' | 'analysis' | 'ping' | 'web' | 'eval';
export type Candidate = { provider: string; model: string; effort: Effort; maxTokens: number };
export type LlmConfig = { dailyCeilingMicroUsd: number; strongEnabled: boolean; allowInPrivate: boolean };

/** Cheap-first routing. Haiku-class by default; the stronger model is a fallback for chat and the first choice only for "analysis". */
export const DEFAULT_ROUTES: Record<Task, Candidate[]> = {
  chat: [{ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 700 }, { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 700 }],
  analysis: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 2500 }, { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium', maxTokens: 2500 }],
  ping: [{ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 16 }],
  eval: [],   // evaluation runs name their model explicitly (`pin`); there is no default route
  web: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 900 }, { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 900 }],   // search turns read untrusted pages: the stronger model goes first
};
export const DEFAULT_CONFIG: LlmConfig = { dailyCeilingMicroUsd: 1_000_000, strongEnabled: true, allowInPrivate: false }; // $1.00/day

export function getConfig(db: DB): LlmConfig { try { return { ...DEFAULT_CONFIG, ...JSON.parse(getMeta(db, 'llm_config') ?? '{}') }; } catch { return DEFAULT_CONFIG; } }
export function setConfig(db: DB, patch: Partial<LlmConfig>) { setMeta(db, 'llm_config', JSON.stringify({ ...getConfig(db), ...patch })); }

export const registry: { providers: Record<string, Provider> } = { providers: { anthropic: anthropicProvider() } };

const dayStart = (now: number) => { const p = chicagoParts(now); return chicagoInstant(p.y, p.m, p.d, 0, 0); };
export function spentToday(db: DB, now = Date.now()) {
  return (db.prepare('SELECT COALESCE(SUM(cost_micro_usd),0) s FROM llm_usage WHERE ok=1 AND at>=?').get(dayStart(now)) as { s: number }).s;
}

export function ready(db: DB, task: Task = 'chat'): boolean {
  return !isPaused(db) && effective(db, task).some((c) => registry.providers[c.provider]?.available());
}

export type Result = { ok: true; text: string; model: string; costMicroUsd: number; searches?: number; sources?: { url: string; title: string }[]; claims?: import('./types.ts').Claim[]; pageAges?: Record<string, string> } | { ok: false; kind: string; error: string };

/**
 * One model call, governed. Order of checks: paused → provider available → daily ceiling → monthly budget reservation.
 * Transient failures (rate limit, network, 5xx) and auth failures fall through to the next candidate; refusals and
 * bad requests do not. Every attempt is recorded in llm_usage; the reservation is replaced by actual cost.
 */
export async function complete(db: DB, o: { task: Task; system: string; messages: ChatMessage[]; strong?: boolean; ref?: string; optional?: boolean; channel?: string; deviceId?: string; webSearch?: { maxUses: number; timezone?: string; allowedDomains?: string[]; blockedDomains?: string[] }; pin?: Candidate; cache?: boolean; schema?: Record<string, unknown> }, now = Date.now()): Promise<Result> {
  if (isPaused(db)) return { ok: false, kind: 'paused', error: 'Jarvis is paused; no model calls.' };
  const cfg = getConfig(db);
  let route = o.pin ? [o.pin] : effective(db, o.task);
  if (o.strong && cfg.strongEnabled && o.task === 'chat') route = [...effective(db, 'analysis')];
  if (!o.pin) route = order(db, route, now);
  if (!cfg.strongEnabled) route = route.filter((c) => !c.model.includes('sonnet'));
  const inChars = o.system + o.messages.map((m) => m.content).join('\n');
  let lastError = 'No model provider is configured.', lastKind = 'unavailable';

  for (const c of route) {
    const p = registry.providers[c.provider];
    if (!p?.available() || (o.webSearch && p.capabilities && !p.capabilities.webSearch)) continue;
    const est = costMicro(c.model, estTokens(inChars) + (o.webSearch ? 20_000 * o.webSearch.maxUses : 0), c.maxTokens) + (o.webSearch ? o.webSearch.maxUses * SEARCH_MICRO : 0);   // search results are read as input tokens: reserve for them
    if (spentToday(db, now) + est > cfg.dailyCeilingMicroUsd) return { ok: false, kind: 'daily_ceiling', error: `Daily model-spend ceiling reached ($${(cfg.dailyCeilingMicroUsd / 1e6).toFixed(2)}). Raising it needs your approval.` };
    const mb = wouldExceed(db, o.ref, est); if (mb.exceeded) return { ok: false, kind: 'mission_budget', error: `This mission's own budget ($${((mb.capMicro ?? 0) / 1e6).toFixed(2)}) would be exceeded (used $${((mb.spentMicro ?? 0) / 1e6).toFixed(2)}). Raising it needs your approval.` };
    const res = reserve(db, est, `llm:${o.task}`, { optional: o.optional ?? o.task === 'analysis', ref: o.ref });
    if (!res.ok) return { ok: false, kind: 'budget', error: res.reason };
    const t0 = Date.now();
    try {
      const useSchema = !!o.schema && structuredOn(db);   // structured answers only after "test structured answers" has passed on the real API
      const send = (schema?: Record<string, unknown>) => p.complete({ model: c.model, system: o.system, messages: o.messages, maxTokens: c.maxTokens, effort: c.effort, ...(o.cache ? { cache: true } : {}), ...(schema ? { schema } : {}), ...(o.webSearch ? { webSearch: o.webSearch } : {}) });
      let r; try { r = await send(useSchema ? o.schema : undefined); }
      catch (e) { if (useSchema && e instanceof LlmError && e.kind === 'bad_request') { setStructured(db, false, `the API rejected a schema: ${e.message.slice(0, 120)}`); r = await send(); } else throw e; }   // never break a working feature over a schema
      const cost = costMicro(c.model, r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, r.usage.cacheWriteTokens ?? 0) + (r.searches ?? 0) * SEARCH_MICRO; // price the model we asked for, not whatever alias the provider echoes
      settle(db, res.id, cost, `llm:${o.task}`);
      db.prepare('INSERT INTO llm_usage(at,task,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd,ok,ref,channel,device_id,latency_ms) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?)')
        .run(now, o.task, c.provider, c.model, r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, r.usage.cacheWriteTokens ?? 0, cost, o.ref ?? null, o.channel ?? null, o.deviceId ?? null, Date.now() - t0);
      return { ok: true, text: r.text, model: c.model, costMicroUsd: cost, searches: r.searches ?? 0, sources: r.sources ?? [], claims: r.claims ?? [], pageAges: r.pageAges ?? {} };
    } catch (e) {
      releaseReservation(db, res.id);
      const kind = e instanceof LlmError ? e.kind : 'transient'; const msg = (e as Error).message;
      db.prepare('INSERT INTO llm_usage(at,task,provider,model,ok,error,ref,channel,device_id) VALUES(?,?,?,?,0,?,?,?,?)').run(now, o.task, c.provider, c.model, `${kind}: ${msg}`.slice(0, 300), o.ref ?? null, o.channel ?? null, o.deviceId ?? null);
      audit(db, 'system', 'llm.failed', c.model, { kind, msg });
      lastError = msg; lastKind = kind;
      if (kind === 'refusal' || kind === 'bad_request') break;   // another model will not fix these
      continue;                                                  // transient / auth / unavailable → next candidate
    }
  }
  return { ok: false, kind: lastKind, error: lastError };
}

export const monthStartOf = (now: number) => { const p = chicagoParts(now); return chicagoInstant(p.y, p.m, 1, 0, 0); };
/** What one device has cost so far this month (successful calls only, in micro-dollars). */
export const deviceSpend = (db: DB, deviceId: string, now = Date.now()) => (db.prepare('SELECT COALESCE(SUM(cost_micro_usd),0) s FROM llm_usage WHERE ok=1 AND device_id=? AND at>=?').get(deviceId, monthStartOf(now)) as { s: number }).s;

export function usageSummary(db: DB, now = Date.now()) {
  const monthStart = monthStartOf(now);
  const q = (since: number) => db.prepare('SELECT COUNT(*) calls, COALESCE(SUM(cost_micro_usd),0) cost, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o, COALESCE(SUM(cache_read_tokens),0) cr, COALESCE(SUM(cache_write_tokens),0) cw FROM llm_usage WHERE ok=1 AND at>=?').get(since) as any;
  const byModel = db.prepare('SELECT model, COUNT(*) calls, SUM(cost_micro_usd) cost FROM llm_usage WHERE ok=1 AND at>=? GROUP BY model').all(monthStart);
  const failures = (db.prepare('SELECT COUNT(*) c FROM llm_usage WHERE ok=0 AND at>=?').get(monthStart) as any).c;
  const byChannel = db.prepare("SELECT COALESCE(channel,'system') channel, COUNT(*) calls, SUM(cost_micro_usd) cost FROM llm_usage WHERE ok=1 AND at>=? GROUP BY 1 ORDER BY cost DESC").all(monthStart);
  return { today: q(dayStart(now)), month: q(monthStart), byModel, byChannel, failures };
}

// ---------- structured answers (the API forces the reply into a JSON shape) ----------
/** Off until `test structured answers` succeeds against the real API; switched off again, once, if the API ever rejects a schema. */
export const structuredOn = (db: DB) => getMeta(db, 'llm:structured') === '1';
export function setStructured(db: DB, on: boolean, why: string) { setMeta(db, 'llm:structured', on ? '1' : '0'); audit(db, on ? 'luke' : 'system', 'llm.structured', on ? 'on' : 'off', { why }); }
const TEST_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, word: { type: 'string' } }, required: ['ok', 'word'], additionalProperties: false };
/** One tiny, cheap call that proves the real API accepts and obeys a schema. Turns structured answers on when it does. */
export async function testStructured(db: DB, now = Date.now()): Promise<string> {
  if (!ready(db, 'chat')) return 'I need a model connected to test this.';
  setMeta(db, 'llm:structured', '1');   // the test call must actually send the schema
  const r = await complete(db, { task: 'chat', ref: 'structured-test', system: 'Reply with the JSON object the schema asks for: ok true and word "ready".', messages: [{ role: 'user', content: 'Go.' }], schema: TEST_SCHEMA }, now);
  if (!r.ok) { setStructured(db, false, `test failed: ${r.error.slice(0, 100)}`); return `The test call failed (${r.error.slice(0, 120)}), so structured answers stay off.`; }
  let j: any = null; try { j = JSON.parse(r.text); } catch { /* not JSON */ }
  const exact = structuredOn(db) && !!j && j.ok === true && typeof j.word === 'string' && Object.keys(j).length === 2;   // still on = the API did not reject the schema
  setStructured(db, exact, exact ? 'test passed' : 'reply did not match the schema');
  return exact ? `Structured answers work on the real API (the reply was exactly the shape asked for), so they are now on for calendar, founder and browser steps. They switch themselves off if the API ever rejects one. The test cost about $${(r.costMicroUsd / 1e6).toFixed(4)}.` : 'The API did not give the exact shape (or rejected the schema), so structured answers stay off. Nothing else changes.';
}
