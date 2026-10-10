import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import http from 'node:http';
import { createServer } from '../http.ts';

const rawStatus = (port: number, host: string) => new Promise<number>((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: '/api/me', headers: { host } }, (r) => { r.resume(); res(r.statusCode ?? 0); }).on('error', rej);
});

const call = (port: number, path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: o.method ?? 'GET', headers: { 'content-type': 'application/json', ...o.headers }, body: o.body ? JSON.stringify(o.body) : undefined });

test('API: unexpected Host → 421; unauthenticated → 401; CSRF required; cross-origin blocked; login lockout', async () => {
  const db = makeDb();
  const allowed: string[] = [];
  const srv = createServer(db, { webDir: '/nonexistent', allowedHosts: allowed });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port; allowed.push(`127.0.0.1:${port}`);
  try {
    assert.equal(await rawStatus(port, 'evil.example'), 421);
    assert.equal(await rawStatus(port, `127.0.0.1:${port}`), 200);
    assert.equal((await call(port, '/api/state')).status, 401);
    assert.equal((await call(port, '/api/tasks', { method: 'POST', body: { title: 'x' } })).status, 401);

    const login = await call(port, '/api/login', { method: 'POST', body: { passphrase: 'test-pass' } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    const { csrf } = await login.json() as any;

    const h = { cookie };
    assert.equal((await call(port, '/api/state', { headers: h })).status, 200);
    assert.equal((await call(port, '/api/tasks', { method: 'POST', headers: h, body: { title: 'x' } })).status, 403); // no CSRF header
    assert.equal((await call(port, '/api/tasks', { method: 'POST', headers: { ...h, 'x-jarvis-csrf': csrf, origin: 'http://evil.example' }, body: { title: 'x' } })).status, 403);
    assert.equal((await call(port, '/api/tasks', { method: 'POST', headers: { ...h, 'x-jarvis-csrf': csrf }, body: { title: 'x' } })).status, 200);
    assert.equal((await call(port, '/api/tasks', { method: 'POST', headers: { ...h, 'x-jarvis-csrf': csrf }, body: { title: '' } })).status, 400);
    // Security headers present
    const r = await call(port, '/api/me'); assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    // Step-up cannot be skipped: high-risk approval refused over HTTP without it.
    const created = await call(port, '/api/budget/cap-increase', { method: 'POST', headers: { ...h, 'x-jarvis-csrf': csrf }, body: { usd: 200 } });
    const { approvalId } = await created.json() as any;
    const ap = db.prepare('SELECT digest FROM approvals WHERE id=?').get(approvalId) as any;
    const dec = await call(port, `/api/approvals/${approvalId}/decide`, { method: 'POST', headers: { ...h, 'x-jarvis-csrf': csrf }, body: { decision: 'approve', digest: ap.digest } });
    assert.equal(dec.status, 409);
    assert.match((await dec.json() as any).error, /step-up/);
    // Lockout after repeated failures
    let last = 0; for (let i = 0; i < 6; i++) last = (await call(port, '/api/login', { method: 'POST', body: { passphrase: 'nope' } })).status;
    assert.equal(last, 429);
  } finally { srv.closeAllConnections(); srv.close(); }
});
void (null as unknown);
