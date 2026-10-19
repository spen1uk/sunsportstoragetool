import { handoffFor } from './handoff.ts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { type DB, now } from './db.ts';
import { config } from './config.ts';
import * as auth from './auth.ts';
import { audit, verifyAuditChain } from './audit.ts';
import { bus, clients } from './events.ts';
import { converse } from './converse.ts';
import * as gw from './llm/gateway.ts';
import { hasSecret } from './llm/secrets.ts';
import { getPersona, setPersona, personaSchema } from './persona.ts';
import * as tasks from './tasks.ts';
import * as arts from './artifacts.ts';
import * as appr from './approvals.ts';
import * as memory from './memory.ts';
import * as budget from './budget.ts';
import { pauseStatus, setPaused } from './pause.ts';
import { backupTo } from './backup.ts';
import { researchInput } from './research.ts';
import { buildBriefing, buildRecap, overnightPlan, contactNow } from './today.ts';
import { getMode, setMode, MODES } from './modes.ts';
import * as notify from './notify.ts';
import * as ms from './milestones.ts';
import * as cal from './calendar.ts';
import * as nts from './notes.ts';
import * as life from './life.ts';
import * as ws from './workspace.ts';
import * as links from './links.ts';
import * as props from './proposals.ts';
import * as standing from './standing.ts';
import * as websearch from './websearch.ts';
import * as registry from './skills/registry.ts';
import * as workflow from './skills/workflow.ts';
import { PRINCIPALS, tierOf } from './skills/manifest.ts';
import * as deep from './deepresearch.ts';
import * as know from './knowledge.ts';
import * as dec from './decisions.ts';
import * as excl from './exclusions.ts';
import { PRICES } from './llm/prices.ts';
import * as briefs from './briefs.ts';
import * as usearch from './search.ts';
import { route as routeSkill, candidates as routeCandidates } from './skills/router.ts';
import { overview as agentsOverview } from './agentsview.ts';
import * as gaps from './improve/gaps.ts';
import * as cand from './improve/candidates.ts';
import * as sbox from './improve/sandbox.ts';
import * as roll from './improve/rollout.ts';
import * as cimp from './chatimport.ts';
import * as providers from './llm/providers.ts';
import * as mroutes from './llm/routes.ts';
import * as evals from './evals/run.ts';
import { CASES } from './evals/cases.ts';
import * as sources from './sources.ts';
import * as missions from './missions.ts';
import * as tempagents from './tempagents.ts';
import { planRoutes } from './researchrouter.ts';
import { permissionLedger } from './ledger.ts';
import { emergencyStop } from './emergency.ts';
import * as missionBudget from './missionbudget.ts';
import * as bridge from './bridge.ts';
import * as dev from './devices.ts';
import { buildGreeting, buildGlance, toSpeech, coreState } from './greeting.ts';
import * as pk from './passkey.ts';
import { checks as healthChecks, healthIssues, backupDir, recordOffsite, heartbeatStatus } from './health.ts';
import { listBackups, backupPath } from './offsite.ts';
import { backupStatus } from './backup-run.ts';
import * as msug from './memsuggest.ts';
import { MacError, isMac } from './mac.ts';

type Ctx = { req: http.IncomingMessage; res: http.ServerResponse; db: DB; session: auth.Session | null; params: Record<string, string>; body: any; url: URL };
type Handler = (c: Ctx) => unknown;
const routes: { method: string; re: RegExp; keys: string[]; h: Handler; open?: boolean }[] = [];
function route(method: string, p: string, h: Handler, open = false) {
  const keys: string[] = [];
  const re = new RegExp('^' + p.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, h, open });
}
class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }
const bad = (m: string) => new HttpError(400, m);

const rows = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p);
const row = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).get(...p);
const parse = <T extends z.ZodType>(s: T, v: unknown): z.infer<T> => { const r = s.safeParse(v); if (!r.success) throw bad(r.error.issues[0]?.message ?? 'invalid input'); return r.data; };

// ---- passkeys (WebAuthn). The relying-party id and origin come from the already-validated Host header. ----
const rpCtx = (req: http.IncomingMessage) => { const host = (req.headers.host ?? '').toLowerCase(); if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host) || host.startsWith('[')) throw new HttpError(400, 'Passkeys do not work on a numeric address. Open Jarvis at http://localhost:' + config.port + ' (or your server name) instead of 127.0.0.1.'); return { rpId: host.replace(/:\d+$/, ''), origin: `${config.publicHttps ? 'https' : 'http'}://${host}` }; };
// No lockout here either: a passkey signature cannot be guessed, challenges are single-use, and a lockout would let any peer block Luke.
const pkGuard = <T,>(f: () => T): T => {
  try { return f(); } catch (e) {
    throw new HttpError(401, e instanceof z.ZodError ? 'invalid passkey response' : 'Passkey check failed: ' + (e as Error).message);
  }
};
route('POST', '/api/passkeys/login/options', ({ db, req }) => { if (!pk.listPasskeys(db).length) throw new HttpError(404, 'No passkeys are set up.'); return pk.authOptions(db, rpCtx(req), 'login', null); }, true);
route('POST', '/api/passkeys/login/verify', ({ db, req, res, body }) => {
  pkGuard(() => pk.finishAuthentication(db, rpCtx(req), 'login', null, body));
  const r = auth.startSession(db); audit(db, 'luke', 'auth.login', '', { via: 'passkey' });
  res.setHeader('Set-Cookie', sessionCookie(r.token, config.sessionTtlMs / 1000));
  return { csrf: r.csrf };
}, true);
route('GET', '/api/passkeys', ({ db }) => ({ items: pk.listPasskeys(db), required: pk.passkeyRequired(db) }));
route('POST', '/api/passkeys/register/options', ({ db, req, session }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); return pk.registrationOptions(db, rpCtx(req), session!.tokenHash); });
route('POST', '/api/passkeys/register/verify', ({ db, req, session, body }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); const r = pkGuard(() => pk.finishRegistration(db, rpCtx(req), session!.tokenHash, body)); auth.consumeStepUp(db, session!); return r; });
route('POST', '/api/passkeys/stepup/options', ({ db, req, session }) => { if (!pk.listPasskeys(db).length) throw new HttpError(404, 'No passkeys are set up.'); return pk.authOptions(db, rpCtx(req), 'stepup', session!.tokenHash); });
route('POST', '/api/passkeys/stepup/verify', ({ db, req, session, body }) => { pkGuard(() => pk.finishAuthentication(db, rpCtx(req), 'stepup', session!.tokenHash, body)); auth.grantStepUp(db, session!); return { ok: true }; });
route('PUT', '/api/passkeys/require', ({ db, session, body }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); guard(() => pk.setRequired(db, parse(z.object({ required: z.boolean() }), body).required)); auth.consumeStepUp(db, session!); return { required: pk.passkeyRequired(db) }; });
route('DELETE', '/api/passkeys/:id', ({ db, session, params }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); const ok = pk.removePasskey(db, decodeURIComponent(params.id)); auth.consumeStepUp(db, session!); return { ok }; });

// Liveness for an outside watcher or the process manager. Reveals nothing but "up".
route('GET', '/api/health', () => ({ ok: true }), true);

// ---- auth ----
route('POST', '/api/login', async ({ db, body, res }) => {
  if (pk.passkeyRequired(db)) throw new HttpError(403, 'Passkey sign-in is required. Use your passkey, or on the machine itself run: npm run setup -- --allow-passphrase');
  const { passphrase } = parse(z.object({ passphrase: z.string().min(1).max(200) }), body);
  const wait = auth.failureDelayMs(); if (wait) await new Promise((r) => setTimeout(r, wait));
  const r = auth.login(db, passphrase);
  if ('error' in r) throw new HttpError(401, r.error);
  res.setHeader('Set-Cookie', sessionCookie(r.token, config.sessionTtlMs / 1000));
  return { csrf: r.csrf };
}, true);
route('POST', '/api/logout', ({ db, req, res }) => {
  const t = cookie(req); if (t) auth.logout(db, t);
  res.setHeader('Set-Cookie', sessionCookie('', 0)); return { ok: true };
}, true);
route('GET', '/api/me', ({ session, db }) => session ? { authenticated: true, csrf: session.csrf, stepUp: auth.hasStepUp(session), passkeys: pk.listPasskeys(db).length } : { passkeys: pk.listPasskeys(db).length, passkeyRequired: pk.passkeyRequired(db), authenticated: false, configured: auth.isConfigured(db) }, true);
route('POST', '/api/stepup', async ({ db, session, body }) => {
  if (pk.passkeyRequired(db)) throw new HttpError(403, 'A passkey is required to confirm this. Use your passkey (the passphrase is turned off).');
  const { passphrase } = parse(z.object({ passphrase: z.string().min(1).max(200) }), body);
  const wait = auth.failureDelayMs(); if (wait) await new Promise((r) => setTimeout(r, wait));
  if (!auth.stepUp(db, session!, passphrase)) throw new HttpError(401, 'Invalid credentials');
  return { ok: true, validForMs: config.stepUpTtlMs };
});

