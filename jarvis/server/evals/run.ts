import { z } from 'zod';
import { type DB, id } from '../db.ts';
import { audit } from '../audit.ts';
import { publish } from '../events.ts';
import * as gw from '../llm/gateway.ts';
import { getApproval } from '../llm/providers.ts';
import { PRICES, costMicro, estTokens } from '../llm/prices.ts';
import * as mb from '../missionbudget.ts';
import { casesFor } from './cases.ts';

export const DEFAULT_CAP_MICRO = 500_000, MAX_CAP_MICRO = 2_000_000;
const MAX_OUT: Record<string, number> = { chat: 400, analysis: 800 };
const input = z.object({ task: z.enum(['chat', 'analysis']), provider: z.string().min(2).max(30), model: z.string().min(2).max(60), capMicro: z.number().int().min(10_000).max(MAX_CAP_MICRO).default(DEFAULT_CAP_MICRO) }).strict();

export function refusal(db: DB, provider: string, model: string): string | null {
  const p = gw.registry.providers[provider]; if (!p) return `${provider} is not connected to Jarvis.`;
  if (!getApproval(db, provider).approved) return `${provider} has not been approved by you, so no test call will be made to it.`;
  if (!p.available()) return `${provider} has no API key configured.`;
  if (!PRICES[model]) return `${model} has no price on file, so the test could not be capped.`;
  return null;
}
/** Worst-case cost of one full run (input estimated from the case text, output at the case's token ceiling). */
export function estimate(task: 'chat' | 'analysis', model: string): { cases: number; microUsd: number } {
  const cs = casesFor(task);
  return { cases: cs.length, microUsd: cs.reduce((a, c) => a + costMicro(model, estTokens(c.system + c.user), MAX_OUT[task]), 0) };
}

/** Starts an evaluation and returns at once; `done` resolves when the run has finished (tests await it). Needs step-up at the HTTP layer. */
export function startEval(db: DB, raw: unknown, now = Date.now()): { id: string; done: Promise<void> } {
  const o = input.parse(raw); const why = refusal(db, o.provider, o.model); if (why) throw new Error(why);
  const est = estimate(o.task, o.model); if (est.microUsd > o.capMicro) throw new Error(`A full run could cost up to $${(est.microUsd / 1e6).toFixed(3)}, over the $${(o.capMicro / 1e6).toFixed(2)} limit you set. Raise the limit or choose a cheaper model.`);
  if (db.prepare("SELECT 1 FROM eval_runs WHERE status='running'").get()) throw new Error('An evaluation is already running.');
  const rid = id(), ref = `eval:${rid}`, cs = casesFor(o.task);
  db.prepare("INSERT INTO eval_runs(id,at,task,provider,model,cases,cap_micro,status) VALUES(?,?,?,?,?,?,?, 'running')").run(rid, now, o.task, o.provider, o.model, cs.length, o.capMicro);
  mb.create(db, ref, `Evaluation of ${o.model}`, o.capMicro, now); audit(db, 'luke', 'eval.started', rid, { task: o.task, provider: o.provider, model: o.model, capMicro: o.capMicro });
  const done = (async () => {
    let status: 'done' | 'partial' | 'failed' = 'done', error = '', ran = 0, total = 0, lat = 0, cost = 0;
    for (const c of cs) {
      const r = await gw.complete(db, { task: 'eval', ref, optional: true, system: c.system, messages: [{ role: 'user', content: c.user }], pin: { provider: o.provider, model: o.model, effort: 'low', maxTokens: MAX_OUT[o.task] } }, now);
      if (!r.ok) { error = r.error; status = ran ? 'partial' : 'failed'; if (r.kind !== 'transient') break; continue; }   // a stop for money, pause or refusals ends the run; one transient failure only skips that case
      const t = db.prepare('SELECT latency_ms FROM llm_usage WHERE ref=? ORDER BY id DESC LIMIT 1').get(ref) as { latency_ms: number | null };
      const k = c.check(r.text.slice(0, 4000));
      db.prepare('INSERT INTO eval_results(run_id,case_id,score,latency_ms,cost_micro,detail) VALUES(?,?,?,?,?,?)').run(rid, c.id, k.score, t?.latency_ms ?? null, r.costMicroUsd, k.detail.slice(0, 200));
      ran++; total += k.score; lat += t?.latency_ms ?? 0; cost += r.costMicroUsd;
    }
    if (status === 'done' && ran < cs.length) status = 'partial';
    db.prepare('UPDATE eval_runs SET ran=?, avg_score=?, avg_latency_ms=?, cost_micro=?, status=?, error=?, finished_at=? WHERE id=?').run(ran, ran ? total / ran : null, ran ? Math.round(lat / ran) : null, cost, status, error.slice(0, 300) || null, Date.now(), rid);
    mb.close(db, ref); audit(db, 'system', 'eval.finished', rid, { status, ran, cost }); publish({ type: 'models' });
  })().catch((e) => { db.prepare("UPDATE eval_runs SET status='failed', error=?, finished_at=? WHERE id=?").run(String(e?.message ?? e).slice(0, 300), Date.now(), rid); mb.close(db, ref); publish({ type: 'models' }); });
  return { id: rid, done };
}
/** A run left "running" by a restart can never finish; mark it so the page does not wait forever. */
export function sweepStale(db: DB, now = Date.now()) { db.prepare("UPDATE eval_runs SET status='failed', error='Interrupted by a restart', finished_at=? WHERE status='running' AND at<?").run(now, now - 600_000); }

