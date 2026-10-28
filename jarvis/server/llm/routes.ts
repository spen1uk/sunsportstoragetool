import { z } from 'zod';
import { type DB } from '../db.ts';
import { audit } from '../audit.ts';
import { publish } from '../events.ts';
import { registry, DEFAULT_ROUTES, type Candidate, type Task } from './gateway.ts';
import { getApproval } from './providers.ts';
import { PRICES } from './prices.ts';

/** Tasks whose prompts can contain Luke's private text. Their routes may only use providers he has allowed to see it. */
const PRIVATE_TASKS: Task[] = ['chat', 'analysis', 'agent'];
export const ROUTABLE: Task[] = ['chat', 'analysis', 'ping', 'web', 'agent'];
const MAX_TOKENS: Record<string, number> = { chat: 2000, analysis: 6000, ping: 64, web: 2000, agent: 4000 };

const candidate = z.object({ provider: z.string().min(2).max(30), model: z.string().min(2).max(60), effort: z.enum(['low', 'medium', 'high']), maxTokens: z.number().int().min(8).max(8000) }).strict();
const routeSchema = z.array(candidate).min(1).max(4);

/** Why this route would be refused, or null if it is acceptable. Checked when saving AND whenever the route is read. */
export function problem(db: DB, task: Task, cs: Candidate[]): string | null {
  if (!ROUTABLE.includes(task)) return 'That task type cannot be routed.';
  const seen = new Set<string>();
  for (const c of cs) {
    const key = `${c.provider}/${c.model}`; if (seen.has(key)) return `${key} is listed twice.`; seen.add(key);
    const p = registry.providers[c.provider]; if (!p) return `${c.provider} is not connected to Jarvis.`;
    const a = getApproval(db, c.provider); if (!a.approved) return `${c.provider} has not been approved by you.`;
    if (PRIVATE_TASKS.includes(task) && !a.allowPrivate) return `${c.provider} is not allowed to see private text, which ${task} can contain.`;
    if (task === 'web' && !p.capabilities?.webSearch) return `${c.provider} cannot run web search.`;
    if (!PRICES[c.model]) return `${c.model} has no price on file, so spending could not be capped.`;
    if (c.maxTokens > MAX_TOKENS[task]) return `Too many output tokens for ${task} (max ${MAX_TOKENS[task]}).`;
  }
  return null;
}
export function validate(db: DB, task: Task, input: unknown): Candidate[] {
  const cs = routeSchema.parse(input) as Candidate[]; const why = problem(db, task, cs); if (why) throw new Error(why); return cs;
}
const stored = (db: DB, task: string): Candidate[] | null => { const r = db.prepare('SELECT candidates FROM model_routes WHERE task=?').get(task) as { candidates: string } | undefined; if (!r) return null; try { return JSON.parse(r.candidates); } catch { return null; } };

/** The route actually used: Luke's saved one if it is still valid (provider still approved etc.), else the built-in default. */
export function effective(db: DB, task: Task): Candidate[] {
  if (task === 'eval') return [];
  const s = stored(db, task); if (s && !problem(db, task, s)) return s;
  return DEFAULT_ROUTES[task];
}
export const isOverridden = (db: DB, task: Task) => { const s = stored(db, task); return !!s && !problem(db, task, s); };

export function setRoute(db: DB, task: Task, input: unknown) {
  const cs = validate(db, task, input), before = effective(db, task);
  db.prepare('INSERT INTO model_routes(task,candidates,updated_at) VALUES(?,?,?) ON CONFLICT(task) DO UPDATE SET candidates=excluded.candidates, updated_at=excluded.updated_at').run(task, JSON.stringify(cs), Date.now());
  audit(db, 'luke', 'llm.route_set', task, { before: before.map((c) => c.model), after: cs.map((c) => c.model) }); publish({ type: 'models' }); return cs;
}
export function clearRoute(db: DB, task: Task) {
  const r = db.prepare('DELETE FROM model_routes WHERE task=?').run(task);
  if (r.changes) { audit(db, 'luke', 'llm.route_reset', task); publish({ type: 'models' }); } return r.changes > 0;
}

/**
 * Fallback rule ("circuit breaker"): a model whose last three attempts all failed within ten minutes goes to the back of the
 * line, so a model that is down is not tried first on every request. It is still tried last, so nothing is ever excluded for good.
 */
export function order(db: DB, cs: Candidate[], now: number): Candidate[] {
  const down = (c: Candidate) => { const last = db.prepare('SELECT ok, at FROM llm_usage WHERE provider=? AND model=? ORDER BY id DESC LIMIT 3').all(c.provider, c.model) as { ok: number; at: number }[]; return last.length === 3 && last.every((x) => !x.ok && x.at > now - 600_000); };
  return [...cs.filter((c) => !down(c)), ...cs.filter(down)];
}