// ---- state ----
route('GET', '/api/state', ({ db }) => ({
  agents: rows(db, 'SELECT * FROM agents ORDER BY role, sort'),
  pause: pauseStatus(db), budget: budget.summary(db),
  counts: {
    tasksActive: (row(db, "SELECT COUNT(*) c FROM tasks WHERE state IN ('ready','running','verifying')") as any).c,
    review: (row(db, "SELECT COUNT(*) c FROM artifacts WHERE status='in_review'") as any).c,
    approvals: (row(db, "SELECT COUNT(*) c FROM approvals WHERE status='pending'") as any).c,
    urgent: (row(db, "SELECT COUNT(*) c FROM approvals WHERE status='pending' AND risk='high'") as any).c + (row(db, "SELECT COUNT(*) c FROM notifications WHERE state IN ('pending','delivered') AND urgency!='routine'") as any).c,
    blocked: (row(db, "SELECT COUNT(*) c FROM tasks WHERE state IN ('waiting_input','waiting_approval','failed')") as any).c,
  },
  running: rows(db, "SELECT id,title,kind FROM tasks WHERE state IN ('running','verifying')"),
}));
route('POST', '/api/pause', ({ db, body }) => { setPaused(db, parse(z.object({ paused: z.boolean() }), body).paused); return pauseStatus(db); });

// ---- tasks & projects ----
route('GET', '/api/tasks', ({ db }) => rows(db, 'SELECT t.*, p.title AS project_title FROM tasks t LEFT JOIN projects p ON p.id=t.project_id ORDER BY (t.state IN (\'completed\',\'canceled\')), t.priority, t.created_at DESC LIMIT 300'));
route('GET', '/api/tasks/:id', ({ db, params }) => ({ task: row(db, 'SELECT * FROM tasks WHERE id=?', params.id), events: rows(db, 'SELECT * FROM task_events WHERE task_id=? ORDER BY id', params.id) }));
route('POST', '/api/tasks', ({ db, body }) => {
  const b = parse(z.object({
    title: z.string().min(1).max(200), description: z.string().max(4000).optional(), priority: z.number().int().min(1).max(5).optional(),
    projectId: z.string().nullish(), kind: z.enum(['manual', 'research']).default('manual'), research: researchInput.optional(), idempotencyKey: z.string().max(100).optional(),
    minutes: z.number().int().min(5).max(480).optional(), deadline: z.number().int().nullish(), milestoneId: z.string().nullish(),
  }), body);
  if (b.kind === 'research' && !b.research) throw bad('research tasks need a question and at least one URL');
  return { id: tasks.createTask(db, { title: b.title, description: b.description, priority: b.priority, projectId: b.projectId, kind: b.kind, input: b.research, idempotencyKey: b.idempotencyKey, minutes: b.minutes, deadline: b.deadline, milestoneId: b.milestoneId }) };
});
route('POST', '/api/tasks/:id/complete', ({ db, params }) => {
  const t = row(db, 'SELECT kind FROM tasks WHERE id=?', params.id) as any;
  if (!t) throw new HttpError(404, 'not found');
  if (t.kind !== 'manual') throw bad('Agent tasks complete when you accept their result in Ready for Review.');
  return { ok: tasks.completeTask(db, params.id, 'luke', 'checked off in dashboard') };
});
route('POST', '/api/tasks/:id/reopen', ({ db, params }) => { tasks.reopenTask(db, params.id); return { ok: true }; });
route('POST', '/api/tasks/:id/cancel', ({ db, params }) => { tasks.cancelTask(db, params.id); return { ok: true }; });
route('PATCH', '/api/tasks/:id', ({ db, params, body }) => {
  const b = parse(z.object({ minutes: z.number().int().min(5).max(480).optional(), deadline: z.number().int().nullable().optional(), priority: z.number().int().min(1).max(5).optional() }), body);
  const sets: string[] = [], vals: any[] = [];
  if (b.minutes !== undefined) { sets.push('minutes=?'); vals.push(b.minutes); } if (b.deadline !== undefined) { sets.push('deadline=?'); vals.push(b.deadline); } if (b.priority !== undefined) { sets.push('priority=?'); vals.push(b.priority); }
  if (!sets.length) throw bad('nothing to change');
  db.prepare(`UPDATE tasks SET ${sets.join(',')}, version=version+1, updated_at=? WHERE id=?`).run(...vals, now(), params.id); audit(db, 'luke', 'task.updated', params.id, b); return { ok: true };
});
route('POST', '/api/tasks/:id/tonight', ({ db, params, body }) => {
  const on = parse(z.object({ on: z.boolean() }), body).on;
  const r = db.prepare("UPDATE tasks SET tonight=?, priority=CASE WHEN ?=1 THEN 1 ELSE priority END, updated_at=? WHERE id=? AND kind IN ('research','revision')").run(on ? 1 : 0, on ? 1 : 0, now(), params.id);
  if (!r.changes) throw bad('Only Jarvis-owned work can be queued for tonight.'); audit(db, 'luke', 'task.tonight', params.id, { on }); return { ok: true };
});
route('GET', '/api/projects', ({ db }) => ms.listProjects(db));
route('GET', '/api/projects/:id', ({ db, params }) => { const d = ms.projectDetail(db, params.id); if (!d) throw new HttpError(404, 'not found'); return { ...d, tasks: rows(db, "SELECT id,title,state,kind,milestone_id FROM tasks WHERE project_id=? AND state!='canceled' ORDER BY created_at", params.id) }; });
/** guard for async work: a rejected promise becomes the same 400 a thrown error would. */
const aguard = async <T,>(f: () => Promise<T>): Promise<T> => { try { return await f(); } catch (e) { const m = e instanceof z.ZodError ? (e.issues[0]?.message ?? 'invalid input') : (e as Error).message; throw bad(/constraint|sqlite|SQL|no such (table|column)|syntax error/i.test(m) ? 'That could not be saved.' : m); } };
const guard = <T,>(f: () => T): T => { try { return f(); } catch (e) { const m = e instanceof z.ZodError ? (e.issues[0]?.message ?? 'invalid input') : (e as Error).message; throw bad(/constraint|sqlite|SQL|no such (table|column)|syntax error/i.test(m) ? 'That could not be saved.' : m); } };
route('POST', '/api/projects/:id/milestones', ({ db, params, body }) => {
  const b = parse(z.object({ title: z.string().min(1).max(200), description: z.string().max(2000).optional(), due: z.number().int().nullish(), dependsOn: z.string().nullish() }), body);
  return { id: guard(() => ms.createMilestone(db, { projectId: params.id, title: b.title, description: b.description, due: b.due, dependsOn: b.dependsOn })) };
});
route('PATCH', '/api/milestones/:id', ({ db, params, body }) => {
  const b = parse(z.object({ title: z.string().min(1).max(200).optional(), due: z.number().int().nullable().optional(), dependsOn: z.string().nullable().optional() }), body);
  guard(() => ms.updateMilestone(db, params.id, b)); return { ok: true };
});
route('POST', '/api/milestones/:id/complete', ({ db, params, body }) => { const b = parse(z.object({ evidence: z.string().max(2000).optional() }), body); guard(() => ms.completeMilestone(db, params.id, { evidence: b.evidence })); return { ok: true }; });
route('POST', '/api/milestones/:id/reopen', ({ db, params }) => ({ ok: ms.reopenMilestone(db, params.id) }));
route('POST', '/api/milestones/:id/cancel', ({ db, params }) => ({ ok: ms.cancelMilestone(db, params.id) }));
route('POST', '/api/tasks/:id/milestone', ({ db, params, body }) => { const b = parse(z.object({ milestoneId: z.string().nullable() }), body); guard(() => ms.linkTask(db, params.id, b.milestoneId)); return { ok: true }; });
route('POST', '/api/projects', ({ db, body }) => {
  const b = parse(z.object({ title: z.string().min(1).max(200), scope: z.enum(['personal', 'business']).default('personal') }), body);
  const pid = crypto.randomUUID();
  db.prepare("INSERT INTO projects(id,title,scope,created_at) VALUES(?,?,?,?)").run(pid, b.title, b.scope, now());
  audit(db, 'luke', 'project.created', pid); return { id: pid };
});

