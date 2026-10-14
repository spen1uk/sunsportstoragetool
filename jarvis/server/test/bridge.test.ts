import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { makeDb } from './helpers.ts';
import { createServer } from '../http.ts';
import { resetLoginThrottle } from '../auth.ts';
import { resetBridgeThrottle } from '../bridge.ts';
import { setRunner, MacError } from '../mac.ts';
import { setEnabled, sources, syncState, upcoming } from '../calendar.ts';
import { listNotes } from '../notes.ts';
import { cycle, saveConfig, loadConfig, validateUrl } from '../bridge-client.ts';

async function boot() {
  resetLoginThrottle(); resetBridgeThrottle();
  const db = makeDb(); const allowed: string[] = []; const srv = createServer(db, { webDir: '/nonexistent', allowedHosts: allowed });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port; allowed.push(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  const api = (p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => fetch(base + p, { method: o.method ?? 'GET', headers: { 'content-type': 'application/json', ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const login = await api('/api/login', { method: 'POST', body: { passphrase: 'test-pass' } }); const cookie = login.headers.get('set-cookie')!.split(';')[0]; const { csrf } = await login.json() as any;
  const me = { cookie, 'x-jarvis-csrf': csrf };
  return { db, base, api, me, close: () => new Promise((r) => srv.close(r)) };
}
const fakeMac = (cals: string[], events: any[], folders: string[], notes: any[]) => setRunner(async (script, args) => {
  if (script.includes('C.calendars().map')) return JSON.stringify(cals);
  if (script.includes("Application('Calendar'), out")) { const want = JSON.parse(args[2]); const ev = events.filter((e) => want.includes(e.calendar)); return JSON.stringify({ events: ev, stats: Object.fromEntries(want.map((w: string) => [w, { total: ev.length, inWindow: ev.length, repeating: 0 }])) }); }
  if (script.includes('N.folders().map')) return JSON.stringify(folders);
  const want = JSON.parse(args[0]); return JSON.stringify(notes.filter((n) => want.includes(n.folder)));
});
const H = 3_600_000;

test('bridge credential: creating one needs step-up, only its hash is stored, it opens only the bridge doors, and revoking works', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('/api/bridge/token', { method: 'POST', headers: t.me, body: {} })).status, 403);
    assert.equal((await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } })).status, 200);
    const { token } = await (await t.api('/api/bridge/token', { method: 'POST', headers: t.me, body: {} })).json() as any; assert.match(token, /^jvb_/);
    assert.equal(JSON.stringify(t.db.prepare('SELECT * FROM bridge_tokens').all()).includes(token), false, 'plaintext never stored');
    const bearer = { authorization: `Bearer ${token}` };
    assert.equal((await t.api('/api/bridge/config')).status, 401); assert.equal((await t.api('/api/bridge/config', { headers: { authorization: 'Bearer jvb_wrongwrongwrongwrongwrong' } })).status, 401);
    assert.equal((await t.api('/api/bridge/config', { headers: t.me })).status, 401, 'a browser session is not the helper');
    assert.equal((await t.api('/api/bridge/config', { headers: bearer })).status, 200);
    assert.equal((await t.api('/api/state', { headers: bearer })).status, 401, 'the helper credential opens nothing else');
    assert.equal((await t.api('/api/tasks', { method: 'POST', headers: bearer, body: { title: 'x' } })).status, 401);
    assert.ok((await (await t.api('/api/bridge', { headers: t.me })).json() as any).lastSeen);
    await t.api('/api/bridge/token', { method: 'DELETE', headers: t.me }); assert.equal((await t.api('/api/bridge/config', { headers: bearer })).status, 401);
    const second = (await (await t.api('/api/bridge/token', { method: 'POST', headers: t.me, body: {} })).json() as any).token; const third = (await (await t.api('/api/bridge/token', { method: 'POST', headers: t.me, body: {} })).json() as any).token;
    assert.equal((await t.api('/api/bridge/config', { headers: { authorization: `Bearer ${second}` } })).status, 401, 'a new credential replaces the old'); assert.equal((await t.api('/api/bridge/config', { headers: { authorization: `Bearer ${third}` } })).status, 200);
  } finally { await t.close(); }
});

test('bridge failures lock the door briefly', async () => {
  const t = await boot();
  try { for (let i = 0; i < 10; i++) assert.equal((await t.api('/api/bridge/config', { headers: { authorization: 'Bearer jvb_wrongwrongwrongwrongwrong' } })).status, 401); assert.equal((await t.api('/api/bridge/config', { headers: { authorization: 'Bearer jvb_wrongwrongwrongwrongwrong' } })).status, 429); } finally { await t.close(); }
});

