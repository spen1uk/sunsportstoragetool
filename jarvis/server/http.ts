import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { type DB, now } from './db.ts';
import { config } from './config.ts';
import * as auth from './auth.ts';
import { audit, verifyAuditChain } from './audit.ts';
import { bus } from './events.ts';
import { handleChat } from './chat.ts';
import * as tasks from './tasks.ts';
import * as arts from './artifacts.ts';
import * as appr from './approvals.ts';
import * as memory from './memory.ts';
import * as budget from './budget.ts';
import { pauseStatus, setPaused } from './pause.ts';
import { backupTo } from './backup.ts';
import { researchInput } from './research.ts';

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

// ---- auth ----
route('POST', '/api/login', ({ db, body, res }) => {
  const { passphrase } = parse(z.object({ passphrase: z.string().min(1).max(200) }), body);
  const r = auth.login(db, passphrase);
  if ('error' in r) throw new HttpError(r.retryAfterMs ? 429 : 401, r.error);
  const loopback = config.host === '127.0.0.1' || config.host === 'localhost';
  const secure = loopback ? '' : '; Secure'; // browsers treat http://localhost as a secure context; anything else must be TLS
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
  }), body);
  if (b.kind === 'research' && !b.research) throw bad('research tasks need a question and at least one URL');
  return { id: tasks.createTask(db, { title: b.title, description: b.description, priority: b.priority, projectId: b.projectId, kind: b.kind, input: b.research, idempotencyKey: b.idempotencyKey }) };
});
route('POST', '/api/tasks/:id/complete', ({ db, params }) => {
  const t = row(db, 'SELECT kind FROM tasks WHERE id=?', params.id) as any;
  if (!t) throw new HttpError(404, 'not found');
  if (t.kind !== 'manual') throw bad('Agent tasks complete when you accept their result in Ready for Review.');
  return { ok: tasks.completeTask(db, params.id, 'luke', 'checked off in dashboard') };
});
route('POST', '/api/tasks/:id/reopen', ({ db, params }) => { tasks.reopenTask(db, params.id); return { ok: true }; });
route('POST', '/api/tasks/:id/cancel', ({ db, params }) => { tasks.cancelTask(db, params.id); return { ok: true }; });
route('GET', '/api/projects', ({ db }) => rows(db, 'SELECT * FROM projects ORDER BY is_demo, created_at DESC'));
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

// ---- misc pages ----
route('GET', '/api/connections', ({ db }) => ({ items: rows(db, 'SELECT * FROM connections ORDER BY status, name'), domains: rows(db, 'SELECT * FROM allowed_domains ORDER BY host') }));
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
route('POST', '/api/chat', ({ db, body }) => { const b = parse(z.object({ text: z.string().min(1).max(2000), private: z.boolean().default(false) }), body); return handleChat(db, b.text, { private: b.private }); });
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
    const send = (status: number, data: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    try {
      // DNS-rebinding defence: only answer for expected Host headers.
      const host = (req.headers.host ?? '').toLowerCase();
      const okHosts = opts.allowedHosts ?? [`localhost:${config.port}`, `127.0.0.1:${config.port}`, 'localhost:5173', '127.0.0.1:5173'];
      if (!okHosts.includes(host)) return send(421, { error: 'unexpected host' });
      const url = new URL(req.url ?? '/', `http://${host}`);

      if (!url.pathname.startsWith('/api/')) return serveStatic(webDir, url.pathname, res, MIME);

      const session = auth.getSession(db, cookie(req));
      if (url.pathname === '/api/events') {
        if (!session) return send(401, { error: 'login required' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': ok\n\n');
        const on = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        bus.on('event', on); const ka = setInterval(() => res.write(': ka\n\n'), 20000);
        req.on('close', () => { bus.off('event', on); clearInterval(ka); });
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
        for await (const c of req) { n += (c as Buffer).length; if (n > 256 * 1024) return send(413, { error: 'body too large' }); chunks.push(c as Buffer); }
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return send(400, { error: 'invalid JSON' }); }
      }
      const m = r.re.exec(url.pathname)!;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const out = r.h({ req, res, db, session, params, body, url });
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
