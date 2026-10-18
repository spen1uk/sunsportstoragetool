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

test('device limit edit: lowering is free, raising needs step-up (which is spent), bad values and revoked devices are refused', async () => {
  const t = await boot();
  try {
    const step = () => t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    await step(); const { id } = await (await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Car', kind: 'car', monthlyLimitUsd: 5 } })).json() as any;
    const put = (usd: unknown, did = id) => t.api(`/api/devices/${did}/limit`, { method: 'PUT', headers: t.me, body: { monthlyLimitUsd: usd } });
    const lim = () => (t.db.prepare('SELECT monthly_limit_micro_usd m FROM devices WHERE id=?').get(id) as any).m;
    assert.equal((await put(2)).status, 200); assert.equal(lim(), 2_000_000, 'lowering needs no step-up');
    assert.equal((await put(8)).status, 403); assert.equal(lim(), 2_000_000, 'raising refused without step-up');
    await step(); assert.equal((await put(8)).status, 200); assert.equal(lim(), 8_000_000);
    assert.equal((await put(9)).status, 403, 'the step-up was spent by the raise');
    await step(); for (const bad of [0, 0.1, 51, 'x', null]) assert.equal((await put(bad)).status, 400, `rejects ${bad}`); assert.equal(lim(), 8_000_000);
    assert.equal((await put(3, 'nope')).status, 400);
    assert.equal((t.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='device.limit_changed'").get() as any).c, 2);
    await t.api(`/api/devices/${id}`, { method: 'DELETE', headers: t.me }); assert.equal((await put(1)).status, 400, 'revoked device cannot be edited');
    assert.equal((await t.api(`/api/devices/${id}/limit`, { method: 'PUT', body: { monthlyLimitUsd: 1 } })).status, 401, 'signed-in only');
  } finally { t.close(); }
});

test('standing permissions: only narrow kinds, only with step-up from the dashboard, capped, scoped to interfaces, revocable, never when paused', async () => {
  const t = await boot();
  try {
    const step = () => t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    const grant = (b: unknown) => t.api('/api/standing', { method: 'POST', headers: t.me, body: b });
    const say = (text = 'add it') => t.api('/api/chat', { method: 'POST', headers: t.me, body: { text } }).then((r) => r.json()) as Promise<any>;
    const tasks = () => (t.db.prepare("SELECT COUNT(*) c FROM tasks WHERE kind='manual'").get() as any).c;
    const ACT = (n: number) => `Ok.\nACTIONS: [{"type":"add_task","title":"Task ${n}","minutes":10}]`;

    model(ACT(1)); let r = await say(); assert.equal(r.proposals.length, 1, 'no permission: still waits for a click'); assert.equal(tasks(), 0);

    assert.equal((await grant({ type: 'add_task' })).status, 403, 'needs step-up');
    await step(); for (const bad of ['complete_task', 'remember', 'queue_research', 'add_link', 'send_message']) { assert.equal((await grant({ type: bad })).status, 400, bad); await step(); }
    assert.equal((await grant({ type: 'add_task', perDay: 99 })).status, 400); await step(); assert.equal((await grant({ type: 'add_task', days: 400 })).status, 400); await step();
    assert.equal((await grant({ type: 'add_task', perDay: 2, days: 5, channels: ['dashboard', 'car'] })).status, 200);
    assert.equal((await grant({ type: 'add_task' })).status, 403, 'the step-up was spent');

    model(ACT(2)); r = await say(); assert.equal(r.proposals.length, 0); assert.match(r.text, /Done under your standing permission: Add task: "Task 2"/); assert.equal(tasks(), 1);
    assert.equal((t.db.prepare("SELECT actor FROM audit WHERE action='proposal.confirmed' ORDER BY id DESC LIMIT 1").get() as any).actor, 'jarvis (standing permission)');
    assert.equal((t.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='standing.used'").get() as any).c, 1);
    model(ACT(3)); await say(); assert.equal(tasks(), 2);
    model(ACT(4)); r = await say(); assert.equal(r.proposals.length, 1, 'daily cap reached: waits'); assert.equal(tasks(), 2);

    // other kinds are not covered by an add_task permission
    model('Ok.\nACTIONS: [{"type":"remember","content":"likes tea"}]'); r = await say(); assert.equal(r.proposals.length, 1);

    // a device on an interface that is not listed (sms) never auto-runs; a listed one (car) is allowed, but a device still cannot grant anything
    const mk = async (kind: string) => { await step(); return ((await (await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: kind, kind } })).json()) as any).token; };
    const smsTok = await mk('sms'), carTok = await mk('car');
    const dchat = (tok: string) => t.api('/api/device/chat', { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: { text: 'again', mode: 'driving' } }).then((x) => x.json()) as Promise<any>;
    t.db.prepare('DELETE FROM standing_uses').run(); model(ACT(5)); assert.equal((await dchat(smsTok)).queuedForConfirmation, 1); assert.equal(tasks(), 2);
    model(ACT(6)); const c = await dchat(carTok); assert.equal(c.queuedForConfirmation, 0); assert.equal(tasks(), 3); assert.match(c.speak, /standing permission/i);
    assert.equal((await t.api('/api/standing', { method: 'POST', headers: { authorization: `Bearer ${carTok}` }, body: { type: 'add_task' } })).status, 401, 'a device cannot grant');

    // paused: never auto-runs
    t.db.prepare('DELETE FROM standing_uses').run(); setPaused(t.db, true); model(ACT(7)); r = await say('hello there'); assert.equal(tasks(), 3); setPaused(t.db, false);

    // revoke: immediate
    const sid = ((await (await t.api('/api/standing', { headers: t.me })).json()) as any).items[0].id;
    assert.equal((await t.api(`/api/standing/${sid}/revoke`, { method: 'POST', headers: t.me, body: {} })).status, 200);
    model(ACT(8)); r = await say(); assert.equal(r.proposals.length, 1); assert.equal(tasks(), 3);
    const l = ((await (await t.api('/api/standing', { headers: t.me })).json()) as any).items[0]; assert.equal(l.status, 'revoked');
  } finally { t.close(); }
});

test('weather settings over HTTP: need sign-in and a fresh step-up; bad input is refused without spending it', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('/api/weather', { method: 'PUT', body: { name: 'X', lat: 1, lon: 1 } })).status, 401);
    assert.equal((await t.api('/api/weather', { method: 'PUT', headers: t.me, body: { name: 'X', lat: 1, lon: 1 } })).status, 403);
    await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    assert.equal((await t.api('/api/weather', { method: 'PUT', headers: t.me, body: { name: 'X', lat: 99, lon: 1 } })).status, 400);
    assert.equal(((await (await t.api('/api/weather', { headers: t.me })).json()) as any).enabled, false);
  } finally { t.close(); }
});

