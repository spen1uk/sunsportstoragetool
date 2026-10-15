import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import https from 'node:https';
import { makeDb } from './helpers.ts';
import { createServer } from '../http.ts';
import { resetLoginThrottle } from '../auth.ts';
import { generateRecoveryKey } from '../backup-crypto.ts';
import { runBackup, backupStatus } from '../backup-run.ts';
import { checks, healthIssues, offsiteStatus, recordOffsite } from '../health.ts';
import { buildBriefing } from '../today.ts';
import { validateHeartbeatUrl, startHeartbeat } from '../heartbeat.ts';
import { pullBackups, makeWatcher, saveConfig, loadConfig } from '../bridge-client.ts';
import { listBackups, backupPath } from '../offsite.ts';
import { createToken } from '../bridge.ts';
import { setMeta } from '../db.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jh-'));
const H = 3_600_000;
const withKey = (db: any) => { process.env.JARVIS_BACKUP_PUBKEY = 'present'; return () => { delete process.env.JARVIS_BACKUP_PUBKEY; }; };

test('health: nothing is expected before backups are set up; once a key exists an overdue backup is URGENT; off-server copy only matters once the Mac helper exists', async () => {
  const db = makeDb(), now = Date.now(); delete process.env.JARVIS_BACKUP_PUBKEY;
  assert.deepEqual(healthIssues(db, now).filter((i) => i.key === 'backup' || i.key === 'offsite'), [], 'no key, no nagging');
  const undo = withKey(db);
  try {
    assert.ok(healthIssues(db, now).some((i) => i.key === 'backup' && i.level === 'urgent'), 'key but never backed up');
    setMeta(db, 'last_backup', JSON.stringify({ at: now - 2 * H, file: 'jarvis-20261014-031500.jvbk', bytes: 1, kept: 1, auditChainOk: true }));
    assert.equal(healthIssues(db, now).some((i) => i.key === 'backup'), false); assert.ok(healthIssues(db, now + 40 * H).some((i) => i.key === 'backup'));
    assert.equal(checks(db, now).some((c) => c.key === 'offsite'), false, 'no helper, no off-server expectation');
    createToken(db);                                             // a Mac helper now exists
    assert.equal(healthIssues(db, now).some((i) => i.key === 'offsite'), false, 'a young backup gets a few hours of grace');
    assert.ok(healthIssues(db, now + 14 * H).some((i) => i.key === 'offsite' && i.level === 'warn'));
    recordOffsite(db, 'jarvis-20261014-031500.jvbk', now); assert.equal(healthIssues(db, now + 14 * H).some((i) => i.key === 'offsite'), false, 'the newest backup is on the Mac');
    setMeta(db, 'last_backup', JSON.stringify({ at: now, file: 'jarvis-20261015-031500.jvbk', bytes: 1, kept: 2, auditChainOk: false }));
    assert.ok(healthIssues(db, now).some((i) => i.key === 'backup-chain'));
  } finally { undo(); }
});

test('problems reach the morning briefing as urgent items', () => {
  const db = makeDb(); const undo = withKey(db);
  try { const b = buildBriefing(db); assert.ok(b.sections[0].items.some((i) => /encrypted backup is overdue/.test(i.text))); } finally { undo(); }
});

test('heartbeat: https only, no embedded login, empty request, failure path when a problem exists, nothing sent when unconfigured', async () => {
  for (const bad of ['http://hc.example/abc', 'https://user:pw@hc.example/abc', 'nonsense']) assert.throws(() => validateHeartbeatUrl(bad));
  const db = makeDb(); delete process.env.JARVIS_HEARTBEAT_URL; assert.equal(startHeartbeat(db), null);
  process.env.JARVIS_HEARTBEAT_URL = 'https://hc-ping.example/uuid-1234'; const sent: { fail: boolean }[] = [];
  const stop = startHeartbeat(db, 60_000, async (_u, o) => { sent.push({ fail: !!o?.fail }); return true; })!; await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(sent, [{ fail: false }]); assert.equal(JSON.parse((db.prepare("SELECT value FROM meta WHERE key='heartbeat_last'").get() as any).value).reported, 'ok');
  const undo = withKey(db); const stop2 = startHeartbeat(db, 60_000, async (_u, o) => { sent.push({ fail: !!o?.fail }); return true; })!; await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.at(-1)!.fail, true, 'an urgent problem is reported as a failure, not "all fine"'); undo(); stop(); stop2(); delete process.env.JARVIS_HEARTBEAT_URL;
  void https;
});

async function setup() {
  resetLoginThrottle(); const db = makeDb(), allowed: string[] = [], dir = tmp(), key = generateRecoveryKey(); process.env.JARVIS_BACKUP_DIR = dir;
  const srv = createServer(db, { webDir: '/nonexistent', allowedHosts: allowed }); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port; allowed.push(`127.0.0.1:${port}`);
  const token = createToken(db), cfg = { url: `http://127.0.0.1:${port}`, token, backupDir: tmp() };
  return { db, dir, key, cfg, close: () => { delete process.env.JARVIS_BACKUP_DIR; srv.closeAllConnections(); srv.close(); } };
}

