import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { createServer } from '../http.ts';
import { resetLoginThrottle } from '../auth.ts';
import { createDevice, listDevices, revokeDevice, authenticate, allow, resetRateLimits, SCOPES } from '../devices.ts';
import { buildGreeting, buildGlance, toSpeech } from '../greeting.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, CompletionRequest, Provider } from '../llm/types.ts';
import { chicagoInstant as ci } from '../tz.ts';
import { setMeta } from '../db.ts';
import { createTask, completeTask } from '../tasks.ts';
import { requestApproval } from '../approvals.ts';
import { setPaused } from '../pause.ts';
import { setEnabled, rememberSources, recordSync, storeCalendar } from '../calendar.ts';
import { createArtifact } from '../artifacts.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; resetRateLimits(); });
const NOW = ci(2026, 10, 14, 18, 30);   // Wed 6:30 pm Chicago
const H = 3_600_000;
const seedCalendar = (db: any, events: any[]) => { rememberSources(db, 'calendar', ['Home']); setEnabled(db, 'calendar', ['Home']); storeCalendar(db, events.map((e, i) => ({ calendar: 'Home', uid: 'u' + i, location: '', allDay: false, ...e })), {}, NOW); };

test('registry: credential shown once and stored only as a hash; scopes are a closed list; expiry, revocation and the device cap', () => {
  const db = makeDb(), { token, id } = createDevice(db, { name: 'Range Rover', kind: 'car' }, NOW);
  assert.match(token, /^jvd_/); assert.equal(JSON.stringify(db.prepare('SELECT * FROM devices').all()).includes(token), false);
  const ok = authenticate(db, `Bearer ${token}`, 'greeting', NOW); assert.ok(ok.ok && ok.device.kind === 'car' && ok.device.profile === 'glance');
  assert.deepEqual(listDevices(db, NOW)[0].scopes, ['chat', 'greeting', 'glance']); assert.deepEqual([...SCOPES], ['chat', 'greeting', 'glance'], 'no approve/settings/devices scope exists');
  assert.throws(() => createDevice(db, { name: 'x', kind: 'car', scopes: ['approve'] }), 'unknown scopes cannot be granted'); assert.throws(() => createDevice(db, { name: 'x', kind: 'car', admin: true } as any), 'unknown fields refused');
  const sms = createDevice(db, { name: 'Texts', kind: 'sms' }, NOW); const denied = authenticate(db, `Bearer ${sms.token}`, 'greeting', NOW); assert.ok(!denied.ok && denied.status === 403);
  assert.ok(!authenticate(db, `Bearer ${token}`, 'chat', NOW + 366 * 86_400_000).ok, 'expires after a year');
  assert.equal(revokeDevice(db, id, NOW), true); assert.ok(!authenticate(db, `Bearer ${token}`, 'chat', NOW).ok);
  for (let i = 0; i < 7; i++) createDevice(db, { name: `d${i}`, kind: 'phone' }, NOW); assert.throws(() => createDevice(db, { name: 'one too many', kind: 'phone' }, NOW), /up to 8/);
  for (const bad of [undefined, '', 'Bearer', 'Bearer jvd_short', 'Basic abc', 'Bearer jvb_' + 'a'.repeat(30)]) assert.equal(authenticate(db, bad, null, NOW).ok, false);
  assert.ok(allow('d', 3, NOW) && allow('d', 3, NOW) && allow('d', 3, NOW) && !allow('d', 3, NOW) && allow('d', 3, NOW + 61_000), 'per-device rate limit');
});

