/**
 * Crash-recovery drill with REAL processes: SIGKILL the worker mid-job, SIGKILL the web server while a browser-style SSE client is connected.
 * Throwaway database; nothing else is touched.   npm run drill:recovery
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { openSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BASE = process.env.DATABASE_ADMIN_URL ?? 'postgres://relay:relay_dev_only@localhost:5432/relay_test';
const DB = 'relay_drill_rec'; const URL_ = BASE.replace(/\/[^/]*$/, `/${DB}`); const PORT = 4292;
const work = path.resolve('data/drill-rec'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
const env = { ...process.env, DATABASE_URL: URL_, RELAY_ENV: 'development', PORT: String(PORT), RELAY_TEST_JOBS: '1', JOB_LEASE_SECONDS: '5', SANDBOX_WORKER_SYNC: '0', MEDIA_DIR: path.join(work, 'media') } as NodeJS.ProcessEnv;
const results: [string, boolean][] = []; const check = (n: string, ok: boolean, d = '') => { results.push([n, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (what: string, fn: () => Promise<boolean>, ms = 40000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return; await sleep(300); } throw new Error(`timed out: ${what}`); };
async function admin(sql: string) { const c = new pg.Client({ connectionString: BASE }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }
const db = new pg.Client({ connectionString: URL_ });
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
const spawnProc = (script: string, name: string): ChildProcess => { const log = openSync(path.join(work, `${name}.log`), 'a'); return spawn('npx', ['tsx', script], { env, stdio: ['ignore', log, log], detached: true }); };
const kill9 = (p: ChildProcess) => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* gone */ } };
const live: ChildProcess[] = [];
const http = async (cookie: string, method: string, url: string, body?: unknown) => { const r = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { cookie, 'x-relay-csrf': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); if (!r.ok) throw new Error(`${url} ${r.status} ${t}`); return t ? JSON.parse(t) : null; };
const waitReady = () => until('server ready', async () => (await fetch(`http://127.0.0.1:${PORT}/ready`)).ok);
const login = async () => { const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-csrf': '1' }, body: JSON.stringify({ email: 'owner@demo.relay.test', password: 'relay-demo-password' }) }); return String(r.headers.get('set-cookie')).split(';')[0]; };

try {
  await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); await admin(`CREATE DATABASE ${DB}`);
  const seed = spawnSync('npx', ['tsx', 'src/db/seed.ts'], { env, encoding: 'utf8' }); if (seed.status !== 0) throw new Error(seed.stderr);
  await db.connect();
  let server = spawnProc('src/server/main.ts', 'server'); live.push(server); await waitReady();
  let worker = spawnProc('src/worker/main.ts', 'worker-1'); live.push(worker);
  const cookie = await login();

  // --- A. worker killed mid-job
  await until('worker heartbeat', async () => (await q('SELECT 1 FROM worker_heartbeats')).length > 0);
  const st0 = await http(cookie, 'GET', '/api/admin/status'); check('admin status sees a live worker', st0.workers.some((w: any) => w.alive));
  await q(`INSERT INTO jobs (kind, payload, dedupe_key, max_attempts) VALUES ('test_sleep', '{"ms": 6000}', 'drill-sleep', 5)`);
  await until('job started', async () => (await q(`SELECT 1 FROM audit_events WHERE action='test_sleep.started'`)).length === 1);
  kill9(worker);                                                  // no chance to clean up: simulates power loss / OOM kill
  await sleep(500);
  const mid = (await q(`SELECT status, attempts FROM jobs WHERE dedupe_key='drill-sleep'`))[0];
  check('after SIGKILL the job is left "running" (lease held, not lost)', mid.status === 'running' && mid.attempts === 1, JSON.stringify(mid));
  // while no worker is alive, texts queue durably rather than vanish
  const contact = await http(cookie, 'POST', '/api/contacts', { firstName: 'Recovery', phone: '(414) 555-0199' });
  const conv = await http(cookie, 'POST', '/api/conversations', { contactId: contact.id });
  await http(cookie, 'POST', `/api/conversations/${conv.id}/messages`, { body: 'Sent while the worker was down', idempotencyKey: 'drill-down-0001' });
  check('a text sent while the worker is dead is queued, not lost', (await q(`SELECT status FROM messages WHERE direction='outbound'`))[0].status === 'queued');
  const t0 = Date.now(); worker = spawnProc('src/worker/main.ts', 'worker-2'); live.push(worker);
  await until('job reclaimed and finished', async () => (await q(`SELECT 1 FROM jobs WHERE dedupe_key='drill-sleep' AND status='done'`)).length === 1, 45000);
  const fin = (await q(`SELECT attempts FROM jobs WHERE dedupe_key='drill-sleep'`))[0];
  const started = (await q(`SELECT count(*)::int n FROM audit_events WHERE action='test_sleep.started'`))[0].n, done = (await q(`SELECT count(*)::int n FROM audit_events WHERE action='test_sleep.done'`))[0].n;
  check('new worker reclaimed the abandoned job after the lease and completed it exactly once', fin.attempts === 2 && started === 2 && done === 1, `attempts=${fin.attempts} started=${started} completed=${done} recovered in ${Math.round((Date.now() - t0) / 1000)}s`);
  await until('queued text sent', async () => (await q(`SELECT 1 FROM messages WHERE direction='outbound' AND status IN ('provider_accepted','delivered')`)).length === 1);
  check('the queued text went out exactly once after recovery', (await q(`SELECT count(*)::int n FROM messages WHERE direction='outbound'`))[0].n === 1);
  const st1 = await http(cookie, 'GET', '/api/admin/status'); check('admin status shows the new worker alive', st1.workers.some((w: any) => w.alive));

  // --- B. web server killed while a browser-style SSE client is connected
  const events: string[] = []; let stop = false; let connects = 0;
  (async () => { while (!stop) { try { connects++; const r = await fetch(`http://127.0.0.1:${PORT}/api/events`, { headers: { cookie } }); const rd = r.body!.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; events.push(new TextDecoder().decode(value)); } } catch { /* server down */ } await sleep(2000); } })();   // EventSource-style: retry: 2000
  await until('SSE connected', async () => events.join('').includes('retry: 2000'));
  await http(cookie, 'POST', '/api/dev/simulate-inbound', { from: '(414) 555-0199', body: 'before crash' });
  await until('live event before crash', async () => events.join('').includes('message.created'));
  kill9(server); await sleep(1500);
  check('server is down (SIGKILL)', await fetch(`http://127.0.0.1:${PORT}/health`).then(() => false, () => true));
  server = spawnProc('src/server/main.ts', 'server-2'); live.push(server); await waitReady();
  await until('SSE client reconnected', async () => connects >= 2 && events.join('').split('retry: 2000').length >= 3);
  check('SSE client reconnected on its own to the restarted server', true, `connections=${connects}`);
  const cookie2 = await login(); const mark = events.length;
  await http(cookie2, 'POST', '/api/dev/simulate-inbound', { from: '(414) 555-0199', body: 'after restart' });
  await until('live event after restart', async () => events.slice(mark).join('').includes('message.created'));
  check('live events flow again after the restart (sessions survive: they are in the database)', true);
  check('no customer message lost across the crash', (await q(`SELECT count(*)::int n FROM messages WHERE direction='inbound'`))[0].n === 2);
  stop = true;
} catch (e) { check('drill completed without exception', false, (e as Error).message); }
finally {
  for (const p of live) kill9(p); await sleep(500); await db.end().catch(() => {});
  await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => {}); if (!process.env.KEEP_DRILL) rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r[1]).length; console.log(`\n${results.length - failed}/${results.length} checks passed`); process.exit(failed ? 1 : 0);
