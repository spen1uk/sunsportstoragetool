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
import * as bridge from './bridge.ts';
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

// Liveness for an outside watcher or the process manager. Reveals nothing but "up".
route('GET', '/api/health', () => ({ ok: true }), true);

// ---- auth ----
route('POST', '/api/login', ({ db, body, res }) => {
  const { passphrase } = parse(z.object({ passphrase: z.string().min(1).max(200) }), body);
  const r = auth.login(db, passphrase);
  if ('error' in r) throw new HttpError(r.retryAfterMs ? 429 : 401, r.error);
  const loopback = config.host === '127.0.0.1' || config.host === 'localhost';
  const secure = loopback && !config.publicHttps ? '' : '; Secure'; // browsers treat http://localhost as a secure context; anything else (or anything behind an HTTPS front door) must be Secure
  res.setHeader('Set-Cookie', `jarvis_session=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionTtlMs / 1000}${secure}`);
  return { csrf: r.csrf };
}, true);
route('POST', '/api/logout', ({ db, req, res }) => {
  const t = cookie(req); if (t) auth.logout(db, t);
  res.setHeader('Set-Cookie', 'jarvis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return { ok: true };
}, true);
route('GET', '/api/me', ({ session, db }) => session ? { authenticated: true, csrf: session.csrf, stepUp: auth.hasStepUp(session) } : { authenticated: false, configured: auth.isConfigured(db) }, true);
route('POST', '/api/stepup', ({ db, session, body }) => {
  const { passphrase } = parse(z.object({ passphrase: z.string().min(1).max(200) }), body);
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
const guard = <T,>(f: () => T): T => { try { return f(); } catch (e) { throw bad(e instanceof z.ZodError ? (e.issues[0]?.message ?? 'invalid input') : (e as Error).message); } };
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
  if (b.decision === 'deny') { tasks.resumeForApproval(db, params.id, false); return { ok: true }; }
  const ex = appr.execute(db, params.id);
  if (ex.ok) tasks.resumeForApproval(db, params.id, true);
  return { ok: true, executed: ex.ok, outcome: ex.outcome };
});
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
route('GET', '/api/bridge', ({ db }) => bridge.status(db));
route('POST', '/api/bridge/token', ({ db, session }) => { if (!auth.hasStepUp(session!)) throw new HttpError(403, 'step-up confirmation required'); return { token: bridge.createToken(db) }; });
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
route('GET', '/api/memory/suggestions', ({ db }) => ({ items: msug.listSuggestions(db), auto: msug.autoEnabled(db), lastRun: msug.lastRun(db), modelReady: gw.ready(db, 'chat') }));
route('POST', '/api/memory/suggest', async ({ db }) => msug.suggestFromChat(db));
route('PUT', '/api/memory/suggest-settings', ({ db, body }) => { msug.setAuto(db, parse(z.object({ auto: z.boolean() }), body).auto); return { auto: msug.autoEnabled(db) }; });
route('POST', '/api/memory/suggestions/:id/accept', ({ db, params, body }) => { const r = msug.accept(db, params.id, parse(z.object({ content: z.string().min(3).max(300).optional() }), body).content); if (!r.ok) throw bad(r.error ?? 'failed'); return r; });
route('POST', '/api/memory/suggestions/:id/reject', ({ db, params }) => ({ ok: msug.reject(db, params.id) }));
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
route('GET', '/api/activity', ({ db }) => ({ items: rows(db, 'SELECT id,at,actor,action,target,detail FROM audit ORDER BY id DESC LIMIT 200'), chain: verifyAuditChain(db) }));
route('GET', '/api/layout', ({ db }) => { const r = row(db, "SELECT json FROM layouts WHERE key='universe'") as any; return r ? JSON.parse(r.json) : {}; });
route('PUT', '/api/layout', ({ db, body }) => {
  const b = parse(z.record(z.string().max(40), z.object({ x: z.number().min(-200).max(200), y: z.number().min(-200).max(200) })), body);
  db.prepare("INSERT INTO layouts(key,json,updated_at) VALUES('universe',?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at").run(JSON.stringify(b), now());
  return { ok: true };
});
route('DELETE', '/api/layout', ({ db }) => { db.prepare("DELETE FROM layouts WHERE key='universe'").run(); return { ok: true }; });
route('GET', '/api/chat', ({ db }) => rows(db, 'SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 100) ORDER BY id'));
route('POST', '/api/chat', async ({ db, body }) => { const b = parse(z.object({ text: z.string().min(1).max(2000), private: z.boolean().default(false) }), body); return await converse(db, b.text, { private: b.private }); });

// ---- persona + model layer (keys are never returned; only "configured" flags) ----
route('GET', '/api/persona', ({ db }) => getPersona(db));
route('PUT', '/api/persona', ({ db, body }) => { const r = personaSchema.safeParse(body); if (!r.success) throw bad(r.error.issues[0]?.message ?? 'invalid persona'); return setPersona(db, r.data); });
route('GET', '/api/llm', ({ db }) => ({
  providers: Object.values(gw.registry.providers).map((p) => ({ id: p.id, configured: p.available() })),
  anthropicKeyConfigured: hasSecret('anthropic'),
  config: gw.getConfig(db), routes: gw.DEFAULT_ROUTES, usage: gw.usageSummary(db), spentTodayMicroUsd: gw.spentToday(db),
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
  backupTo(db, f); audit(db, 'luke', 'backup.created', path.basename(f)); return { file: path.basename(f), note: 'Unencrypted local snapshot. Encrypt before copying off this machine.' };
});

function cookie(req: http.IncomingMessage) { return /(?:^|;\s*)jarvis_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; }

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

      if (!url.pathname.startsWith('/api/')) return serveStatic(webDir, url.pathname, res, MIME);

      const session = auth.getSession(db, cookie(req));
      if (url.pathname === '/api/events') {
        if (!session) return send(401, { error: 'login required' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': ok\n\n');
        const on = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        clients.n++; bus.on('event', on); const ka = setInterval(() => res.write(': ka\n\n'), 20000);
        req.on('close', () => { clients.n--; bus.off('event', on); clearInterval(ka); });
        return;
      }
      const method = req.method ?? 'GET';
      const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
      if (!r) return send(404, { error: 'not found' });
      if (!r.open && !session) return send(401, { error: 'login required' });
      if (method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== host) return send(403, { error: 'cross-origin request blocked' });
        if (session && !r.open && req.headers['x-jarvis-csrf'] !== session.csrf) return send(403, { error: 'missing CSRF token' });
      }
      let body: any = undefined;
      if (method !== 'GET' && method !== 'DELETE') {
        const chunks: Buffer[] = []; let n = 0;
        for await (const c of req) { n += (c as Buffer).length; if (n > (url.pathname.startsWith('/api/bridge/') ? 6 * 1024 * 1024 : 256 * 1024)) return send(413, { error: 'body too large' }); chunks.push(c as Buffer); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { error: 'invalid JSON' }); }
      }
      const m = r.re.exec(url.pathname)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
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
  let rel = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '.') rel = 'index.html';
  let file = path.join(root, rel);
  if (!file.startsWith(root)) { res.statusCode = 403; return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('Web build not found. Run `npm run build`, or use `npm run web` for the dev server.'); }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
  fs.createReadStream(file).pipe(res);
}