// ---- artifacts / review ----
route('GET', '/api/artifacts', ({ db }) => rows(db, "SELECT * FROM artifacts WHERE status!='deleted' ORDER BY (status='in_review') DESC, created_at DESC"));
route('GET', '/api/artifacts/:id', ({ db, params }) => {
  const a = row(db, 'SELECT * FROM artifacts WHERE id=?', params.id); if (!a) throw new HttpError(404, 'not found');
  return { artifact: a, versions: rows(db, 'SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version', params.id), requests: rows(db, 'SELECT * FROM review_requests WHERE artifact_id=? ORDER BY created_at', params.id) };
});
route('POST', '/api/artifacts/:id/revise', ({ db, params, body }) => {
  const b = parse(z.object({ anchor: z.string().max(4000).default(''), instruction: z.string().min(1).max(2000) }), body);
  return arts.requestRevision(db, params.id, b.anchor, b.instruction);
});
route('POST', '/api/artifacts/:id/accept', ({ db, params, body }) => {
  const { version } = parse(z.object({ version: z.number().int() }), body);
  if (!arts.acceptArtifact(db, params.id, version)) throw new HttpError(409, 'That version is no longer the one awaiting review.');
  return { ok: true, note: 'Accepted. This is not publishing; publishing needs a separate approval.' };
});
route('POST', '/api/artifacts/:id/restore', ({ db, params, body }) => ({ version: arts.restoreVersion(db, params.id, parse(z.object({ version: z.number().int() }), body).version) }));
route('POST', '/api/artifacts/:id/request-publish', ({ db, params }) => {
  const a = row(db, "SELECT * FROM artifacts WHERE id=? AND status='approved'", params.id) as any;
  if (!a) throw new HttpError(409, 'Accept the draft first; publishing is a separate approval.');
  return { approvalId: appr.requestApproval(db, { actionType: 'publish_artifact', payload: { artifactId: a.id, title: a.title, version: a.current_version }, requestedBy: 'luke' }) };
});
route('POST', '/api/artifacts/:id/request-delete', ({ db, params }) => {
  const a = row(db, 'SELECT * FROM artifacts WHERE id=?', params.id) as any; if (!a) throw new HttpError(404, 'not found');
  return { approvalId: appr.requestApproval(db, { actionType: 'delete_artifact_permanent', payload: { artifactId: a.id, title: a.title }, requestedBy: 'luke' }) };
});

