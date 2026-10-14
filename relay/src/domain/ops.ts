import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export const WORKER_ID = `${hostname()}:${process.pid}`;
/** A worker that has not beaten for this long is considered down. */
export const WORKER_STALE_SECONDS = 30;
export const sseStats = { subscribers: 0, listenerReconnects: 0, lastResyncAt: null as string | null };
export const httpStats = { total: 0, byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<string, number> };

export async function beat(jobsDone: number) {
  await pool.query(`INSERT INTO worker_heartbeats (id, pid, jobs_done) VALUES ($1,$2,$3)
    ON CONFLICT (id) DO UPDATE SET beat_at=now(), jobs_done=EXCLUDED.jobs_done`, [WORKER_ID, process.pid, jobsDone]);
  await pool.query(`DELETE FROM worker_heartbeats WHERE beat_at < now() - interval '1 day'`);
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
/** Ready = database reachable AND every shipped migration applied. (A server running against an older schema must not take traffic.) */
export async function readiness(): Promise<{ ready: boolean; checks: Record<string, string> }> {
  const checks: Record<string, string> = {};
  try {
    await pool.query('SELECT 1'); checks.database = 'ok';
    const have = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const want = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const missing = want.filter((f) => !have.has(f));
    checks.migrations = missing.length ? `missing: ${missing.join(', ')}` : 'ok';
  } catch (e) { checks.database = `error: ${(e as Error).message.slice(0, 120)}`; }
  return { ready: Object.values(checks).every((v) => v === 'ok') && !!checks.migrations, checks };
}

export function latestBackup(): { dir: string; createdAt: string; ageHours: number; rowCounts: Record<string, number> } | null {
  if (!config.backupDir || !existsSync(config.backupDir)) return null;
  const dirs = readdirSync(config.backupDir).filter((d) => d.startsWith('relay-backup-')).sort();
  const last = dirs[dirs.length - 1]; if (!last) return null;
  try {
    const m = JSON.parse(readFileSync(path.join(config.backupDir, last, 'MANIFEST.json'), 'utf8'));
    const t = Date.parse(String(m.createdAt).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    return { dir: last, createdAt: m.createdAt, ageHours: Math.round((Date.now() - t) / 360_000) / 10, rowCounts: m.rowCounts };
  } catch { return null; }
}

export async function systemStatus(workspaceId?: string) {
  const workers = (await pool.query(`SELECT id, pid, started_at, beat_at, jobs_done, extract(epoch from now()-beat_at)::int AS age FROM worker_heartbeats ORDER BY beat_at DESC LIMIT 20`)).rows
    .map((w) => ({ id: w.id, pid: w.pid, startedAt: w.started_at, lastBeatSecondsAgo: w.age, jobsDone: Number(w.jobs_done), alive: w.age < WORKER_STALE_SECONDS }));
  const q = (await pool.query(`SELECT
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='running')::int AS running,
      count(*) FILTER (WHERE status='failed')::int AS failed,
      count(*) FILTER (WHERE status='pending' AND run_at < now() - interval '60 seconds')::int AS overdue,
      count(*) FILTER (WHERE status='running' AND locked_until < now())::int AS expired_leases,
      COALESCE(extract(epoch from now() - min(run_at) FILTER (WHERE status='pending' AND run_at <= now()))::int, 0) AS oldest_due_seconds
    FROM jobs`)).rows[0];
  const failedKinds = (await pool.query(`SELECT kind, count(*)::int n, max(last_error) AS last_error FROM jobs WHERE status='failed' AND finished_at > now() - interval '7 days' GROUP BY kind ORDER BY n DESC LIMIT 10`)).rows;
  const unknown = (await pool.query(`SELECT count(*)::int n FROM messages WHERE status='unknown'`)).rows[0].n;
  const dead = (await pool.query(`SELECT count(*)::int n FROM webhook_deliveries WHERE status='dead'`)).rows[0].n;
  const assistants = (await pool.query(`SELECT i.id, i.name, i.status, i.last_used_at, i.push_last_error,
      (SELECT coalesce(max(seq),0) FROM service_events e WHERE e.workspace_id=i.workspace_id) - i.ack_cursor AS backlog FROM service_identities i ORDER BY i.name`)).rows
    .map((a) => ({ id: a.id, name: a.name, status: a.status, lastUsedAt: a.last_used_at, unackedEvents: Number(a.backlog), pushError: a.push_last_error }));
  const paused = workspaceId ? (await pool.query('SELECT global_automation_pause FROM workspaces WHERE id=$1', [workspaceId])).rows[0]?.global_automation_pause ?? null : null;
  const ready = await readiness();
  const problems: string[] = [];
  if (!workers.some((w) => w.alive)) problems.push('No worker heartbeat in the last 30s: queued texts, scheduled sends and automations are NOT running.');
  if (q.oldest_due_seconds > 120) problems.push(`Oldest due job has waited ${q.oldest_due_seconds}s.`);
  if (q.failed) problems.push(`${q.failed} job(s) failed permanently.`);
  if (unknown) problems.push(`${unknown} message(s) have an unknown delivery outcome and need a person to verify.`);
  if (dead) problems.push(`${dead} webhook delivery(ies) gave up.`);
  if (!ready.ready) problems.push(`Not ready: ${JSON.stringify(ready.checks)}`);
  const backup = latestBackup(); if (config.backupDir && !backup) problems.push('BACKUP_DIR is set but no backup was found.'); else if (backup && backup.ageHours > 36) problems.push(`Latest backup is ${backup.ageHours}h old.`);
  return { ok: problems.length === 0, problems, ready, workers, queue: { ...q, failedKinds }, unknownMessages: unknown, deadWebhookDeliveries: dead, assistants, realtime: { ...sseStats }, backup, globalAutomationPause: paused, env: config.env };
}

export async function metricsText(): Promise<string> {
  const st = await systemStatus();
  const L: string[] = [];
  const g = (name: string, help: string, v: number, labels = '') => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${v}`); };
  g('relay_workers_alive', 'Workers with a heartbeat in the last 30s', st.workers.filter((w) => w.alive).length);
  for (const k of ['pending', 'running', 'failed', 'overdue', 'expired_leases'] as const) L.push(`relay_jobs{state="${k}"} ${st.queue[k]}`);
  g('relay_job_oldest_due_seconds', 'Age of the oldest due, unclaimed job', st.queue.oldest_due_seconds);
  g('relay_messages_unknown', 'Outbound messages with unverified outcome', st.unknownMessages);
  g('relay_webhook_deliveries_dead', 'Webhook deliveries that gave up', st.deadWebhookDeliveries);
  g('relay_sse_subscribers', 'Open realtime connections on this process', st.realtime.subscribers);
  g('relay_sse_listener_reconnects_total', 'Times the realtime LISTEN connection was re-established', st.realtime.listenerReconnects);
  g('relay_ready', '1 when database reachable and migrations current', st.ready.ready ? 1 : 0);
  L.push('# TYPE relay_http_responses_total counter'); for (const [c, n] of Object.entries(httpStats.byClass)) L.push(`relay_http_responses_total{class="${c}"} ${n}`);
  if (st.backup) g('relay_backup_age_hours', 'Age of the newest backup manifest', st.backup.ageHours);
  return L.join('\n') + '\n';
}

/**
 * Refuses to boot a production process with development defaults. Returns the problems (empty = fine); callers exit on a non-empty list.
 * Takes the config as an argument so it can be tested without touching process.env.
 */
export function productionProblems(c: Pick<typeof config, 'env' | 'databaseUrl' | 'credentialKeyHex' | 'credentialKeysJson' | 'mediaSigningKey' | 'simulatorWebhookSecret' | 'publicBaseUrl' | 'secureCookies' | 'testJobs' | 'allowSandboxInProduction' | 'trustProxy'>): string[] {
  if (c.env !== 'production') return [];
  const p: string[] = [];
  if (/relay_dev_only|CHANGE_ME/i.test(c.databaseUrl)) p.push('DATABASE_URL still uses the development password.');
  if (!c.credentialKeyHex && !c.credentialKeysJson) p.push('CREDENTIAL_KEYS (or CREDENTIAL_KEY_HEX) is not set: stored integration credentials would use the public development key.');
  if (c.mediaSigningKey === 'dev-media-signing-key' || c.mediaSigningKey.length < 24) p.push('MEDIA_SIGNING_KEY is the development default or shorter than 24 characters.');
  if (c.simulatorWebhookSecret === 'dev-simulator-secret' || /^change-?me$/i.test(c.simulatorWebhookSecret) || c.simulatorWebhookSecret.length < 24) p.push('SIM_WEBHOOK_SECRET is the development default or too short (anyone who knows it can forge inbound texts to the simulator).');
  if (!/^https:\/\//.test(c.publicBaseUrl)) p.push('PUBLIC_BASE_URL must be an https:// URL.');
  if (!c.secureCookies) p.push('Secure cookies are off.');
  if (c.testJobs) p.push('RELAY_TEST_JOBS must not be enabled in production.');
  if (c.allowSandboxInProduction) p.push('ALLOW_SANDBOX=1: sandbox adapters (fake payments/reviews) are enabled in production. Remove this unless this is a deliberate demo environment.');
  if (c.trustProxy === true) p.push('TRUST_PROXY=true trusts every hop; set it to the number of proxies in front of Relay (e.g. 1) or their addresses.');
  return p;
}
export function assertProductionConfig() {
  const p = productionProblems(config);
  if (p.length) { console.error('Refusing to start in production:\n - ' + p.join('\n - ')); process.exit(78); }
}