test('greeting: built only from real records, time-aware, honest when quiet, and shorter for driving', () => {
  const db = makeDb();
  assert.equal(buildGreeting(db, { now: NOW }).speak, 'Good evening, sir. All systems are operational. Nothing needs you right now.');
  assert.match(buildGreeting(db, { now: ci(2026, 10, 14, 8, 0) }).speak, /^Good morning, sir\./); assert.match(buildGreeting(db, { now: ci(2026, 10, 14, 1, 0) }).speak, /^Working late, sir\?/);
  requestApproval(db, { actionType: 'allow_domain', payload: { host: 'example.com' }, requestedBy: 'jarvis' });
  seedCalendar(db, [{ title: 'Dentist appointment with Dr. Alvarez and a very long title that keeps going', start: NOW + 45 * 60_000, end: NOW + 105 * 60_000 }, { title: 'Far away', start: NOW + 30 * H, end: NOW + 31 * H }]);
  createArtifact(db, { title: 'Research: docks', content: 'x', sources: [], createdBy: 't' }); db.prepare("UPDATE artifacts SET status='in_review'").run();
  const g = buildGreeting(db, { now: NOW, profile: 'glance' }); assert.match(g.speak, /1 urgent item needs your attention/); assert.match(g.speak, /next up: Dentist appointment with Dr\. Alvarez an… in 45 minutes/); assert.doesNotMatch(g.speak, /ready for your review/, 'driving mode stays short'); assert.ok(g.cards.length <= 2);
  const f = buildGreeting(db, { now: NOW, profile: 'full' }); assert.match(f.speak, /ready for your review/); assert.doesNotMatch(f.speak, /Far away/, 'only appointments that are close');
  assert.match(buildGreeting(db, { now: NOW, lastSeen: NOW - 5 * 60_000 }).speak, /^Welcome back, sir\./);
  setPaused(db, true); assert.match(buildGreeting(db, { now: NOW }).speak, /paused/); assert.equal(buildGlance(db, NOW).line1, 'Paused'); assert.equal(buildGlance(db, NOW).core, 'paused'); setPaused(db, false);
  assert.doesNotMatch(buildGreeting(db, { now: NOW }).speak, /weather|rain|sunny/i, 'no data, no mention');
  const gl = buildGlance(db, NOW); assert.ok(gl.line1.length > 0); assert.ok(gl.line2.length <= 41);
});

test('toSpeech makes replies fit for a speaker', () => {
  const t = toSpeech('## Status\n- **3 tasks** active [1]\n- see https://example.com/x 😀\n\n```js\nsecret()\n```\nDone.'); assert.equal(t, 'Status. 3 tasks active. see. Done.');
  assert.ok(toSpeech('A sentence. '.repeat(100), 100).length <= 101); assert.ok(toSpeech('x'.repeat(2000), 50).endsWith('…'));
});

async function boot(webDir = '/nonexistent') {
  resetLoginThrottle(); resetRateLimits(); const db = makeDb(), allowed: string[] = []; const srv = createServer(db, { webDir, allowedHosts: allowed });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); const port = (srv.address() as any).port; allowed.push(`127.0.0.1:${port}`); const base = `http://127.0.0.1:${port}`;
  const api = (p: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => fetch(base + p, { method: o.method ?? 'GET', headers: { 'content-type': 'application/json', ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const login = await api('/api/login', { method: 'POST', body: { passphrase: 'test-pass' } }); const me = { cookie: login.headers.get('set-cookie')!.split(';')[0], 'x-jarvis-csrf': ((await login.json()) as any).csrf };
  return { db, api, me, close: () => { srv.closeAllConnections(); srv.close(); } };
}
const model = (text: string) => { const calls: CompletionRequest[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { calls.push(req); return { text, model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } as Completion; } } as Provider }; return calls; };

test('over HTTP: creating a device needs a fresh step-up; a device sees only its own doors and can never reach the dashboard API; the browser session is not a device', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Car', kind: 'car' } })).status, 403);
    await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    const { token } = await (await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Car', kind: 'car' } })).json() as any; const dv = { authorization: `Bearer ${token}` };
    assert.equal((await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Again', kind: 'car' } })).status, 403, 'the step-up was spent');
    const me = await (await t.api('/api/device/me', { headers: dv })).json() as any; assert.deepEqual([me.name, me.kind, me.profile], ['Car', 'car', 'glance']);
    assert.equal((await t.api('/api/device/glance', { headers: dv })).status, 200); assert.equal((await t.api('/api/device/greeting', { headers: dv })).status, 200);
    for (const p of ['/api/state', '/api/tasks', '/api/approvals', '/api/memory', '/api/notes', '/api/devices', '/api/passkeys', '/api/bridge/config', '/api/settings']) assert.ok([401, 404].includes((await t.api(p, { headers: dv })).status), p);
    for (const [p, method] of [['/api/approvals/x/decide', 'POST'], ['/api/pause', 'POST'], ['/api/devices', 'POST'], ['/api/tasks', 'POST']] as const) assert.ok([401, 404].includes((await t.api(p, { method, headers: dv, body: {} })).status), p);
    assert.equal((await t.api('/api/device/me', { headers: t.me })).status, 401, 'a browser session is not a device'); assert.equal((await t.api('/api/device/me')).status, 401);
    assert.equal((await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'hello' } })).status, 200);
    const list = await (await t.api('/api/devices', { headers: t.me })).json() as any; assert.ok(list.items[0].lastSeen); assert.equal(JSON.stringify(list).includes(token), false);
    await t.api(`/api/devices/${list.items[0].id}`, { method: 'DELETE', headers: t.me }); assert.equal((await t.api('/api/device/me', { headers: dv })).status, 401);
  } finally { t.close(); }
});