test('off-server copies: the Mac helper pulls only ENCRYPTED backups, verifies them, tells the server, and the server stops worrying', async () => {
  const t = await setup();
  try {
    await runBackup(t.db, t.dir, { publicKey: t.key.publicKey, now: new Date(Date.UTC(2026, 9, 14, 3, 15, 0)) }); await runBackup(t.db, t.dir, { publicKey: t.key.publicKey, now: new Date(Date.UTC(2026, 9, 15, 3, 15, 0)) });
    fs.writeFileSync(path.join(t.dir, 'notes.txt'), 'private'); fs.writeFileSync(path.join(t.dir, 'jarvis.db'), 'plaintext!');
    const list = await listBackups(t.dir); assert.deepEqual(list.map((x) => x.name), ['jarvis-20261014-031500.jvbk', 'jarvis-20261015-031500.jvbk']);
    const r = await pullBackups(t.cfg, { log: () => {} }); assert.equal(r.pulled, 2); assert.deepEqual(fs.readdirSync(t.cfg.backupDir).sort(), ['jarvis-20261014-031500.jvbk', 'jarvis-20261015-031500.jvbk']);
    assert.ok(fs.readFileSync(path.join(t.cfg.backupDir, 'jarvis-20261015-031500.jvbk')).equals(fs.readFileSync(path.join(t.dir, 'jarvis-20261015-031500.jvbk'))));
    assert.equal(fs.statSync(path.join(t.cfg.backupDir, 'jarvis-20261015-031500.jvbk')).mode & 0o077, 0);
    assert.equal(offsiteStatus(t.db)!.name, 'jarvis-20261015-031500.jvbk'); assert.equal((await pullBackups(t.cfg, { log: () => {} })).pulled, 0, 'nothing is downloaded twice');
    const bearer = { authorization: `Bearer ${t.cfg.token}` };
    for (const evil of ['../data/jarvis.db', '..%2Fjarvis.db', 'jarvis.db', 'notes.txt', 'jarvis-20261014-031500.jvbk/../../x', 'jarvis-1-2.jvbk']) assert.equal((await fetch(`${t.cfg.url}/api/bridge/backups/${evil}`, { headers: bearer })).status, 404, evil);
    assert.equal((await fetch(`${t.cfg.url}/api/bridge/backups`)).status, 401); assert.equal((await fetch(`${t.cfg.url}/api/bridge/backups/jarvis-20261014-031500.jvbk`)).status, 401, 'no credential, no file');
    assert.equal(backupPath(t.dir, '../x'), null);
    const ack = await fetch(`${t.cfg.url}/api/bridge/backups/ack`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'notes.txt' }) }); assert.equal(ack.status, 400);
  } finally { t.close(); }
});

test('a corrupted or substituted download is refused and never saved; local copies are capped at 30', async () => {
  const t = await setup();
  try {
    await runBackup(t.db, t.dir, { publicKey: t.key.publicKey, now: new Date(Date.UTC(2026, 9, 14, 3, 15, 0)) });
    const real = fetch; const tamper = (async (u: any, i: any) => { const r = await real(u, i); if (String(u).includes('/backups/jarvis-')) { const b = Buffer.from(await r.arrayBuffer()); b[100] ^= 1; return new Response(b, { status: 200 }); } return r; }) as typeof fetch;
    await assert.rejects(() => pullBackups(t.cfg, { fetch: tamper, log: () => {} }), /arrived damaged/); assert.deepEqual(fs.readdirSync(t.cfg.backupDir), [], 'nothing partial left behind');
    const notJv = (async (u: any, i: any) => { const r = await real(u, i); return String(u).includes('/backups/jarvis-') ? new Response(Buffer.from('x'.repeat(10)), { status: 200 }) : r; }) as typeof fetch;
    await assert.rejects(() => pullBackups(t.cfg, { fetch: notJv, log: () => {} }), /damaged/);
    for (let d = 1; d <= 33; d++) fs.writeFileSync(path.join(t.cfg.backupDir, `jarvis-202601${String(d).padStart(2, '0')}-000000.jvbk`), 'JVBK1\n');
    await pullBackups(t.cfg, { log: () => {} }); assert.equal(fs.readdirSync(t.cfg.backupDir).filter((n) => n.endsWith('.jvbk')).length, 30);
    assert.equal(backupStatus(t.db).hasKey, false);
  } finally { t.close(); }
});

test('Mac-side alerts: nothing for one miss, one notice after two, repeats at most every 3 hours, and says when it recovers', () => {
  const sent: string[] = []; const w = makeWatcher((t, b) => sent.push(`${t}|${b}`)); const t0 = Date.now();
  w.failed('x', t0); assert.equal(sent.length, 0); w.failed('server unreachable', t0 + 15 * 60_000); assert.equal(sent.length, 1); w.failed('again', t0 + 30 * 60_000); assert.equal(sent.length, 1);
  w.failed('again', t0 + 4 * H); assert.equal(sent.length, 2); w.ok(); assert.match(sent[2], /back/); w.ok(); assert.equal(sent.length, 3, 'no repeat recovery notice');
  const f = path.join(tmp(), 'cfg.json'); saveConfig({ url: 'https://jarvis.example.ts.net', token: 'jvb_' + 'a'.repeat(30), backupDir: '/tmp/x' }, f); assert.equal(loadConfig(f).backupDir, '/tmp/x');
});