// ---- approvals ----
route('GET', '/api/approvals', ({ db }) => { appr.expireStale(db); return { items: rows(db, 'SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200'), standing: rows(db, 'SELECT * FROM standing_permissions ORDER BY created_at DESC'), actions: Object.entries(appr.ACTIONS).map(([k, v]) => ({ type: k, risk: v.risk, available: !!v.handler, reason: v.unavailableReason })) }; });
route('POST', '/api/approvals/:id/decide', ({ db, params, body, session }) => {
  const b = parse(z.object({ decision: z.enum(['approve', 'deny']), digest: z.string().length(64) }), body);
  const d = appr.decide(db, params.id, b.decision, { digest: b.digest, channel: 'dashboard', session });
  if (!d.ok) throw new HttpError(409, d.error);
  if (b.decision === 'approve') auth.consumeStepUp(db, session!);   // one confirmation, one decision
  if (b.decision === 'deny') { tasks.resumeForApproval(db, params.id, false); return { ok: true }; }
  const ex = appr.execute(db, params.id);
  if (ex.ok) tasks.resumeForApproval(db, params.id, true);
  return { ok: true, executed: ex.ok, outcome: ex.outcome };
});
/** Run `f` only if this session just confirmed with its passphrase/passkey; the confirmation is spent by it. */
const stepped = <T,>(db: any, session: any, f: () => T): T => { if (!auth.hasStepUp(session)) throw new HttpError(403, 'step-up confirmation required'); const r = guard(f); auth.consumeStepUp(db, session); return r; };
route('GET', '/api/skills', ({ db }) => ({ skills: registry.summary(db), principals: Object.entries(PRINCIPALS).map(([id, p]) => ({ id, label: p.label, maxSensitivity: p.maxSensitivity })), workflows: workflow.list(db) }));
route('POST', '/api/skills/workflows/validate', ({ db, body }) => workflow.validate(db, (body as any)?.steps, (body as any)?.principal));
route('POST', '/api/skills/workflows', ({ db, body }) => { const b = parse(z.object({ name: z.string().max(60), steps: z.unknown() }), body); return { id: guard(() => workflow.save(db, b.name, b.steps, 'luke')) }; });
route('POST', '/api/skills/workflows/:id/status', ({ db, session, params, body }) => { const b = parse(z.object({ status: z.enum(['active', 'disabled', 'staged']) }), body); if (b.status === 'active') { return stepped(db, session, () => { workflow.setStatus(db, params.id, 'active', 'luke'); return { ok: true }; }); } guard(() => workflow.setStatus(db, params.id, b.status, 'luke')); return { ok: true }; });
route('POST', '/api/skills/workflows/:id/run', async ({ db, params }) => workflow.run(db, 'jarvis', params.id));
route('DELETE', '/api/skills/workflows/:id', ({ db, params }) => ({ ok: workflow.remove(db, params.id) }));
route('GET', '/api/skills/:id', ({ db, params }) => registry.detail(db, params.id) ?? (() => { throw new HttpError(404, 'no such skill'); })());
route('POST', '/api/skills/:id/grant', ({ db, session, params, body }) => { const b = parse(z.object({ principal: z.string().max(30) }), body); return stepped(db, session, () => { registry.grant(db, b.principal, params.id, 'luke'); return { ok: true }; }); });
route('DELETE', '/api/skills/:id/grant/:principal', ({ db, params }) => ({ ok: registry.revoke(db, params.principal, params.id) }));
route('POST', '/api/skills/:id/status', ({ db, session, params, body }) => { const b = parse(z.object({ status: z.enum(['active', 'disabled']) }), body); if (b.status === 'active') { return stepped(db, session, () => { registry.setStatus(db, params.id, 'active'); return { ok: true }; }); } guard(() => registry.setStatus(db, params.id, 'disabled')); return { ok: true }; });
route('POST', '/api/skills/:id/activate', ({ db, session, params, body }) => { const b = parse(z.object({ version: z.string().max(20) }), body); return stepped(db, session, () => registry.activate(db, params.id, b.version)); });
route('POST', '/api/skills/:id/test', async ({ db, params, body }) => { const d = registry.detail(db, params.id); if (!d) throw new HttpError(404, 'no such skill'); const m = d.manifest; if (m.runPath !== 'direct' || tierOf(m) !== 0) throw new HttpError(400, 'only read-only registry skills can be test-run here'); return registry.invoke(db, 'luke-test', params.id, (body as any)?.input ?? {}); });
route('GET', '/api/permissions', ({ db }) => permissionLedger(db));
route('POST', '/api/emergency-stop', ({ db, body }) => { if ((body as any)?.confirm !== true) throw new HttpError(400, 'confirmation required'); return emergencyStop(db); });
route('PUT', '/api/mission-defaults', ({ db, session, body }) => {
  const b = guard(() => z.object({ quickMicro: z.number().int(), deepMicro: z.number().int(), exploreMonthlyMicro: z.number().int() }).strict().parse(body)); const cur = missionBudget.getDefaults(db);
  const raising = b.quickMicro > cur.quickMicro || b.deepMicro > cur.deepMicro || b.exploreMonthlyMicro > cur.exploreMonthlyMicro;
  if (raising && !auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required to raise a budget');
  guard(() => missionBudget.setDefaults(db, b)); if (raising) auth.consumeStepUp(db, session!); return { ok: true };
});
route('GET', '/api/missions', ({ db }) => missions.overview(db));
route('GET', '/api/missions/:id', ({ db, params }) => { const m = missions.get(db, params.id); if (!m) throw new HttpError(404, 'no such mission'); return { events: missions.events(db, params.id) }; });
route('POST', '/api/missions', ({ db, body }) => { if (!websearch.getConfig(db).enabled) throw new HttpError(409, 'Web search is off. Turn it on in Settings → Web search first.'); const b = parse(z.object({ goal: z.string().min(8).max(500), title: z.string().max(90).optional(), priority: z.number().int().min(1).max(5).optional(), capUsd: z.number().min(0.05).max(10).optional(), value: z.string().max(200).optional() }), body); return { id: guard(() => missions.createAssigned(db, { goal: b.goal, title: b.title, priority: b.priority, capMicro: b.capUsd === undefined ? undefined : Math.round(b.capUsd * 1e6), value: b.value })) }; });
for (const [verb, fn] of [['pause', (db: any, id: string) => missions.pause(db, id)], ['resume', (db: any, id: string) => missions.resume(db, id)], ['stop', (db: any, id: string) => missions.stop(db, id)], ['retry', (db: any, id: string) => missions.retryStep(db, id)], ['accept', (db: any, id: string) => missions.accept(db, id)], ['dismiss', (db: any, id: string) => missions.dismiss(db, id)]] as const)
  route('POST', `/api/missions/:id/${verb}`, ({ db, params }) => { guard(() => fn(db, params.id)); return { ok: true }; });
route('POST', '/api/missions/:id/wrap-up', async ({ db, params }) => { try { await missions.finishPartial(db, params.id); } catch (e) { throw new HttpError(400, (e as Error).message); } return { ok: true }; });
route('POST', '/api/missions/:id/more-evidence', ({ db, params, body }) => { const b = parse(z.object({ question: z.string().min(8).max(400) }), body); guard(() => missions.addStep(db, params.id, b.question)); return { ok: true }; });
route('POST', '/api/watches', ({ db, body }) => { const b = parse(z.object({ topic: z.string().min(8).max(200), cadenceDays: z.number().int().min(1).max(90), tier: z.enum(['quick', 'deep']).default('quick') }), body); return { id: guard(() => missions.addWatch(db, b)) }; });
route('POST', '/api/watches/presets', ({ db }) => ({ added: missions.addPresets(db) }));
route('POST', '/api/watches/:id/enabled', ({ db, params, body }) => { missions.setWatchEnabled(db, params.id, !!(body as any)?.enabled); return { ok: true }; });
route('DELETE', '/api/watches/:id', ({ db, params }) => ({ ok: missions.removeWatch(db, params.id) }));
route('POST', '/api/agents/temp/:id/teardown', ({ db, params }) => ({ ok: tempagents.teardown(db, params.id, 'ended by you') }));
route('GET', '/api/research', ({ db }) => ({
  webSearch: websearch.getConfig(db), budgets: missionBudget.getDefaults(db), legalFooter: deep.legalFooterOn(db), dueForReview: sources.dueForReview(db),
  jobs: (db.prepare("SELECT id,title,state,waiting_reason,last_error,created_at,input FROM tasks WHERE kind='research' AND json_extract(input,'$.mode')='deep' ORDER BY created_at DESC LIMIT 30").all() as any[]).map((t) => {
    const i = JSON.parse(t.input), b = missionBudget.get(db, t.id); const art = db.prepare("SELECT id FROM artifacts WHERE task_id=? ORDER BY created_at DESC LIMIT 1").get(t.id) as { id: string } | undefined;
    return { id: t.id, question: i.question, tier: i.tier, state: t.state, note: t.waiting_reason ?? t.last_error ?? '', createdAt: t.created_at, spentMicroUsd: missionBudget.spentOn(db, t.id), capMicroUsd: b?.cap_micro_usd ?? i.budgetMicro, artifactId: art?.id ?? null, hasResults: !!deep.resultsFor(db, t.id), evidence: (db.prepare('SELECT COUNT(*) c FROM evidence WHERE task_id=?').get(t.id) as any).c };
  }),
}));
route('POST', '/api/research', ({ db, body }) => { const b = parse(z.object({ question: z.string().min(5).max(500), tier: z.enum(['quick', 'deep']).default('deep') }), body); const gateMsg = websearch.getConfig(db).enabled ? null : 'Web search is off. Turn it on in Settings → Web search first.'; if (gateMsg) throw new HttpError(409, gateMsg); return { id: guard(() => deep.startDeep(db, b.question, b.tier)) }; });
route('GET', '/api/research/:id/results', ({ db, params }) => { const r = deep.resultsFor(db, params.id); if (!r) throw new HttpError(404, 'no results for this job (yet)'); return r; });
route('POST', '/api/research/:id/retry', ({ db, params }) => { const t = db.prepare("SELECT id,state,input FROM tasks WHERE id=? AND kind='research'").get(params.id) as any; if (!t || JSON.parse(t.input)?.mode !== 'deep') throw new HttpError(404, 'no such research job'); if (!['waiting_input', 'failed'].includes(t.state)) throw new HttpError(409, 'this job is not paused'); db.prepare('UPDATE tasks SET attempts=0, next_run_at=0 WHERE id=?').run(t.id); tasks.setState(db, t.id, 'ready'); return { ok: true }; });
route('GET', '/api/research/plan', ({ db, url }) => planRoutes(db, { question: url.searchParams.get('q') ?? '', tier: url.searchParams.get('tier') === 'quick' ? 'quick' : 'deep' }));
route('GET', '/api/research/:id/evidence', ({ db, params }) => ({ items: db.prepare('SELECT id,sub_question,claim,source_url,source_host,source_title,cited_text,page_age,retrieved_at FROM evidence WHERE task_id=? ORDER BY rowid LIMIT 300').all(params.id) }));
route('PUT', '/api/research/settings', ({ db, body }) => { const b = parse(z.object({ legalFooter: z.boolean() }), body); deep.setLegalFooter(db, b.legalFooter); return { ok: true }; });
route('GET', '/api/sources', ({ db }) => ({ items: sources.list(db), classes: sources.CLASSES, statuses: sources.STATUSES, fetchable: (db.prepare('SELECT host FROM allowed_domains').all() as { host: string }[]).map((r) => r.host) }));
route('POST', '/api/sources', ({ db, body }) => { const b = parse(z.object({ host: z.string().max(200), label: z.string().max(80).optional(), class: z.string().optional(), reliability: z.number().int().min(0).max(100).nullable().optional(), status: z.string().optional(), terms_note: z.string().max(300).optional(), topics: z.array(z.string().max(30)).max(12).optional(), cadence_days: z.number().int().min(1).max(365).nullable().optional() }).strict(), body); return { host: guard(() => sources.upsert(db, b)) }; });
route('DELETE', '/api/sources/:host', ({ db, params }) => ({ ok: sources.remove(db, decodeURIComponent(params.host)) }));
route('POST', '/api/sources/:host/allow-fetch', ({ db, params }) => { const host = sources.validHost(decodeURIComponent(params.host)); if (!host) throw new HttpError(400, 'bad host'); return { approvalId: appr.requestApproval(db, { actionType: 'allow_domain', payload: { host }, requestedBy: 'luke' }) }; });
route('GET', '/api/websearch', ({ db }) => ({ ...websearch.getConfig(db), usedToday: websearch.usedToday(db) }));
route('PUT', '/api/websearch', ({ db, session, body }) => { const c = guard(() => websearch.configInput.parse(body)); if (c.enabled && !websearch.getConfig(db).enabled) { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required to turn web search on'); websearch.setConfig(db, c); auth.consumeStepUp(db, session!); } else websearch.setConfig(db, c); return { ok: true }; });
route('GET', '/api/standing', ({ db }) => ({ items: standing.list(db), eligible: standing.ELIGIBLE, channels: standing.CHANNELS }));
route('POST', '/api/standing', ({ db, session, body }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); const r = guard(() => standing.grant(db, body)); auth.consumeStepUp(db, session!); return r; });
route('POST', '/api/standing/:id/revoke', ({ db, params }) => { db.prepare('UPDATE standing_permissions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), params.id); audit(db, 'luke', 'standing.revoked', params.id); return { ok: true }; });

// ---- memory ----
route('GET', '/api/memory', ({ db }) => rows(db, 'SELECT * FROM memories ORDER BY (superseded_by IS NOT NULL), created_at DESC LIMIT 300'));
route('POST', '/api/memory', ({ db, body }) => {
  const b = parse(z.object({ content: z.string().min(1).max(1000), scope: z.enum(['personal', 'business']).default('personal') }), body);
  const r = memory.remember(db, b.content, { source: 'dashboard', scope: b.scope }); if (!r.ok) throw bad(r.error); return r;
});
route('PATCH', '/api/memory/:id', ({ db, params, body }) => { const r = memory.update(db, params.id, parse(z.object({ content: z.string().min(1).max(1000) }), body).content); if (!r.ok) throw bad(r.error); return r; });
route('DELETE', '/api/memory/:id', ({ db, params }) => ({ ok: memory.forget(db, params.id) }));

// ---- today: briefing, recap, overnight, contact mode, notifications ----
route('GET', '/api/today', ({ db }) => ({ briefing: buildBriefing(db), recap: buildRecap(db), overnight: overnightPlan(db), contact: contactNow(db), modes: MODES }));
route('POST', '/api/mode', ({ db, body }) => {
  const b = parse(z.object({ mode: z.enum(MODES as [string, ...string[]]), untilMinutes: z.number().int().min(1).max(24 * 60).optional() }), body);
  setMode(db, b.mode as any, b.untilMinutes ? Date.now() + b.untilMinutes * 60_000 : null);
  if (b.mode === 'normal') notify.tickNotifications(db); // "I'm back": release anything held, important first (ordering by due time)
  return { ...getMode(db), contact: contactNow(db) };
});
route('GET', '/api/notifications', ({ db }) => rows(db, "SELECT * FROM notifications WHERE state!='skipped' ORDER BY due_at DESC LIMIT 60"));
route('POST', '/api/notifications/:id/ack', ({ db, params }) => ({ ok: notify.ack(db, params.id) }));
route('POST', '/api/notifications/:id/seen', ({ db, params }) => ({ ok: notify.seen(db, params.id) }));
route('POST', '/api/notifications/:id/snooze', ({ db, params, body }) => ({ ok: notify.snooze(db, params.id, parse(z.object({ minutes: z.number().int().min(1).max(480) }), body).minutes) }));

// ---- misc pages ----
route('GET', '/api/connections', ({ db }) => ({ items: rows(db, 'SELECT * FROM connections ORDER BY status, name'), domains: rows(db, 'SELECT * FROM allowed_domains ORDER BY host') }));
// ---- Apple Calendar & Notes (read-only, from the Mac Jarvis runs on). Nothing here writes to either app. ----
const kindOf = (b: any) => parse(z.object({ kind: z.enum(['calendar', 'notes']) }), b).kind;
const macFail = (e: unknown): never => { if (e instanceof MacError) throw new HttpError(e.kind === 'unavailable' ? 503 : 502, e.message); throw e; };
// Mac helper bridge. These routes take only the helper's own credential (never a browser session) and can do nothing else.
const viaBridge = (h: (c: Ctx) => unknown): Handler => (c) => { const v = bridge.verify(c.db, c.req.headers.authorization); if (!v.ok) throw new HttpError(v.status, v.error); return h(c); };
route('GET', '/api/bridge/config', viaBridge(({ db }) => bridge.helperConfig(db)), true);
route('POST', '/api/bridge/names', viaBridge(({ db, body }) => guard(() => bridge.reportNames(db, body))), true);
route('POST', '/api/bridge/calendar', viaBridge(({ db, body }) => guard(() => bridge.ingestCalendar(db, body))), true);
route('POST', '/api/bridge/notes', viaBridge(({ db, body }) => guard(() => bridge.ingestNotes(db, body))), true);
route('POST', '/api/bridge/failure', viaBridge(({ db, body }) => { const b = parse(z.object({ kind: z.enum(['calendar', 'notes']), message: z.string().max(300) }), body); bridge.reportFailure(db, b.kind, b.message); return { ok: true }; }), true);
// ---- devices (phone, car, text/voice gateways): own limited credentials; session routes manage them, bearer routes serve them ----
route('GET', '/api/devices', ({ db }) => ({ items: dev.listDevices(db), scopes: dev.SCOPES, kinds: dev.KINDS }));
route('POST', '/api/devices', ({ db, session, body }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); const r = guard(() => dev.createDevice(db, body)); auth.consumeStepUp(db, session!); return r; });
route('PUT', '/api/devices/:id/limit', ({ db, session, params, body }) => {
  const up = guard(() => dev.raising(db, params.id, body));   // raising a spend limit needs a fresh confirmation; lowering never does
  if (up && !auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required to raise a limit');
  const r = guard(() => dev.setDeviceLimit(db, params.id, body)); if (up) auth.consumeStepUp(db, session!); return r;
});
route('DELETE', '/api/devices/:id', ({ db, params }) => ({ ok: dev.revokeDevice(db, params.id) }));
route('GET', '/api/greeting', ({ db, url }) => buildGreeting(db, { profile: url.searchParams.get('profile') === 'glance' ? 'glance' : 'full' }));   // dashboard preview of what a device will say
const asDevice = (need: dev.Scope | null, h: (c: Ctx, d: dev.Device) => unknown): Handler => (c) => { const v = dev.authenticate(c.db, c.req.headers.authorization, need); if (!v.ok) throw new HttpError(v.status, v.error); return h(c, v.device); };
route('GET', '/api/device/me', asDevice(null, (_c, d) => ({ name: d.name, kind: d.kind, scopes: d.scopes, profile: d.profile })), true);
route('GET', '/api/device/greeting', asDevice('greeting', ({ db, url }, d) => {
  const p = url.searchParams.get('profile');
  return buildGreeting(db, { profile: p === 'glance' || p === 'full' ? p : d.profile, lastSeen: d.lastSeen, channel: d.kind });
}), true);
route('GET', '/api/device/handoff', asDevice('chat', ({ db }, d) => ({ handoff: handoffFor(db, d.kind) })), true);
route('GET', '/api/device/glance', asDevice('glance', ({ db }) => buildGlance(db)), true);
route('POST', '/api/device/chat', asDevice('chat', async ({ db, body }, d) => {
  if (!dev.allow(d.id, 30)) throw new HttpError(429, 'slow down a little');
  const b = parse(z.object({ text: z.string().min(1).max(1000), private: z.boolean().default(false), mode: z.enum(['driving', 'parked']).default('parked') }), body);
  const spent = gw.deviceSpend(db, d.id);   // checked before the call, so one in-flight call can overshoot slightly; the global cap still applies on top
  if (spent >= d.monthlyLimitMicroUsd) throw new HttpError(402, `this device has used its $${(d.monthlyLimitMicroUsd / 1e6).toFixed(2)} for the month`);
  const r = await converse(db, b.text, { private: b.private, channel: d.kind, brief: b.mode === 'driving', deviceId: d.id });
  const queued = r.proposals?.length ?? 0;
  const speak = toSpeech(r.text, b.mode === 'driving' ? 280 : 700) + (queued ? ` I've left ${queued === 1 ? 'a suggestion' : `${queued} suggestions`} on your dashboard for you to confirm.` : '');
  return { speak, text: r.text, queuedForConfirmation: queued, core: coreState(db) };   // a device can never confirm anything itself
}), true);
route('GET', '/api/bridge/backups', viaBridge(async () => ({ items: await listBackups(backupDir()) })), true);
route('POST', '/api/bridge/backups/ack', viaBridge(({ db, body }) => { const b = parse(z.object({ name: z.string().max(60).regex(/^jarvis-\d{8}-\d{6}\.jvbk$/) }), body); if (!backupPath(backupDir(), b.name)) throw new HttpError(404, 'no such backup'); recordOffsite(db, b.name); audit(db, 'mac-helper', 'backup.copied_offsite', b.name); return { ok: true }; }), true);
route('GET', '/api/health/detail', ({ db }) => ({ checks: healthChecks(db), issues: healthIssues(db), heartbeat: heartbeatStatus(db) }));
route('GET', '/api/bridge', ({ db }) => bridge.status(db));
route('POST', '/api/bridge/token', ({ db, session }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); const token = bridge.createToken(db); auth.consumeStepUp(db, session!); return { token }; });
route('DELETE', '/api/bridge/token', ({ db }) => ({ ok: bridge.revokeToken(db) }));
route('GET', '/api/mac', ({ db }) => ({ mac: isMac(), bridge: bridge.status(db), calendar: { ...cal.syncState(db, 'calendar'), sources: cal.sources(db, 'calendar') }, notes: { ...cal.syncState(db, 'notes'), sources: cal.sources(db, 'notes') } }));
route('POST', '/api/mac/detect', async ({ db, body }) => { const k = kindOf(body); try { const names = k === 'calendar' ? await cal.detectCalendars(db) : await nts.detectFolders(db); return { names, sources: cal.sources(db, k) }; } catch (e) { return macFail(e); } });
route('PUT', '/api/mac/sources', ({ db, body }) => { const b = parse(z.object({ kind: z.enum(['calendar', 'notes']), enabled: z.array(z.string().max(200)).max(100) }), body); const known = new Set(cal.sources(db, b.kind).map((x) => x.name)); cal.setEnabled(db, b.kind, b.enabled.filter((n) => known.has(n))); return { sources: cal.sources(db, b.kind), state: cal.syncState(db, b.kind) }; });
route('POST', '/api/mac/sync', async ({ db, body }) => { const k = kindOf(body); const r = k === 'calendar' ? await cal.syncCalendar(db) : await nts.syncNotes(db); if (!r.ok) throw new HttpError(502, r.error ?? 'sync failed'); return { ...r, state: cal.syncState(db, k) }; });
route('POST', '/api/mac/disconnect', ({ db, body }) => { const k = kindOf(body); cal.setEnabled(db, k, []); db.prepare('DELETE FROM mac_sync WHERE kind=?').run(k); cal.setConnection(db, k); audit(db, 'luke', `${k}.disconnect`); return { ok: true }; });
route('GET', '/api/calendar', ({ db, url }) => {
  const t = Date.now(), q = (k: string, d: number) => { const n = Number(url.searchParams.get(k)); return Number.isFinite(n) && n > 0 ? n : d; };
  const from = q('from', t - 3_600_000), to = Math.min(q('to', t + 14 * 86_400_000), from + 100 * 86_400_000);   // at most ~14 weeks per request
  return { state: cal.syncState(db, 'calendar', t), events: cal.upcoming(db, from, to), now: t };
});
route('GET', '/api/notes', ({ db, url }) => ({ state: cal.syncState(db, 'notes'), items: nts.listNotes(db, (url.searchParams.get('q') ?? '').slice(0, 100)) }));
route('GET', '/api/notes/:id', ({ db, params }) => { const n = nts.getNote(db, params.id); if (!n) throw new HttpError(404, 'not found'); return n; });
// ---- My Life (habits, people) and Modular Workspace layouts ----
route('GET', '/api/life', ({ db }) => ({ habits: life.listHabits(db), people: life.listPeople(db), goals: life.listGoals(db), links: links.listLinks(db) }));
route('POST', '/api/goals', ({ db, body }) => guard(() => ({ id: life.createGoal(db, body) })));
route('POST', '/api/goals/:id/log', ({ db, params, body }) => guard(() => { life.logLearning(db, params.id, parse(z.object({ amount: z.number().int().min(1).max(20).default(1) }), body).amount); return { ok: true }; }));
route('POST', '/api/goals/:id/undo', ({ db, params }) => ({ ok: life.undoLearning(db, params.id) }));
route('DELETE', '/api/goals/:id', ({ db, params }) => ({ ok: life.archiveGoal(db, params.id) }));
route('POST', '/api/links', ({ db, body }) => guard(() => ({ id: links.addLink(db, body) })));
route('DELETE', '/api/links/:id', ({ db, params }) => ({ ok: links.removeLink(db, params.id) }));
route('POST', '/api/habits', ({ db, body }) => guard(() => ({ id: life.createHabit(db, body) })));
route('POST', '/api/habits/:id/toggle', ({ db, params, body }) => guard(() => life.toggleHabit(db, params.id, Date.now(), parse(z.object({ day: z.string().optional() }), body).day)));
route('DELETE', '/api/habits/:id', ({ db, params }) => ({ ok: life.archiveHabit(db, params.id) }));
route('POST', '/api/people', ({ db, body }) => guard(() => ({ id: life.createPerson(db, body) })));
route('PATCH', '/api/people/:id', ({ db, params, body }) => guard(() => ({ ok: life.updatePerson(db, params.id, body) })));
route('POST', '/api/people/:id/contacted', ({ db, params }) => ({ ok: life.markContacted(db, params.id) }));
route('DELETE', '/api/people/:id', ({ db, params }) => ({ ok: life.deletePerson(db, params.id) }));
route('GET', '/api/workspaces', ({ db }) => ws.getWorkspaces(db));
route('PUT', '/api/workspaces/:name', ({ db, params, body }) => guard(() => { ws.saveLayout(db, decodeURIComponent(params.name), body); return { ok: true }; }));
route('POST', '/api/workspaces/:name/activate', ({ db, params }) => guard(() => { ws.setActive(db, decodeURIComponent(params.name)); return { ok: true }; }));
route('DELETE', '/api/workspaces/:name', ({ db, params }) => guard(() => { ws.deleteLayout(db, decodeURIComponent(params.name)); return { ok: true }; }));
route('GET', '/api/proposals', ({ db }) => props.listPending(db));
route('POST', '/api/proposals/:id/confirm', ({ db, params }) => props.confirm(db, params.id));
route('POST', '/api/proposals/:id/dismiss', ({ db, params }) => ({ ok: props.dismiss(db, params.id) }));
// ---- integrations: Claude Code briefs, handed-over chats ----
route('GET', '/api/briefs', ({ db }) => ({ items: briefs.list(db), rules: briefs.FIXED_RULES }));
route('POST', '/api/briefs', ({ db, body }) => ({ brief: guard(() => briefs.create(db, body)) }));
route('POST', '/api/briefs/draft', async ({ db, body }) => { const b = parse(z.object({ request: z.string().min(10).max(3000), repo: z.string().max(170).default('') }), body); return { brief: await aguard(() => briefs.draftFrom(db, b.request, b.repo)) }; });
route('PATCH', '/api/briefs/:id', ({ db, params, body }) => ({ brief: guard(() => briefs.update(db, params.id, body)) }));
route('POST', '/api/briefs/:id/ready', ({ db, params }) => ({ brief: guard(() => briefs.markReady(db, params.id)) }));
route('POST', '/api/briefs/:id/launched', ({ db, params }) => ({ brief: guard(() => briefs.markLaunched(db, params.id)) }));
route('POST', '/api/briefs/:id/finish', ({ db, params, body }) => ({ brief: guard(() => briefs.finish(db, params.id, body)) }));
route('POST', '/api/briefs/:id/drop', ({ db, params }) => ({ ok: briefs.drop(db, params.id) }));
route('DELETE', '/api/briefs/:id', ({ db, params }) => ({ ok: briefs.remove(db, params.id) }));
route('GET', '/api/briefs/:id/markdown', ({ db, params }) => { const b = briefs.get(db, params.id); if (!b) throw new HttpError(404, 'not found'); return { markdown: briefs.markdown(db, params.id), status: b.status }; });
route('GET', '/api/imports', ({ db, url }) => { const q = url.searchParams.get('q'); return q ? { hits: cimp.search(db, q) } : { items: cimp.list(db), limits: { maxMessages: cimp.MAX_MESSAGES, maxBatch: cimp.MAX_BATCH } }; });
route('POST', '/api/imports', ({ db, body }) => guard(() => cimp.importChats(db, body)));
route('GET', '/api/imports/:id', ({ db, params }) => { const r = cimp.messages(db, params.id); if (!r) throw new HttpError(404, 'not found'); return r; });
route('PATCH', '/api/imports/:id', ({ db, params, body }) => ({ ok: guard(() => cimp.update(db, params.id, body)) }));
route('POST', '/api/imports/:id/suggest-memories', async ({ db, params }) => { const r = await cimp.suggestMemories(db, params.id); if (!r.ok) throw new HttpError(409, r.error); return r; });
route('DELETE', '/api/imports/:id', ({ db, params }) => ({ ok: cimp.remove(db, params.id) }));
route('DELETE', '/api/imports', ({ db, session, body }) => stepped(db, session, () => ({ deleted: cimp.removeAll(db) })));
// ---- autonomous skill improvement: gaps → candidates → sandbox → staged → promoted (only by you) ----
route('POST', '/api/skills/route', async ({ db, body }) => { const b = parse(z.object({ text: z.string().min(3).max(300) }), body); const r = await routeSkill(db, b.text, { run: false }); return r.handled ? { skill: r.skill, say: r.text } : { skill: null, say: 'No skill fits that. It would be an ordinary chat.', candidates: routeCandidates(db).length }; });
route('GET', '/api/search', ({ db, url }) => usearch.search(db, (url.searchParams.get('q') ?? '').slice(0, 120), { includeImports: url.searchParams.get('imports') === '1', perKind: 10 }));
route('GET', '/api/agents/overview', ({ db }) => agentsOverview(db));
route('GET', '/api/improve', ({ db }) => ({ gaps: gaps.list(db), improvements: cand.list(db), auto: roll.autoDraft(db), modelReady: gw.ready(db, 'analysis'), capDefaultMicroUsd: cand.DEFAULT_CAP_MICRO, capMaxMicroUsd: cand.MAX_CAP_MICRO }));
route('GET', '/api/improve/:id', ({ db, params }) => { const i = cand.get(db, params.id); if (!i) throw new HttpError(404, 'not found'); return { improvement: i, events: cand.events(db, params.id) }; });
route('POST', '/api/improve/scan', ({ db }) => ({ found: gaps.scan(db) }));
route('POST', '/api/improve/gaps', ({ db, body }) => ({ id: guard(() => gaps.file(db, body)) }));
route('POST', '/api/improve/gaps/:id/dismiss', ({ db, params }) => ({ ok: gaps.setStatus(db, params.id, 'dismissed') }));
route('POST', '/api/improve/gaps/:id/draft', async ({ db, params, body }) => { const b = parse(z.object({ capMicro: z.number().int().min(20_000).max(cand.MAX_CAP_MICRO).default(cand.DEFAULT_CAP_MICRO) }), body ?? {}); const imp = await aguard(() => cand.generate(db, params.id, { capMicro: b.capMicro })); if (imp && imp.status === 'proposed') await sbox.evaluate(db, imp.id); return { improvement: cand.get(db, imp!.id) }; });
route('POST', '/api/improve/:id/test', async ({ db, params }) => ({ report: await aguard(() => sbox.evaluate(db, params.id)) }));
route('POST', '/api/improve/:id/stage', ({ db, params }) => ({ improvement: guard(() => roll.stage(db, params.id)) }));
route('POST', '/api/improve/:id/promote', async ({ db, session, params }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); const r = await aguard(() => roll.promote(db, params.id)); auth.consumeStepUp(db, session!); return { improvement: r }; });
route('POST', '/api/improve/:id/rollback', ({ db, session, params }) => stepped(db, session, () => roll.rollback(db, params.id)));
route('POST', '/api/improve/:id/brief', ({ db, params }) => ({ brief: guard(() => cand.toBrief(db, params.id)) }));
route('POST', '/api/improve/:id/reject', ({ db, params }) => ({ ok: cand.reject(db, params.id) }));
route('PUT', '/api/improve/settings', ({ db, session, body }) => { const b = parse(z.object({ auto: z.boolean() }), body); if (b.auto) return stepped(db, session, () => { roll.setAutoDraft(db, true); return { auto: true }; }); roll.setAutoDraft(db, false); return { auto: false }; });
// ---- model router and evaluations ----
const taskEnum = z.enum(['chat', 'analysis', 'ping', 'web']);
route('GET', '/api/models', ({ db }) => { evals.sweepStale(db); return {
  providers: providers.list(db),
  routes: mroutes.ROUTABLE.map((t) => ({ task: t, effective: mroutes.effective(db, t), overridden: mroutes.isOverridden(db, t), default: gw.DEFAULT_ROUTES[t] })),
  knownModels: Object.keys(PRICES).map((m) => ({ model: m, inPerMTok: PRICES[m].in, outPerMTok: PRICES[m].out })),
  runs: evals.runs(db), scores: evals.scores(db), live: evals.liveStats(db), recommendations: (['chat', 'analysis'] as const).map((t) => evals.recommend(db, t)),
  cases: CASES.map((c) => ({ id: c.id, task: c.task, title: c.title })), defaultCapMicroUsd: evals.DEFAULT_CAP_MICRO, maxCapMicroUsd: evals.MAX_CAP_MICRO, threshold: evals.THRESHOLD,
}; });
route('POST', '/api/models/eval/estimate', ({ db, body }) => { const b = parse(z.object({ task: z.enum(['chat', 'analysis']), provider: z.string(), model: z.string() }), body); return { ...evals.estimate(b.task, b.model), refusal: evals.refusal(db, b.provider, b.model) }; });
route('POST', '/api/models/eval', ({ db, session, body }) => stepped(db, session, () => ({ id: evals.startEval(db, body).id })));
route('GET', '/api/models/eval/:id', ({ db, params }) => { const r = db.prepare('SELECT * FROM eval_runs WHERE id=?').get(params.id); if (!r) throw new HttpError(404, 'not found'); return { run: r, results: evals.results(db, params.id) }; });
route('PUT', '/api/models/routes/:task', ({ db, session, params, body }) => { const t = parse(taskEnum, params.task); return stepped(db, session, () => ({ route: mroutes.setRoute(db, t, (body as any)?.candidates) })); });
route('DELETE', '/api/models/routes/:task', ({ db, params }) => ({ ok: mroutes.clearRoute(db, parse(taskEnum, params.task)) }));
route('PUT', '/api/models/providers/:id', ({ db, session, params, body }) => { const b = parse(z.object({ approved: z.boolean(), allowPrivate: z.boolean() }), body); return stepped(db, session, () => ({ provider: providers.setApproval(db, params.id, b) })); });
// ---- knowledge graph, decisions, exclusions, retention ----
route('GET', '/api/knowledge', ({ db, url }) => { const q = (url.searchParams.get('q') ?? '').trim(); return q ? know.knowAbout(db, q) : { entities: know.listEntities(db), kinds: know.KINDS, rels: know.RELS, scopes: know.SCOPES }; });
route('GET', '/api/knowledge/graph', ({ db, url }) => know.graph(db, url.searchParams.get('centre') ?? undefined));
route('POST', '/api/knowledge/refresh', ({ db }) => know.refresh(db));
route('POST', '/api/knowledge/entities', ({ db, body }) => ({ entity: guard(() => know.createEntity(db, body)) }));
route('GET', '/api/knowledge/entities/:id', ({ db, params }) => { const n = know.neighborhood(db, params.id); if (!n) throw new HttpError(404, 'not found'); return n; });
route('PATCH', '/api/knowledge/entities/:id', ({ db, params, body }) => ({ entity: guard(() => know.updateEntity(db, params.id, body)) }));
route('POST', '/api/knowledge/entities/:id/forget', ({ db, params, body }) => { const b = parse(z.object({ alsoMemories: z.boolean().default(false) }), body); return guard(() => know.forgetEntity(db, params.id, b)); });
route('POST', '/api/knowledge/edges', ({ db, body }) => { const b = parse(z.object({ from: z.string(), to: z.string(), rel: z.string(), note: z.string().max(200).optional() }), body); return guard(() => know.addEdge(db, b.from, b.to, b.rel, { note: b.note })); });
route('DELETE', '/api/knowledge/edges/:id', ({ db, params }) => ({ ok: know.removeEdge(db, params.id) }));
route('GET', '/api/exclusions', ({ db }) => ({ items: excl.list(db) }));
route('POST', '/api/exclusions', ({ db, body }) => { const b = parse(z.object({ pattern: z.string().min(3).max(80), note: z.string().max(200).default('') }), body); const r = know.applyExclusion(db, b.pattern, b.note); if (!r.ok) throw bad(r.error); return r; });
route('DELETE', '/api/exclusions/:id', ({ db, params }) => ({ ok: excl.remove(db, params.id) }));
route('GET', '/api/knowledge/export', ({ db }) => know.exportAll(db));
route('POST', '/api/knowledge/import', ({ db, session, body }) => stepped(db, session, () => know.importAll(db, body)));
route('GET', '/api/knowledge/retention', ({ db }) => ({ retention: know.getRetention(db), preview: know.previewRetention(db) }));
route('PUT', '/api/knowledge/retention', ({ db, session, body }) => stepped(db, session, () => ({ retention: know.setRetention(db, body) })));
route('POST', '/api/knowledge/retention/preview', ({ db, body }) => { const r = guard(() => know.getRetention(db)); const b = body && typeof body === 'object' && Object.keys(body as object).length ? (body as any) : r; return { preview: guard(() => know.previewRetention(db, Date.now(), b)) }; });
route('POST', '/api/knowledge/retention/run', ({ db, session }) => stepped(db, session, () => know.applyRetention(db)));
route('GET', '/api/decisions', ({ db }) => ({ items: dec.list(db), due: dec.due(db).map((d: any) => d.id), calibration: dec.calibration(db) }));
route('POST', '/api/decisions', ({ db, body }) => ({ decision: guard(() => dec.create(db, body)) }));
route('PATCH', '/api/decisions/:id', ({ db, params, body }) => ({ decision: guard(() => dec.update(db, params.id, body)) }));
route('POST', '/api/decisions/:id/decide', ({ db, params, body }) => ({ decision: guard(() => dec.decide(db, params.id, body)) }));
route('POST', '/api/decisions/:id/review', ({ db, params, body }) => ({ decision: guard(() => dec.review(db, params.id, body)) }));
route('POST', '/api/decisions/:id/drop', ({ db, params }) => ({ ok: dec.drop(db, params.id) }));
route('DELETE', '/api/decisions/:id', ({ db, params }) => ({ ok: dec.remove(db, params.id) }));
route('POST', '/api/decisions/:id/challenge', async ({ db, params }) => { const r = await guard(() => dec.challenge(db, params.id)); if (!r.ok) throw new HttpError(409, r.error); return r; });
route('GET', '/api/memory/suggestions', ({ db }) => ({ items: msug.listSuggestions(db), auto: msug.autoEnabled(db), lastRun: msug.lastRun(db), modelReady: gw.ready(db, 'chat') }));
route('POST', '/api/memory/suggest', async ({ db }) => msug.suggestFromChat(db));
route('PUT', '/api/memory/suggest-settings', ({ db, body }) => { msug.setAuto(db, parse(z.object({ auto: z.boolean() }), body).auto); return { auto: msug.autoEnabled(db) }; });
route('POST', '/api/memory/suggestions/:id/accept', ({ db, params, body }) => { const r = msug.accept(db, params.id, parse(z.object({ content: z.string().min(3).max(300).optional() }), body).content); if (!r.ok) throw bad(r.error ?? 'failed'); return r; });
route('POST', '/api/memory/suggestions/:id/reject', ({ db, params }) => ({ ok: msug.reject(db, params.id) }));
route('GET', '/api/backups', ({ db }) => backupStatus(db));
route('GET', '/api/budget', ({ db }) => ({ summary: budget.summary(db), ledger: rows(db, 'SELECT * FROM budget_ledger ORDER BY at DESC LIMIT 100') }));
route('POST', '/api/budget/fixed', ({ db, body }) => {
  const b = parse(z.object({ category: z.string().min(1).max(60), usd: z.number().min(0).max(1000), note: z.string().max(200).default('') }), body);
  budget.addFixedCost(db, b.category, Math.round(b.usd * 1e6), b.note); return budget.summary(db);
});
route('POST', '/api/budget/cap-increase', ({ db, body }) => {
  const { usd } = parse(z.object({ usd: z.number().min(1).max(10000) }), body);
  const next = Math.round(usd * 1e6);
  if (next <= budget.getCap(db)) throw bad('That is not an increase.');
  return { approvalId: appr.requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: next }, requestedBy: 'luke' }) };
});
let chainCache: { at: number; head: number; v: { ok: boolean; brokenAt?: number } } | null = null;
route('GET', '/api/activity', ({ db }) => {
  const head = (row(db, 'SELECT COALESCE(MAX(id),0) m FROM audit') as any).m as number;
  if (!chainCache || chainCache.head !== head || Date.now() - chainCache.at > 5 * 60_000) chainCache = { at: Date.now(), head, v: verifyAuditChain(db) };   // verifying every row on every page view would grow without bound
  return { items: rows(db, 'SELECT id,at,actor,action,target,detail FROM audit ORDER BY id DESC LIMIT 200'), chain: chainCache.v };
});
route('GET', '/api/layout', ({ db }) => { const r = row(db, "SELECT json FROM layouts WHERE key='universe'") as any; return r ? JSON.parse(r.json) : {}; });
route('PUT', '/api/layout', ({ db, body }) => {
  const b = parse(z.record(z.string().max(40), z.object({ x: z.number().min(-200).max(200), y: z.number().min(-200).max(200) })), body);
  db.prepare("INSERT INTO layouts(key,json,updated_at) VALUES('universe',?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at").run(JSON.stringify(b), now());
  return { ok: true };
});
route('DELETE', '/api/layout', ({ db }) => { db.prepare("DELETE FROM layouts WHERE key='universe'").run(); return { ok: true }; });
route('GET', '/api/chat', ({ db }) => rows(db, 'SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 100) ORDER BY id'));
route('POST', '/api/chat', async ({ db, body }) => { const b = parse(z.object({ text: z.string().min(1).max(2000), private: z.boolean().default(false), channel: z.enum(['dashboard', 'phone', 'car', 'sms', 'voice']).default('dashboard') }), body); return await converse(db, b.text, { private: b.private, channel: b.channel }); });

// ---- persona + model layer (keys are never returned; only "configured" flags) ----
route('GET', '/api/persona', ({ db }) => getPersona(db));
route('PUT', '/api/persona', ({ db, body }) => { const r = personaSchema.safeParse(body); if (!r.success) throw bad(r.error.issues[0]?.message ?? 'invalid persona'); return setPersona(db, r.data); });
route('GET', '/api/llm', ({ db }) => ({
  providers: Object.values(gw.registry.providers).map((p) => ({ id: p.id, configured: p.available() })),
  anthropicKeyConfigured: hasSecret('anthropic'),
  config: gw.getConfig(db), routes: Object.fromEntries(mroutes.ROUTABLE.map((t) => [t, mroutes.effective(db, t)])), usage: gw.usageSummary(db), spentTodayMicroUsd: gw.spentToday(db),
  note: 'Keys live server-side only (env var or data/secrets.json, mode 0600). Set with: npm run secret:set -- anthropic',
}));
route('PUT', '/api/llm/config', ({ db, body }) => {
  const b = parse(z.object({ dailyCeilingUsd: z.number().min(0).max(100).optional(), strongEnabled: z.boolean().optional(), allowInPrivate: z.boolean().optional() }), body);
  const cur = gw.getConfig(db); let approvalId: string | undefined;
  if (b.dailyCeilingUsd !== undefined) {
    const next = Math.round(b.dailyCeilingUsd * 1e6);
    if (next > cur.dailyCeilingMicroUsd) approvalId = appr.requestApproval(db, { actionType: 'raise_daily_ceiling', payload: { newCeilingMicroUsd: next }, requestedBy: 'luke' }); // raising spend needs approval
    else gw.setConfig(db, { dailyCeilingMicroUsd: next });
  }
  // Sending private-session content to a provider is an access/privacy change: enabling needs a deliberate toggle, audited.
  if (b.strongEnabled !== undefined) gw.setConfig(db, { strongEnabled: b.strongEnabled });
  if (b.allowInPrivate !== undefined) { gw.setConfig(db, { allowInPrivate: b.allowInPrivate }); audit(db, 'luke', 'llm.allow_in_private', String(b.allowInPrivate)); }
  return { config: gw.getConfig(db), approvalId };
});
route('POST', '/api/llm/test', async ({ db }) => { const r = await gw.complete(db, { task: 'ping', system: 'Reply with the single word: ready.', messages: [{ role: 'user', content: 'ping' }] }); return r.ok ? { ok: true, model: r.model, costMicroUsd: r.costMicroUsd } : { ok: false, error: r.error, kind: r.kind }; });
route('POST', '/api/backup', ({ db }) => {
  const f = path.join(config.dataDir, 'backups', `jarvis-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  backupTo(db, f); audit(db, 'luke', 'backup.created', path.basename(f));
  const dir = path.dirname(f); for (const old of fs.readdirSync(dir).filter((x) => /^jarvis-.*\.db$/.test(x)).sort().slice(0, -7)) fs.rmSync(path.join(dir, old), { force: true });   // keep the newest 7 plaintext snapshots return { file: path.basename(f), note: 'Unencrypted local snapshot. Encrypt before copying off this machine.' };
});

/** Behind HTTPS the cookie is __Host- prefixed (Secure, Path=/, no Domain): a sibling host on the same parent domain cannot plant or shadow it. */
const plainCookie = () => (config.host === '127.0.0.1' || config.host === 'localhost') && !config.publicHttps;
const COOKIE = () => (plainCookie() ? 'jarvis_session' : '__Host-jarvis_session');
const sessionCookie = (token: string, maxAge: number) => `${COOKIE()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${plainCookie() ? '' : '; Secure'}`;
function cookie(req: http.IncomingMessage) { return new RegExp(`(?:^|;\\s*)${COOKIE()}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1]; }

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function createServer(db: DB, opts: { webDir?: string; allowedHosts?: string[] } = {}) {
  const webDir = opts.webDir ?? path.join(import.meta.dirname, '..', 'web', 'dist');
  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };

  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (config.publicHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status: number, data: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    try {
      // DNS-rebinding defence: only answer for expected Host headers.
      const host = (req.headers.host ?? '').toLowerCase();
      const okHosts = opts.allowedHosts ?? [`localhost:${config.port}`, `127.0.0.1:${config.port}`, 'localhost:5173', '127.0.0.1:5173', ...config.allowedHosts];
      if (!okHosts.includes(host)) return send(421, { error: 'unexpected host' });
      const url = new URL(req.url ?? '/', `http://${host}`);

      if (url.pathname === '/go' || url.pathname === '/go/') res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');   // only the phone/car page may ask for the mic (voice input)
      if (!url.pathname.startsWith('/api/')) return serveStatic(webDir, url.pathname, res, MIME);

      const session = auth.getSession(db, cookie(req));
      if (url.pathname === '/api/events') {
        if (!session) return send(401, { error: 'login required' });
        if (clients.n >= 12) return send(429, { error: 'too many open streams' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': ok\n\n');
        const on = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        const tok = cookie(req);
        clients.n++; bus.on('event', on);
        const ka = setInterval(() => { if (!auth.getSession(db, tok)) { res.end(); return; } res.write(': ka\n\n'); }, 20000);   // a logged-out or expired session stops receiving events
        req.on('close', () => { clients.n--; bus.off('event', on); clearInterval(ka); });
        return;
      }
      const method = req.method ?? 'GET';
      const dl = method === 'GET' ? /^\/api\/bridge\/backups\/(jarvis-\d{8}-\d{6}\.jvbk)$/.exec(url.pathname) : null;
      if (dl) {   // a raw file stream, for the Mac helper only (the pre-check below has already verified its credential)
        const v = bridge.verify(db, req.headers.authorization); if (!v.ok) return send(v.status, { error: v.error });
        const f = backupPath(backupDir(), dl[1]); if (!f) return send(404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f).size, 'Content-Disposition': `attachment; filename="${dl[1]}"` }); fs.createReadStream(f).pipe(res); return;
      }
      const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
      if (!r) return send(404, { error: 'not found' });
      if (!r.open && !session) return send(401, { error: 'login required' });
      if (method !== 'GET') {
        const origin = req.headers.origin;
        let originHost = ''; try { originHost = origin ? new URL(origin).host : host; } catch { return send(403, { error: 'cross-origin request blocked' }); }   // 'Origin: null' etc.
        if (origin && originHost !== host) return send(403, { error: 'cross-origin request blocked' });
        if (session && !r.open && req.headers['x-jarvis-csrf'] !== session.csrf) return send(403, { error: 'missing CSRF token' });
      }
      if (url.pathname.startsWith('/api/device/')) { const v = dev.authenticate(db, req.headers.authorization, null, Date.now(), false); if (!v.ok) return send(v.status, { error: v.error }); }   // a device's credential is checked before any body is read
      if (url.pathname.startsWith('/api/bridge/') && url.pathname !== '/api/bridge/token') { const v = bridge.verify(db, req.headers.authorization); if (!v.ok) return send(v.status, { error: v.error }); }   // check the helper's credential BEFORE reading a (possibly 6 MB) body
      let body: any = undefined;
      if (method !== 'GET' && method !== 'DELETE') {
        const chunks: Buffer[] = []; let n = 0;
        for await (const c of req) { n += (c as Buffer).length; if (n > (url.pathname.startsWith('/api/bridge/') || url.pathname === '/api/knowledge/import' || url.pathname === '/api/imports' ? 6 * 1024 * 1024 : 256 * 1024)) return send(413, { error: 'body too large' }); chunks.push(c as Buffer); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { error: 'invalid JSON' }); }
      }
      const m = r.re.exec(url.pathname)!;
      let params: Record<string, string>; try { params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])); } catch { return send(400, { error: 'bad request' }); }
      const out = await r.h({ req, res, db, session, params, body, url });
      send(200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error('[api error]', (e as Error).message); // message only; never log request bodies
      send(500, { error: 'internal error' });
    }
  });
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse, mime: Record<string, string>) {
  let rel: string; try { rel = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, ''); } catch { res.statusCode = 400; res.end('bad request'); return; }
  if (rel === '/' || rel === '.') rel = 'index.html';
  if (rel === '/go' || rel === '/go/') rel = 'go.html';   // the phone/car page: static, holds no data, talks to /api/device/* with a device key
  let file = path.join(root, rel);
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Web build not found. Run `npm run build`, or use `npm run web` for the dev server.'); }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', rel.startsWith('/assets/') || rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
  fs.createReadStream(file).pipe(res);
}