test('device chat: shares the one conversation, records the channel, speaks briefly while driving, and can never confirm anything', async () => {
  const t = await boot();
  try {
    await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    const { token } = await (await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Car', kind: 'car' } })).json() as any; const dv = { authorization: `Bearer ${token}` };
    const calls = model('Of course. **Added** it to your list — see https://x.example.\nACTIONS: [{"type":"add_task","title":"Call the marina","minutes":15}]');
    const r = await (await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'remind me to call the marina', mode: 'driving' } })).json() as any;
    assert.match(calls[0].system, /SPOKEN ALOUD while Luke is driving/); assert.equal(r.queuedForConfirmation, 1); assert.doesNotMatch(r.speak, /https|\*\*|ACTIONS/); assert.match(r.speak, /left a suggestion on your dashboard for you to confirm/);
    assert.equal((t.db.prepare("SELECT COUNT(*) c FROM tasks WHERE kind='manual'").get() as any).c, 0, 'nothing happened: a device cannot confirm');
    const rows = t.db.prepare('SELECT channel FROM messages ORDER BY id').all() as any[]; assert.deepEqual(rows.map((x) => x.channel), ['car', 'car']);
    await t.api('/api/chat', { method: 'POST', headers: t.me, body: { text: 'status' } }); assert.equal((t.db.prepare('SELECT COUNT(*) c FROM messages').get() as any).c, 4, 'one shared history across devices');
    model('Here is a long answer.'); await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'tell me more', mode: 'parked' } });
    for (let i = 0; i < 40; i++) await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'status' } }); assert.equal((await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'status' } })).status, 429);
    const priv = model('Ok.\nACTIONS: [{"type":"add_task","title":"secret"}]'); resetRateLimits(); gw.setConfig(t.db, { allowInPrivate: true });
    const pr = await (await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'hush', private: true } })).json() as any; assert.equal(pr.queuedForConfirmation, 0); void priv;
  } finally { t.close(); }
});

test('device chat: model spend is tagged to the device, and a device at its monthly limit is refused', async () => {
  const t = await boot();
  try {
    await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    const { token, id } = await (await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Voice', kind: 'voice', monthlyLimitUsd: 1 } })).json() as any; const dv = { authorization: `Bearer ${token}` };
    model('Fine.'); assert.equal((await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'how are things' } })).status, 200);
    const row = t.db.prepare("SELECT channel, device_id FROM llm_usage WHERE ok=1 ORDER BY id DESC LIMIT 1").get() as any; assert.deepEqual({ ...row }, { channel: 'voice', device_id: id });
    t.db.prepare('INSERT INTO llm_usage(at,task,provider,model,cost_micro_usd,ok,channel,device_id) VALUES(?,?,?,?,?,1,?,?)').run(Date.now(), 'chat', 'anthropic', 'm', 1_000_000, 'voice', id);
    const r = await t.api('/api/device/chat', { method: 'POST', headers: dv, body: { text: 'again' } }); assert.equal(r.status, 402);
    assert.equal((await t.api('/api/device/greeting', { headers: dv })).status, 200, 'free endpoints still work at the limit');
  } finally { t.close(); }
});

test('phone/car page: served statically, may use the microphone, and the rest of the app still may not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-web-')); fs.writeFileSync(path.join(dir, 'index.html'), '<title>Jarvis</title>'); fs.writeFileSync(path.join(dir, 'go.html'), '<title>Jarvis Go</title>');
  const t = await boot(dir);
  try {
    const go = await t.api('/go'); assert.equal(go.status, 200); assert.match(go.headers.get('permissions-policy') ?? '', /microphone=\(self\)/); assert.match(await go.text(), /Jarvis Go|go\.ts|assets\/go/);
    assert.match((await t.api('/')).headers.get('permissions-policy') ?? '', /microphone=\(\)/);
    assert.match(go.headers.get('content-security-policy') ?? '', /script-src 'self'/);
  } finally { t.close(); }
});
