import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const sh = (args: string[], env: Record<string, string> = {}) => execFileSync('bash', args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });

test('launcher scripts are valid bash and executable', () => {
  for (const f of ['scripts/launch.sh', 'scripts/autostart.sh', 'Jarvis.command']) {
    sh(['-n', f]); assert.ok(fs.statSync(path.join(root, f)).mode & 0o100, `${f} must be executable`);
  }
});

test('auto-start agent: per-user LaunchAgent, loopback app only, no admin rights; refuses before first-time setup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-agent-')), data = path.join(tmp, 'data');
  const env = { JARVIS_AGENT_DIR: path.join(tmp, 'LaunchAgents'), JARVIS_AGENT_DRYRUN: '1', JARVIS_DATA_DIR: data };
  // not set up yet → must refuse with a helpful message
  assert.throws(() => execFileSync('bash', ['scripts/autostart.sh', 'install'], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' }), /Run\s+bash scripts\/launch\.sh/);
  execFileSync('node', ['server/setup.ts'], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  const dist = path.join(root, 'web/dist/index.html'), made = !fs.existsSync(dist); if (made) { fs.mkdirSync(path.dirname(dist), { recursive: true }); fs.writeFileSync(dist, '<!doctype html>'); }
  try {
    sh(['scripts/autostart.sh', 'install'], env);
    const f = path.join(tmp, 'LaunchAgents', 'uk.jarvis.local.plist'), p = fs.readFileSync(f, 'utf8');
    assert.match(p, /<key>RunAtLoad<\/key><true\/>/); assert.match(p, /<key>KeepAlive<\/key><true\/>/); assert.match(p, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
    assert.match(p, new RegExp(`<string>${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/server/index\\.ts</string>`));
    assert.match(p, /<string>\/[^<]*node[^<]*<\/string>/);                    // absolute node path (launchd has no PATH)
    assert.match(p, /<key>JARVIS_PORT<\/key><string>8788<\/string>/);
    assert.doesNotMatch(p, /sudo|LaunchDaemons|0\.0\.0\.0/);                  // user-level only; never binds beyond loopback
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.match(sh(['scripts/autostart.sh', 'uninstall'], env), /Auto-start removed/); assert.ok(!fs.existsSync(f));
  } finally { if (made) fs.rmSync(path.join(root, 'web/dist'), { recursive: true, force: true }); fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('default port is 8788 (8787 is commonly taken by other local tools)', async () => {
  const { config } = await import('../config.ts'); assert.equal(config.port, Number(process.env.JARVIS_PORT ?? 8788));
});