test('end to end: helper reports names, Luke ticks what to share, the helper pushes ONLY that; the server shows it as connected and the UI data works as on a Mac', async () => {
  const t = await boot(); const now = Date.now();
  try {
    await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    const { token } = await (await t.api('/api/bridge/token', { method: 'POST', headers: t.me, body: {} })).json() as any;
    const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jb-')), 'cfg.json'); saveConfig({ url: t.base, token }, cfgFile); assert.equal(fs.statSync(cfgFile).mode & 0o077, 0, 'config is private to the user'); const cfg = loadConfig(cfgFile);
    fakeMac(['Home', 'Work'], [{ calendar: 'Home', uid: 'a', title: 'Dentist', start: now + 2 * H, end: now + 3 * H, allDay: false, location: '' }, { calendar: 'Work', uid: 'b', title: 'Secret meeting', start: now + 4 * H, end: now + 5 * H, allDay: false, location: '' }],
      ['Ideas', 'Private'], [{ id: 'n1', folder: 'Ideas', title: 'Boat ideas', body: 'dock light', modified: now }, { id: 'n2', folder: 'Private', title: 'Passwords', body: 'hunter2', modified: now }]);
    let r = await cycle(cfg, { now, log: () => {} }); assert.equal(r.calendar, null, 'nothing is read until Luke chooses'); assert.deepEqual(sources(t.db, 'calendar').map((s) => s.name), ['Home', 'Work']); assert.equal(upcoming(t.db, now, now + 24 * H).length, 0);
    setEnabled(t.db, 'calendar', ['Home']); setEnabled(t.db, 'notes', ['Ideas']);
    r = await cycle(cfg, { now, log: () => {} }); assert.deepEqual([r.calendar, r.notes, r.errors.length], [1, 1, 0]);
    assert.deepEqual(upcoming(t.db, now, now + 24 * H).map((e) => e.title), ['Dentist']); assert.deepEqual(listNotes(t.db).map((n) => n.title), ['Boat ideas']);
    assert.equal(syncState(t.db, 'calendar', now + 1000).status, 'connected'); assert.equal((t.db.prepare("SELECT status FROM connections WHERE id='apple-notes'").get() as any).status, 'connected');
    // a rogue/buggy helper pushing a calendar Luke did not tick is discarded by the server
    const bearer = { authorization: `Bearer ${token}` };
    const push = await (await t.api('/api/bridge/calendar', { method: 'POST', headers: bearer, body: { events: [{ calendar: 'Work', uid: 'z', title: 'Sneaky', start: now, end: now + H, allDay: false, location: '' }, { calendar: 'Home', uid: 'h', title: 'Fine', start: now, end: now + H, allDay: false, location: '' }] } })).json() as any;
    assert.deepEqual(push, { stored: 1, discarded: 1 }); assert.deepEqual(upcoming(t.db, now - H, now + H).map((e) => e.title), ['Fine']);
    // the Mac failing is reported honestly and the copy goes stale rather than being wiped
    setRunner(async () => { throw new MacError('permission', 'macOS has not allowed this yet'); });
    r = await cycle(cfg, { now: now + 50 * 60_000, log: () => {} }); assert.ok(r.errors.length >= 1);
    assert.equal(upcoming(t.db, now - H, now + H).length, 1); assert.match((t.db.prepare('SELECT last_error FROM mac_sync WHERE kind=?').get('calendar') as any).last_error, /Mac helper: macOS has not allowed/);
    assert.equal(syncState(t.db, 'calendar', now + 51 * 60_000).status, 'stale');
  } finally { setRunner(null); await t.close(); }
});

test('size limits: bridge pushes may be large, every other route keeps the small limit; malformed pushes are rejected', async () => {
  const t = await boot();
  try {
    await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    const { token } = await (await t.api('/api/bridge/token', { method: 'POST', headers: t.me, body: {} })).json() as any; const bearer = { authorization: `Bearer ${token}` };
    setEnabled(t.db, 'notes', []); t.db.prepare("INSERT OR IGNORE INTO mac_sources(kind,name,enabled) VALUES('notes','Ideas',1)").run();
    const big = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, folder: 'Ideas', title: `T${i}`, body: 'x'.repeat(8000), modified: 1 }));
    assert.equal((await t.api('/api/bridge/notes', { method: 'POST', headers: bearer, body: { notes: big } })).status, 200);
    assert.equal((await t.api('/api/tasks', { method: 'POST', headers: t.me, body: { title: 'x'.repeat(300_000) } })).status, 413);
    assert.equal((await t.api('/api/bridge/calendar', { method: 'POST', headers: bearer, body: { events: 'nope' } })).status, 400);
    assert.equal((await t.api('/api/bridge/names', { method: 'POST', headers: bearer, body: { kind: 'calendar', names: ['A'], extra: 1 } })).status, 400);
  } finally { await t.close(); }
});

test('helper address and config: https only (localhost excepted), no embedded login, no redirects followed', async () => {
  assert.equal(validateUrl('https://jarvis.tail1234.ts.net/'), 'https://jarvis.tail1234.ts.net'); assert.equal(validateUrl('http://localhost:8788'), 'http://localhost:8788');
  for (const bad of ['http://jarvis.example.com', 'https://user:pw@jarvis.example.com', 'ftp://x.example', 'nonsense']) assert.throws(() => validateUrl(bad));
  assert.throws(() => saveConfig({ url: 'https://a.example', token: 'not-a-token' }, path.join(os.tmpdir(), 'x.json')));
  const redirecting = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
  setRunner(async () => '[]'); await assert.rejects(() => cycle({ url: 'https://a.example', token: 'jvb_aaaaaaaaaaaaaaaaaaaaaaaa' }, { fetch: (async (u: any, i: any) => { assert.equal(i.redirect, 'error'); return redirecting(); }) as any, log: () => {} })); setRunner(null);
});
