import { type DB, getMeta, setMeta } from '../db.ts';
import { audit } from '../audit.ts';
import { isPaused } from '../pause.ts';
import { reserve, settle, releaseReservation } from '../budget.ts';
import { chicagoInstant, chicagoParts } from '../tz.ts';
import { LlmError, type ChatMessage, type Effort, type Provider } from './types.ts';
import { anthropicProvider } from './anthropic.ts';
import { costMicro, estTokens } from './prices.ts';

export type Task = 'chat' | 'analysis' | 'ping';
export type Candidate = { provider: string; model: string; effort: Effort; maxTokens: number };
export type LlmConfig = { dailyCeilingMicroUsd: number; strongEnabled: boolean; allowInPrivate: boolean };

/** Cheap-first routing. Haiku-class by default; the stronger model is a fallback for chat and the first choice only for "analysis". */
export const DEFAULT_ROUTES: Record<Task, Candidate[]> = {
  chat: [{ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 700 }, { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', maxTokens: 700 }],
  analysis: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 2500 }, { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium', maxTokens: 2500 }],
  ping: [{ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'low', maxTokens: 16 }],
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
  return !isPaused(db) && DEFAULT_ROUTES[task].some((c) => registry.providers[c.provider]?.available());
}

export type Result = { ok: true; text: string; model: string; costMicroUsd: number } | { ok: false; kind: string; error: string };

/**
 * One model call, governed. Order of checks: paused → provider available → daily ceiling → monthly budget reservation.
 * Transient failures (rate limit, network, 5xx) and auth failures fall through to the next candidate; refusals and
 * bad requests do not. Every attempt is recorded in llm_usage; the reservation is replaced by actual cost.
 */
export async function complete(db: DB, o: { task: Task; system: string; messages: ChatMessage[]; strong?: boolean; ref?: string; optional?: boolean }, now = Date.now()): Promise<Result> {
  if (isPaused(db)) return { ok: false, kind: 'paused', error: 'Jarvis is paused; no model calls.' };
  const cfg = getConfig(db);
  let route = DEFAULT_ROUTES[o.task];
  if (o.strong && cfg.strongEnabled && o.task === 'chat') route = [...DEFAULT_ROUTES.analysis];
  if (!cfg.strongEnabled) route = route.filter((c) => !c.model.includes('sonnet'));
  const inChars = o.system + o.messages.map((m) => m.content).join('\n');
  let lastError = 'No model provider is configured.', lastKind = 'unavailable';

  for (const c of route) {
    const p = registry.providers[c.provider];
    if (!p?.available()) continue;
    const est = costMicro(c.model, estTokens(inChars), c.maxTokens);
    if (spentToday(db, now) + est > cfg.dailyCeilingMicroUsd) return { ok: false, kind: 'daily_ceiling', error: `Daily model-spend ceiling reached ($${(cfg.dailyCeilingMicroUsd / 1e6).toFixed(2)}). Raising it needs your approval.` };
    const res = reserve(db, est, `llm:${o.task}`, { optional: o.optional ?? o.task === 'analysis', ref: o.ref });
    if (!res.ok) return { ok: false, kind: 'budget', error: res.reason };
    try {
      const r = await p.complete({ model: c.model, system: o.system, messages: o.messages, maxTokens: c.maxTokens, effort: c.effort });
      const cost = costMicro(c.model, r.usage.inputTokens, r.usage.outputTokens); // price the model we asked for, not whatever alias the provider echoes
      settle(db, res.id, cost, `llm:${o.task}`);
      db.prepare('INSERT INTO llm_usage(at,task,provider,model,input_tokens,output_tokens,cache_read_tokens,cost_micro_usd,ok,ref) VALUES(?,?,?,?,?,?,?,?,1,?)')
        .run(now, o.task, c.provider, c.model, r.usage.inputTokens, r.usage.outputTokens, r.usage.cacheReadTokens, cost, o.ref ?? null);
      return { ok: true, text: r.text, model: c.model, costMicroUsd: cost };
    } catch (e) {
      releaseReservation(db, res.id);
      const kind = e instanceof LlmError ? e.kind : 'transient'; const msg = (e as Error).message;
      db.prepare('INSERT INTO llm_usage(at,task,provider,model,ok,error,ref) VALUES(?,?,?,?,0,?,?)').run(now, o.task, c.provider, c.model, `${kind}: ${msg}`.slice(0, 300), o.ref ?? null);
      audit(db, 'system', 'llm.failed', c.model, { kind, msg });
      lastError = msg; lastKind = kind;
      if (kind === 'refusal' || kind === 'bad_request') break;   // another model will not fix these
      continue;                                                  // transient / auth / unavailable → next candidate
    }
  }
  return { ok: false, kind: lastKind, error: lastError };
}

export function usageSummary(db: DB, now = Date.now()) {
  const monthStart = (() => { const p = chicagoParts(now); return chicagoInstant(p.y, p.m, 1, 0, 0); })();
  const q = (since: number) => db.prepare('SELECT COUNT(*) calls, COALESCE(SUM(cost_micro_usd),0) cost, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM llm_usage WHERE ok=1 AND at>=?').get(since) as any;
  const byModel = db.prepare('SELECT model, COUNT(*) calls, SUM(cost_micro_usd) cost FROM llm_usage WHERE ok=1 AND at>=? GROUP BY model').all(monthStart);
  const failures = (db.prepare('SELECT COUNT(*) c FROM llm_usage WHERE ok=0 AND at>=?').get(monthStart) as any).c;
  return { today: q(dayStart(now)), month: q(monthStart), byModel, failures };
}
