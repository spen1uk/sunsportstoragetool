import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { authorizeTool } from '../policy.ts';
import { isPrivateAddress, resolvePublic } from '../net.ts';
import { fetchSource } from '../fetch.ts';
import { setPaused } from '../pause.ts';

test('private/loopback/link-local/metadata addresses are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('hostname resolving to a private address is refused (DNS rebinding / SSRF)', async () => {
  await assert.rejects(resolvePublic('evil.example', async () => ['93.184.216.34', '127.0.0.1']), /private/);
  assert.equal(await resolvePublic('ok.example', async () => ['93.184.216.34']), '93.184.216.34');
});

test('fetch refuses hosts not on the allow-list, even on redirect', async () => {
  await assert.rejects(fetchSource('https://not-allowed.example/', { isHostAllowed: () => false }), /not allowed/);
});

test('policy: unknown tool, wrong task kind, bad args, http, creds, unlisted host', () => {
  const db = makeDb();
  assert.equal(authorizeTool(db, { taskKind: 'research' }, 'run_shell', { cmd: 'ls' }).ok, false);
  assert.equal(authorizeTool(db, { taskKind: 'manual' }, 'fetch_source', { url: 'https://a.example/' }).ok, false);
  assert.equal(authorizeTool(db, { taskKind: 'research' }, 'fetch_source', { url: 'https://a.example/', extra: 1 }).ok, false);
  assert.equal(authorizeTool(db, { taskKind: 'research' }, 'fetch_source', { url: 'http://a.example/' }).ok, false);
  assert.equal(authorizeTool(db, { taskKind: 'research' }, 'fetch_source', { url: 'https://u:p@a.example/' }).ok, false);
  const r = authorizeTool(db, { taskKind: 'research' }, 'fetch_source', { url: 'https://a.example/x' });
  assert.equal(r.ok, false); assert.equal((r as any).needsApproval.actionType, 'allow_domain');
  db.prepare("INSERT INTO allowed_domains(host,added_at) VALUES('a.example','x')").run();
  assert.equal(authorizeTool(db, { taskKind: 'research' }, 'fetch_source', { url: 'https://a.example/x' }).ok, true);
  setPaused(db, true);
  assert.equal(authorizeTool(db, { taskKind: 'research' }, 'fetch_source', { url: 'https://a.example/x' }).ok, false);
});