test('web search settings over HTTP: turning it on needs step-up; turning it off does not', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('/api/websearch', { method: 'PUT', body: { enabled: true, perDay: 5 } })).status, 401);
    assert.equal((await t.api('/api/websearch', { method: 'PUT', headers: t.me, body: { enabled: true, perDay: 5 } })).status, 403);
    assert.equal((await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } })).status, 200);
    assert.equal((await t.api('/api/websearch', { method: 'PUT', headers: t.me, body: { enabled: true, perDay: 99 } })).status, 400);
    assert.equal((await t.api('/api/websearch', { method: 'PUT', headers: t.me, body: { enabled: true, perDay: 5 } })).status, 200);
    assert.equal(((await (await t.api('/api/websearch', { headers: t.me })).json()) as any).enabled, true);
    assert.equal((await t.api('/api/websearch', { method: 'PUT', headers: t.me, body: { enabled: true, perDay: 9 } })).status, 200, 'changing the cap while on needs no step-up');
    assert.equal((await t.api('/api/websearch', { method: 'PUT', headers: t.me, body: { enabled: false, perDay: 9 } })).status, 200);
    assert.equal((await t.api('/api/websearch', { method: 'PUT', headers: t.me, body: { enabled: true, perDay: 9 } })).status, 403, 'turning it back on needs step-up again');
  } finally { t.close(); }
});

