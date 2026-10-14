/**
 * Backup → restore drill. Proves a backup can be restored into a FRESH database and that a real Relay server booted on it serves the same data.
 * Everything runs against throwaway databases (relay_drill_*) on the DATABASE_ADMIN_URL server; nothing touches relay_dev or production.
 *   npm run drill:restore
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const BASE = process.env.DATABASE_ADMIN_URL ?? 'postgres://relay:relay_dev_only@localhost:5432/relay_test';
const urlFor = (db: string) => BASE.replace(/\/[^/]*$/, `/${db}`);
const SRC = 'relay_drill_src', DST = 'relay_drill_restored';
const work = path.resolve('data/drill'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
const KEYS = JSON.stringify({ '1': 'ab'.repeat(32) });
const env = (db: string, extra: Record<string, string> = {}) => ({ ...process.env, DATABASE_URL: urlFor(db), CREDENTIAL_KEYS: KEYS, CREDENTIAL_KEY_ACTIVE: '1', RELAY_ENV: 'development', ...extra }) as NodeJS.ProcessEnv;
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function admin(sql: string) { const c = new pg.Client({ connectionString: BASE }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } }
async function q<T = any>(db: string, sql: string): Promise<T[]> { const c = new pg.Client({ connectionString: urlFor(db) }); await c.connect(); try { return (await c.query(sql)).rows; } finally { await c.end(); } }
function startServer(db: string, port: number, mediaDir: string): ChildProcess {
  const log = openSync(path.join(work, `server-${port}.log`), 'a');
  // detached = own process group, so we can stop npx → tsx → node together (otherwise an orphan keeps the port).
  return spawn('npx', ['tsx', 'src/server/main.ts'], { env: env(db, { PORT: String(port), MEDIA_DIR: mediaDir, SANDBOX_WORKER_SYNC: '0' }), stdio: ['ignore', log, log], detached: true });
}
async function waitReady(port: number) { for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/ready`); if (r.ok) return; } catch { /* not up yet */ } await sleep(500); } throw new Error('server did not become ready'); }
async function login(port: number) {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-csrf': '1' }, body: JSON.stringify({ email: 'owner@demo.relay.test', password: 'relay-demo-password' }) });
  if (!r.ok) throw new Error(`login failed ${r.status}`); return String(r.headers.get('set-cookie')).split(';')[0];
}
const call = async (port: number, cookie: string, method: string, url: string, body?: unknown) => {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { cookie, 'x-relay-csrf': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${t}`); return t ? JSON.parse(t) : null;
};
const killAll = (ps: ChildProcess[]) => { for (const p of ps) try { process.kill(-p.pid!, 'SIGTERM'); } catch { /* gone */ } };

const procs: ChildProcess[] = [];
try {
  for (const d of [SRC, DST]) await admin(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${SRC}`);
  // 1. seed a source workspace, boot a real server on it, create realistic data through the HTTP API
  const seed = spawnSync('npx', ['tsx', 'src/db/seed.ts'], { env: env(SRC), encoding: 'utf8' }); if (seed.status !== 0) throw new Error(seed.stderr);
  const srcMedia = path.join(work, 'media-src'); mkdirSync(srcMedia);
  const server = startServer(SRC, 4290, srcMedia); procs.push(server); await waitReady(4290);
  const cookie = await login(4290);
  const contact = await call(4290, cookie, 'POST', '/api/contacts', { firstName: 'Drill', lastName: 'Customer', phone: '(414) 555-0142' });
  const conv = await call(4290, cookie, 'POST', '/api/conversations', { contactId: contact.id });
  await call(4290, cookie, 'POST', '/api/dev/simulate-inbound', { from: '(414) 555-0142', body: 'Is the 21 ft pontoon still available?' });
  await call(4290, cookie, 'POST', `/api/conversations/${conv.id}/messages`, { body: 'Yes — come see it Saturday.', idempotencyKey: 'drill-msg-0001' });
  await call(4290, cookie, 'POST', `/api/conversations/${conv.id}/notes`, { body: 'Drill note: prefers morning calls' });
  const wh = await call(4290, cookie, 'POST', '/api/webhooks', { url: 'https://93.184.216.34/relay-hook', events: ['*'] });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('file', new Blob([png], { type: 'image/png' }), 'drill.png');
  const up = await fetch('http://127.0.0.1:4290/api/media', { method: 'POST', headers: { cookie, 'x-relay-csrf': '1' }, body: fd }); if (!up.ok) throw new Error(`upload failed ${up.status} ${await up.text()}`);
  const mediaId = (await up.json()).id as string;
  await sleep(1500);
  killAll([server]); await sleep(1000);

  // 2. take the backup with the shipped script
  const bk = spawnSync('bash', ['scripts/backup.sh', path.join(work, 'backups')], { env: { ...env(SRC), MEDIA_DIR: srcMedia }, encoding: 'utf8' }); if (bk.status !== 0) throw new Error(bk.stderr);
  const dir = bk.stdout.trim().split('\n').pop()!;
  const manifest = JSON.parse(readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  check('backup produced dump + media + manifest', existsSync(path.join(dir, 'db.dump')) && existsSync(path.join(dir, 'media.tar.gz')) && manifest.rowCounts.messages >= 2, JSON.stringify(manifest.rowCounts));

  // 3. restore safety checks, then the real restore into a fresh database
  const corrupt = path.join(work, 'corrupt'); cpSync(dir, corrupt, { recursive: true }); const buf = readFileSync(path.join(corrupt, 'db.dump')); buf[buf.length - 10] ^= 0xff; writeFileSync(path.join(corrupt, 'db.dump'), buf);
  await admin(`CREATE DATABASE ${DST}`);
  const bad = spawnSync('bash', ['scripts/restore.sh', corrupt, urlFor(DST)], { encoding: 'utf8' });
  check('damaged backup is refused (checksum) before touching the target', bad.status === 3, `exit ${bad.status}`);
  const dstMedia = path.join(work, 'media-restored');
  const good = spawnSync('bash', ['scripts/restore.sh', dir, urlFor(DST), dstMedia], { encoding: 'utf8' });
  check('restore into a fresh database succeeds', good.status === 0, good.stderr.slice(0, 200));
  const again = spawnSync('bash', ['scripts/restore.sh', dir, urlFor(DST)], { encoding: 'utf8' });
  check('restore refuses a non-empty target', again.status === 4, `exit ${again.status}`);

  // 4. data equivalence
  for (const [k, n] of Object.entries(manifest.rowCounts as Record<string, number>)) {
    const t = k; const got = Number((await q(DST, `SELECT count(*) AS n FROM ${t}`))[0].n); check(`row count ${t}`, got === n, `${got} vs ${n}`);
  }
  const fp = async (db: string) => (await q(db, `SELECT md5(string_agg(id::text||body||status, '|' ORDER BY seq)) AS h FROM messages`))[0].h;
  check('messages content fingerprint identical', (await fp(SRC)) === (await fp(DST)));
  const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  const mf = readdirSync(dstMedia, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  const sf = readdirSync(srcMedia, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  check('media files restored byte-for-byte', mf.length === sf.length && mf.length >= 1 && sha(mf[0]) === sha(sf[0]));

  // 5. a real server on the restored database serves the data and the same credentials key decrypts stored secrets
  const s2 = startServer(DST, 4291, dstMedia); procs.push(s2); await waitReady(4291);
  check('server on restored DB reports ready (schema current)', true);
  const c2 = await login(4291);
  const list = await call(4291, c2, 'GET', '/api/conversations');
  check('restored server lists the conversation', list.some((x: any) => x.id === conv.id));
  const thread = await call(4291, c2, 'GET', `/api/conversations/${conv.id}`);
  check('restored thread has the customer message, our reply and the note', thread.messages.some((m: any) => m.body.includes('pontoon')) && thread.messages.some((m: any) => m.body.includes('Saturday')) && thread.notes.some((n: any) => n.body.includes('morning')));
  const link = await call(4291, c2, 'GET', `/api/media/${mediaId}/link`); const img = await fetch(`http://127.0.0.1:4291${link.url}`);
  check('restored media is served via a signed link', img.ok && Buffer.from(await img.arrayBuffer()).equals(png));
  const dec = spawnSync('npx', ['tsx', 'scripts/verify-secret.ts', wh.id, wh.secret], { env: env(DST), encoding: 'utf8' });
  check('encrypted webhook secret decrypts on the restored DB with the same key', dec.stdout.includes('DECRYPT_OK'), dec.stdout.trim());
  const wrong = spawnSync('npx', ['tsx', 'scripts/verify-secret.ts', wh.id, wh.secret], { env: { ...env(DST), CREDENTIAL_KEYS: JSON.stringify({ '1': 'cd'.repeat(32) }) }, encoding: 'utf8' });
  check('...and does NOT decrypt with a different key (key must be stored separately)', wrong.status !== 0);
  killAll([s2]);
} catch (e) {
  check('drill completed without exception', false, (e as Error).message);
} finally {
  killAll(procs); await sleep(800);
  for (const d of [SRC, DST]) await admin(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  if (!process.env.KEEP_DRILL) rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
