import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { pool, tx } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from '../domain/authz.js';
import { audit, publish } from '../domain/events.js';
import { enqueue } from '../domain/queue.js';
import { notify } from '../domain/notifications.js';
import { PermanentAuthError, TransientError, getAdapter, type Credentials, type ProviderAdapter, type SyncPage } from './adapter.js';
import { CATALOG } from './catalog.js';
import { config } from '../config.js';
import { decryptJson, encryptJson, maskSecrets, rotate } from './crypto.js';
import './demo/adapters.js';

export interface ConnRow { id: string; workspace_id: string; provider: string; display_name: string; status: string; auth_type: string; scopes: string[]; read_enabled: boolean; write_enabled: boolean; credentials_enc: string | null; credentials_meta: any; last_success_sync_at: Date | null; last_error: string | null; error_count: number }
const aad = (id: string) => `conn:${id}`;
const admin = (a: Actor) => { if (!isAdmin(a)) throw new HttpError(403, 'owner or admin required to manage connections'); };

// Per-resource appliers register themselves (reviews.ts) so this module stays provider/domain agnostic.
type Applier = (conn: ConnRow, page: SyncPage) => Promise<{ created: number; updated: number; skipped: number }>;
const appliers = new Map<string, Applier>();
export const registerSyncApplier = (resource: string, fn: Applier) => { appliers.set(resource, fn); };

const safeView = (c: any) => ({ id: c.id, provider: c.provider, displayName: c.display_name, status: c.status, authType: c.auth_type, scopes: c.scopes, readEnabled: c.read_enabled, writeEnabled: c.write_enabled, account: c.credentials_meta?.accountLabel ?? null, tokenExpiresAt: c.credentials_meta?.expiresAt ?? null, lastSuccessSyncAt: c.last_success_sync_at, lastError: c.last_error, lastErrorAt: c.last_error_at, errorCount: c.error_count, hasCredentials: !!c.credentials_enc });

export async function listIntegrations(a: Actor) {
  const conns = (await pool.query('SELECT * FROM connections WHERE workspace_id=$1', [a.workspaceId])).rows;
  const sync = (await pool.query(`SELECT s.connection_id, s.resource, s.cursor, s.last_success_at, s.last_error FROM sync_state s JOIN connections c ON c.id=s.connection_id WHERE c.workspace_id=$1`, [a.workspaceId])).rows;
  return CATALOG.map((e) => { const c = conns.find((x) => x.provider === e.id); const ad = e.adapter ? getAdapter(e.adapter) : undefined;
    return { ...e, connectable: !!ad, connection: c ? { ...safeView(c), sync: sync.filter((s) => s.connection_id === c.id) } : null, canWrite: !!ad && ad.capabilities.some((x) => x.write) }; });
}

export async function connect(a: Actor, provider: string, creds: Credentials, opts: { writeEnabled?: boolean } = {}) {
  admin(a); const ad = getAdapter(provider); if (!ad) throw new HttpError(409, `${provider} cannot be connected yet: no adapter exists (see the capability matrix for requirements and blockers)`);
  if (ad.sandbox && config.env === 'production' && !config.allowSandboxInProduction) throw new HttpError(409, 'sandbox adapters are disabled in production');
  const existing = (await pool.query('SELECT * FROM connections WHERE workspace_id=$1 AND provider=$2', [a.workspaceId, provider])).rows[0];
  if (existing && ['connected', 'error'].includes(existing.status)) throw new HttpError(409, 'already connected; disconnect first or use re-authorize');
  const v = await validate(ad, creds);
  const id = existing?.id ?? randomUUID(); const { enc, keyVersion } = encryptJson(creds, aad(id));
  const write = !!opts.writeEnabled && ad.capabilities.some((c) => c.write);
  await tx(async (c) => {
    await c.query(
      `INSERT INTO connections (id, workspace_id, provider, display_name, status, auth_type, scopes, read_enabled, write_enabled, credentials_enc, key_version, credentials_meta, created_by)
       VALUES ($1,$2,$3,$4,'connected',$5,$6,true,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET status='connected', scopes=EXCLUDED.scopes, write_enabled=EXCLUDED.write_enabled, credentials_enc=EXCLUDED.credentials_enc, key_version=EXCLUDED.key_version, credentials_meta=EXCLUDED.credentials_meta, last_error=NULL, last_error_at=NULL, error_count=0, revoked_at=NULL`,
      [id, a.workspaceId, provider, ad.displayName, ad.authType, v.scopes, write, enc, keyVersion, JSON.stringify({ accountLabel: v.accountLabel, expiresAt: v.expiresAt ?? creds.expiresAt ?? null }), a.userId]);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'connection.connect', targetType: 'connection', targetId: id, meta: { provider, write } });
    for (const r of ad.syncResources ?? []) await enqueue(c, 'connection_sync', { connectionId: id, resource: r }, { workspaceId: a.workspaceId, dedupeKey: `${id}:${r}` });
  });
  return id;
}
async function validate(ad: ProviderAdapter, creds: Credentials) {
  try { return await ad.validateCredentials(creds); }
  catch (e) { const msg = maskSecrets((e as Error).message, creds); throw new HttpError(e instanceof PermanentAuthError ? 400 : 502, e instanceof PermanentAuthError ? `credentials rejected by the provider: ${msg}` : `could not verify credentials right now: ${msg}`); }
}