test('emergency stop: pauses, revokes every way in, keeps your data and sign-in, and is undone only on purpose', async () => {
  const t = await boot();
  try {
    const step = () => t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } });
    await step(); const { token } = await (await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Car', kind: 'car' } })).json() as any; const dv = { authorization: `Bearer ${token}` };
    await step(); assert.equal((await t.api('/api/standing', { method: 'POST', headers: t.me, body: { type: 'add_task' } })).status, 200);
    await step(); assert.equal((await t.api('/api/websearch', { method: 'PUT', headers: t.me, body: { enabled: true, perDay: 5 } })).status, 200);
    await t.api('/api/bridge/token', { method: 'POST', headers: t.me, body: {} }).catch(() => null);
    createTask(t.db, { title: 'My task' });
    assert.equal((await t.api('/api/device/glance', { headers: dv })).status, 200);
    await step();   // a pending step-up confirmation must be cancelled too
    assert.equal((await t.api('/api/emergency-stop', { method: 'POST', headers: t.me, body: {} })).status, 400, 'needs an explicit confirm');
    const r = await (await t.api('/api/emergency-stop', { method: 'POST', headers: t.me, body: { confirm: true } })).json() as any;
    assert.equal(r.devicesRevoked, 1); assert.equal(r.standingRevoked, 1); assert.equal(r.webSearchOff, true);
    assert.equal((await t.api('/api/device/glance', { headers: dv })).status, 401, 'the device key is dead');
    assert.equal(((await (await t.api('/api/websearch', { headers: t.me })).json()) as any).enabled, false);
    assert.equal(((await (await t.api('/api/standing', { headers: t.me })).json()) as any).items[0].status, 'revoked');
    assert.equal((await t.api('/api/me', { headers: t.me })).status, 200, 'your own sign-in survives');
    assert.equal((t.db.prepare("SELECT COUNT(*) c FROM tasks WHERE title='My task'").get() as any).c, 1, 'no data is deleted');
    assert.equal((t.db.prepare("SELECT value FROM meta WHERE key='paused'").get() as any).value, '1');
    assert.equal((await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'New', kind: 'phone' } })).status, 403, 'the cancelled step-up cannot be reused');
    assert.ok((t.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='system.emergency_stop'").get() as any).c === 1);
  } finally { t.close(); }
});

test('permissions ledger: sign-in only, and it reflects real state', async () => {
  const t = await boot();
  try {
    assert.equal((await t.api('/api/permissions')).status, 401);
    await t.api('/api/stepup', { method: 'POST', headers: t.me, body: { passphrase: 'test-pass' } }); await t.api('/api/devices', { method: 'POST', headers: t.me, body: { name: 'Phone', kind: 'phone' } });
    const l = await (await t.api('/api/permissions', { headers: t.me })).json() as any;
    assert.equal(l.devices.length, 1); assert.deepEqual(l.devices[0].scopes, ['chat', 'greeting', 'glance']); assert.ok(l.protectedActions.some((a: any) => a.type === 'trade_or_transfer' && !a.runnable));
    assert.ok(l.standingEligible.includes('add_task')); assert.deepEqual(l.budgetDefaults, { quickMicro: 100_000, deepMicro: 2_000_000, exploreMonthlyMicro: 10_000_000 }); assert.ok(l.neverGrantable.length >= 4);
    assert.doesNotMatch(JSON.stringify(l), /jvd_|token_hash/, 'no credentials in the ledger');
    assert.equal((await t.api('/api/mission-defaults', { method: 'PUT', headers: t.me, body: { quickMicro: 100_000, deepMicro: 5_000_000, exploreMonthlyMicro: 10_000_000 } })).status, 403, 'raising a budget needs step-up');
    assert.equal((await t.api('/api/mission-defaults', { method: 'PUT', headers: t.me, body: { quickMicro: 50_000, deepMicro: 1_000_000, exploreMonthlyMicro: 5_000_000 } })).status, 200, 'lowering does not');
  } finally { t.close(); }
});