export function runs(db: DB) { return db.prepare('SELECT * FROM eval_runs ORDER BY at DESC LIMIT 40').all(); }
export function results(db: DB, rid: string) { return db.prepare('SELECT case_id, score, latency_ms, cost_micro, detail FROM eval_results WHERE run_id=?').all(rid); }

export type Score = { task: string; provider: string; model: string; runId: string; at: number; avgScore: number; passed: number; cases: number; avgLatencyMs: number | null; costPerCaseMicro: number };
/** Latest complete run per (task, provider, model). Partial and failed runs never count towards a recommendation. */
export function scores(db: DB): Score[] {
  return (db.prepare("SELECT r.* FROM eval_runs r WHERE r.status='done' AND r.at=(SELECT MAX(at) FROM eval_runs x WHERE x.task=r.task AND x.provider=r.provider AND x.model=r.model AND x.status='done') ORDER BY r.task, r.avg_score DESC").all() as any[]).map((r) => ({
    task: r.task, provider: r.provider, model: r.model, runId: r.id, at: r.at, avgScore: r.avg_score, cases: r.cases, avgLatencyMs: r.avg_latency_ms, costPerCaseMicro: Math.round(r.cost_micro / Math.max(1, r.ran)),
    passed: (db.prepare('SELECT COUNT(*) n FROM eval_results WHERE run_id=? AND score>=1').get(r.id) as any).n }));
}
export const THRESHOLD = 0.85;
/** A suggestion only: the cheapest model that scored well on the measured set. Nothing changes until Luke applies it. */
export function recommend(db: DB, task: 'chat' | 'analysis') {
  const all = scores(db).filter((s) => s.task === task), cur = gw.DEFAULT_ROUTES[task][0];
  const route = (db.prepare('SELECT candidates FROM model_routes WHERE task=?').get(task) as any); const first = route ? JSON.parse(route.candidates)[0] : cur;
  const good = all.filter((s) => s.avgScore >= THRESHOLD).sort((a, b) => a.costPerCaseMicro - b.costPerCaseMicro || b.avgScore - a.avgScore);
  const now = all.find((s) => s.model === first.model && s.provider === first.provider);
  if (!good.length) return { task, suggestion: null, reason: all.length ? `No tested model reached ${Math.round(THRESHOLD * 100)}% on the ${task} set yet.` : 'Nothing has been measured yet.' };
  const best = good[0];
  if (best.model === first.model && best.provider === first.provider) return { task, suggestion: null, reason: 'Your current first choice is already the cheapest tested model that does well.' };
  return { task, suggestion: { provider: best.provider, model: best.model }, reason: `${best.model} scored ${Math.round(best.avgScore * 100)}% at about $${(best.costPerCaseMicro / 1e6).toFixed(4)} a question${now ? `, against ${Math.round(now.avgScore * 100)}% at $${(now.costPerCaseMicro / 1e6).toFixed(4)} for your current first choice` : '; your current first choice has not been measured'}.` };
}

/** What each model has actually done in real use over the last 30 days (separate from the measured set). */
export function liveStats(db: DB, now = Date.now()) {
  return db.prepare("SELECT provider, model, COUNT(*) calls, SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) failures, CAST(AVG(CASE WHEN ok=1 THEN latency_ms END) AS INTEGER) avgLatencyMs, COALESCE(SUM(cost_micro_usd),0) costMicro FROM llm_usage WHERE at>? AND task<>'eval' GROUP BY provider, model ORDER BY calls DESC").all(now - 30 * 86_400_000);
}