export async function getConnection(a: Actor, id: string): Promise<ConnRow> {
  const c = (await pool.query('SELECT * FROM connections WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0]; if (!c) throw new HttpError(404, 'connection not found'); return c;
}
export async function setPermissions(a: Actor, id: string, p: { read?: boolean; write?: boolean }) {
  admin(a); const c = await getConnection(a, id); const ad = getAdapter(c.provider)!;
  if (p.write && !ad.capabilities.some((x) => x.write)) throw new HttpError(409, 'this integration has no write capabilities');
  if (p.write && c.status !== 'connected') throw new HttpError(409, 'connection is not healthy; fix it before enabling writes');
  await pool.query('UPDATE connections SET read_enabled=COALESCE($2,read_enabled), write_enabled=COALESCE($3,write_enabled) WHERE id=$1', [id, p.read ?? null, p.write ?? null]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'connection.permissions', targetType: 'connection', targetId: id, meta: p });
}
/** Every write path calls this first. Reads and writes are separate permissions. */
export function assertWritable(c: ConnRow) { if (c.status !== 'connected') throw new HttpError(409, `connection is ${c.status}`); if (!c.write_enabled) throw new HttpError(403, 'write access is not enabled for this connection (an admin must enable it)'); }

export async function disconnect(a: Actor, id: string) {
  admin(a); const c = await getConnection(a, id); const ad = getAdapter(c.provider)!; let revoked = 'not_attempted';
  if (c.credentials_enc && ad.revoke) { try { await ad.revoke(decryptJson(c.credentials_enc, aad(id))); revoked = 'revoked_at_provider'; } catch (e) { revoked = `provider_revoke_failed: ${maskSecrets((e as Error).message, {})}`; } }
  await tx(async (t) => {
    await t.query(`UPDATE connections SET status='disconnected', credentials_enc=NULL, key_version=NULL, revoked_at=now(), read_enabled=false, write_enabled=false WHERE id=$1`, [id]);   // credentials destroyed immediately
    await t.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE kind='connection_sync' AND status='pending' AND payload->>'connectionId'=$1`, [id]);
    await audit(t, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'connection.disconnect', targetType: 'connection', targetId: id, meta: { revoked } });
  });
  return { revoked };
}

/** Recovery after needs_reauth: validate new credentials, resume from the stored cursor. */
export async function reauthorize(a: Actor, id: string, creds: Credentials) {
  admin(a); const c = await getConnection(a, id); const ad = getAdapter(c.provider)!; const v = await validate(ad, creds);
  const { enc, keyVersion } = encryptJson(creds, aad(id));
  await tx(async (t) => {
    await t.query(`UPDATE connections SET status='connected', credentials_enc=$2, key_version=$3, scopes=$4, credentials_meta=$5, last_error=NULL, last_error_at=NULL, error_count=0, revoked_at=NULL, read_enabled=true WHERE id=$1`, [id, enc, keyVersion, v.scopes, JSON.stringify({ accountLabel: v.accountLabel, expiresAt: v.expiresAt ?? creds.expiresAt ?? null })]);
    await t.query(`UPDATE sync_state SET last_error=NULL, next_attempt_at=NULL WHERE connection_id=$1`, [id]);
    await audit(t, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'connection.reauthorize', targetType: 'connection', targetId: id });
    for (const r of ad.syncResources ?? []) await enqueue(t, 'connection_sync', { connectionId: id, resource: r }, { workspaceId: a.workspaceId, dedupeKey: `${id}:${r}` });
  });
}

export function getCredentials(c: ConnRow): Credentials { if (!c.credentials_enc) throw new PermanentAuthError('no credentials stored'); return decryptJson(c.credentials_enc, aad(c.id)); }
async function adminIds(db: Db, ws: string) { return (await db.query(`SELECT user_id FROM memberships WHERE workspace_id=$1 AND role IN ('owner','admin')`, [ws])).rows.map((r) => r.user_id as string); }

async function markNeedsReauth(c: ConnRow, err: Error, creds?: Credentials) {
  const msg = maskSecrets(err.message, creds ?? {});
  await tx(async (t) => {
    await t.query(`UPDATE connections SET status='needs_reauth', last_error=$2, last_error_at=now(), error_count=error_count+1 WHERE id=$1`, [c.id, msg]);
    await t.query(`UPDATE jobs SET status='cancelled', finished_at=now() WHERE kind='connection_sync' AND status='pending' AND payload->>'connectionId'=$1`, [c.id]);
    await notify(t, { workspaceId: c.workspace_id, userIds: await adminIds(t, c.workspace_id), type: 'connection_needs_reauth', title: `Reconnect ${c.display_name}: authorization expired or was revoked` });
    await audit(t, { workspaceId: c.workspace_id, actorType: 'system', action: 'connection.needs_reauth', targetType: 'connection', targetId: c.id, meta: { error: msg } });
    await publish(t, c.workspace_id, 'connection.updated', { connectionId: c.id });
  });
}
async function recordTransient(c: ConnRow, resource: string | null, err: Error, creds: Credentials | undefined, retryAfterSeconds?: number) {
  const msg = maskSecrets(err.message, creds ?? {}); const n = c.error_count + 1; const delay = retryAfterSeconds ?? Math.min(30 * 2 ** Math.min(n, 7), 3600);
  await pool.query(`UPDATE connections SET last_error=$2, last_error_at=now(), error_count=error_count+1, status=CASE WHEN error_count+1 >= 10 THEN 'error' ELSE status END WHERE id=$1`, [c.id, msg]);
  if (resource) await pool.query(`INSERT INTO sync_state (connection_id, resource, last_error, next_attempt_at) VALUES ($1,$2,$3, now() + ($4||' seconds')::interval) ON CONFLICT (connection_id, resource) DO UPDATE SET last_error=EXCLUDED.last_error, next_attempt_at=EXCLUDED.next_attempt_at`, [c.id, resource, msg, String(delay)]);
  return delay;
}

/** Refresh when the token is about to expire. Permanent refusal → needs_reauth (no retry storm); temporary failure → caller retries with backoff. */
export async function ensureFreshToken(c: ConnRow, force = false): Promise<Credentials> {
  let creds = getCredentials(c); const ad = getAdapter(c.provider)!;
  if (ad.authType !== 'oauth2' || !ad.refresh) return creds;
  const exp = creds.expiresAt ? new Date(creds.expiresAt).getTime() : 0;
  if (!force && exp - Date.now() > 120_000) return creds;
  try { creds = await ad.refresh(creds); }
  catch (e) { if (e instanceof PermanentAuthError) { await markNeedsReauth(c, e, creds); } throw e; }
  const { enc, keyVersion } = encryptJson(creds, aad(c.id));
  await pool.query(`UPDATE connections SET credentials_enc=$2, key_version=$3, credentials_meta = credentials_meta || $4::jsonb WHERE id=$1`, [c.id, enc, keyVersion, JSON.stringify({ expiresAt: creds.expiresAt ?? null })]);
  return creds;
}

/**
 * Run a provider call with fresh credentials. If the provider answers "not authorized", force ONE refresh and retry; if that also fails the
 * connection is flagged needs_reauth. (An auth rejection means the request was not processed, so the single retry cannot double-apply a write.)
 */
export async function withAuth<T>(c: ConnRow, fn: (creds: Credentials) => Promise<T>): Promise<T> {
  let creds = await ensureFreshToken(c);
  try { return await fn(creds); }
  catch (e) {
    if (!(e instanceof PermanentAuthError)) throw e;
    creds = await ensureFreshToken(c, true);        // marks needs_reauth + throws when the refresh is refused
    return fn(creds);
  }
}

const MAX_PAGES = 25;
export async function runSync(connectionId: string, resource: string): Promise<{ status: 'ok' | 'skipped' | 'failed' | 'retry'; fetched?: number; created?: number; updated?: number; skipped?: number; error?: string; retryInSeconds?: number }> {
  const c = (await pool.query('SELECT * FROM connections WHERE id=$1', [connectionId])).rows[0] as ConnRow | undefined;
  if (!c || c.status !== 'connected' || !c.read_enabled) return { status: 'skipped' };
  const ad = getAdapter(c.provider); const apply = appliers.get(resource);
  if (ad?.sandbox && !config.sandboxWorkerSync && process.env.RELAY_PROCESS === 'worker') return { status: 'skipped' };
  if (!ad?.sync || !ad.syncResources?.includes(resource) || !apply) return { status: 'skipped' };
  const run = (await pool.query(`INSERT INTO sync_runs (connection_id, resource) VALUES ($1,$2) RETURNING id`, [connectionId, resource])).rows[0].id;
  const totals = { fetched: 0, created: 0, updated: 0, skipped: 0 }; let creds: Credentials | undefined;
  try {
    let cursor = (await pool.query('SELECT cursor FROM sync_state WHERE connection_id=$1 AND resource=$2', [connectionId, resource])).rows[0]?.cursor ?? null;   // resumes mid-sweep after a failure
    for (let page = 0; page < MAX_PAGES; page++) {
      creds = await ensureFreshToken(c);
      let res: SyncPage;
      try { res = await ad.sync({ creds, resource, cursor }); }
      catch (e) { if (!(e instanceof PermanentAuthError)) throw e; creds = await ensureFreshToken(c, true); res = await ad.sync({ creds, resource, cursor }); }   // one forced refresh, then give up
      const r = await apply(c, res); totals.fetched += res.items.length; totals.created += r.created; totals.updated += r.updated; totals.skipped += r.skipped;
      cursor = res.hasMore ? res.nextCursor : null;
      await pool.query(`INSERT INTO sync_state (connection_id, resource, cursor, last_error) VALUES ($1,$2,$3,NULL) ON CONFLICT (connection_id, resource) DO UPDATE SET cursor=EXCLUDED.cursor, last_error=NULL`, [connectionId, resource, cursor]);   // progress survives a crash
      if (!res.hasMore) break;
    }
    await tx(async (t) => {
      await t.query(`UPDATE sync_state SET last_success_at=now(), next_attempt_at=NULL WHERE connection_id=$1 AND resource=$2`, [connectionId, resource]);
      await t.query(`UPDATE connections SET last_success_sync_at=now(), last_error=NULL, error_count=0, status='connected' WHERE id=$1`, [connectionId]);
      await t.query(`UPDATE sync_runs SET status='ok', finished_at=now(), fetched=$2, created=$3, updated=$4, skipped=$5 WHERE id=$1`, [run, totals.fetched, totals.created, totals.updated, totals.skipped]);
      await publish(t, c.workspace_id, 'connection.updated', { connectionId });
    });
    return { status: 'ok', ...totals };
  } catch (e) {
    const err = e as Error;
    await pool.query(`UPDATE sync_runs SET status='failed', finished_at=now(), fetched=$2, created=$3, updated=$4, skipped=$5, error=$6 WHERE id=$1`, [run, totals.fetched, totals.created, totals.updated, totals.skipped, maskSecrets(err.message, creds ?? {})]);
    if (err instanceof PermanentAuthError) { const cur = (await pool.query('SELECT status FROM connections WHERE id=$1', [connectionId])).rows[0]; if (cur.status === 'connected') await markNeedsReauth(c, err, creds); return { status: 'failed', error: maskSecrets(err.message, creds ?? {}) }; }
    const delay = await recordTransient(c, resource, err, creds, err instanceof TransientError ? err.retryAfterSeconds : undefined);
    return { status: 'retry', error: maskSecrets(err.message, creds ?? {}), retryInSeconds: delay };
  }
}

export const SYNC_INTERVAL_SECONDS = 15 * 60;
/** Periodic: enqueue syncs for healthy connections that are due. */
export async function scanConnections(): Promise<number> {
  let n = 0;
  for (const c of (await pool.query(`SELECT * FROM connections WHERE status='connected' AND read_enabled`)).rows as ConnRow[]) {
    const ad = getAdapter(c.provider); for (const r of ad?.syncResources ?? []) {
      const st = (await pool.query('SELECT last_success_at, next_attempt_at FROM sync_state WHERE connection_id=$1 AND resource=$2', [c.id, r])).rows[0];
      if (st?.next_attempt_at && new Date(st.next_attempt_at) > new Date()) continue;
      if (st?.last_success_at && Date.now() - new Date(st.last_success_at).getTime() < SYNC_INTERVAL_SECONDS * 1000) continue;
      if (await enqueue(pool, 'connection_sync', { connectionId: c.id, resource: r }, { workspaceId: c.workspace_id, dedupeKey: `${c.id}:${r}` })) n++;
    }
  }
  return n;
}
export const scheduleConnectionScan = () => enqueue(pool, 'connection_scan', {}, { runAt: new Date(Date.now() + 300_000), dedupeKey: 'scan' });

/** Re-encrypt every stored secret under the active key. Safe to run repeatedly. */
export async function rotateAllSecrets(): Promise<{ rotated: number }> {
  let rotated = 0;
  for (const [table, prefix, col, ver] of [['connections', 'conn:', 'credentials_enc', 'key_version'], ['webhook_subscriptions', 'wh:', 'secret_enc', 'key_version'], ['inbound_endpoints', 'in:', 'secret_enc', 'key_version']] as const) {
    for (const r of (await pool.query(`SELECT id, ${col} AS enc FROM ${table} WHERE ${col} IS NOT NULL`)).rows) { const x = rotate(r.enc, prefix + r.id); if (x) { await pool.query(`UPDATE ${table} SET ${col}=$2, ${ver}=$3 WHERE id=$1`, [r.id, x.enc, x.keyVersion]); rotated++; } }
  }
  return { rotated };
}
