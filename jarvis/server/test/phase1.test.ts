import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, Provider } from '../llm/types.ts';
import * as mb from '../missionbudget.ts';
import { config } from '../config.ts';
import * as sec from '../llm/secrets.ts';

const orig = gw.registry.providers, origDir = config.dataDir;
afterEach(() => { gw.registry.providers = orig; (config as any).dataDir = origDir; sec._testHooks.setExec(null); sec._testHooks.setPlatform(null); delete process.env.ANTHROPIC_API_KEY; });
const fake = () => { gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { return { text: 'ok', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 } } as Completion; } } as Provider }; };

test('mission budgets: a mission is stopped at its own cap; other work and unbudgeted refs are not affected', async () => {
  const db = makeDb(); fake();
  assert.throws(() => mb.create(db, 'bad ref!', 'x', 100_000)); assert.throws(() => mb.create(db, 'ok', 'x', 10)); assert.throws(() => mb.create(db, 'ok', 'x', 60_000_000));
  mb.create(db, 'mission:a', 'Research A', 2_000);   // $0.002
  const one = await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }], ref: 'mission:a' }); assert.equal(one.ok, true);
  const spent = mb.spentOn(db, 'mission:a'); assert.ok(spent > 0 && spent < 2_000);
  let stopped = false; for (let i = 0; i < 40 && !stopped; i++) { const r = await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }], ref: 'mission:a' }); if (!r.ok) { stopped = true; assert.equal(r.kind, 'mission_budget'); assert.match(r.error, /own budget/); } }
  assert.ok(stopped, 'the mission must stop');
  assert.equal((await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }], ref: 'other' })).ok, true, 'a ref with no budget is not limited here');
  assert.equal((await gw.complete(db, { task: 'chat', system: 's', messages: [{ role: 'user', content: 'hi' }] })).ok, true);
  mb.close(db, 'mission:a'); assert.equal(mb.wouldExceed(db, 'mission:a', 1e9).exceeded, false, 'a closed budget no longer limits');
});

test('mission budgets: defaults are $0.10 / $2 / $10 a month and validated', () => {
  const db = makeDb(); assert.deepEqual(mb.getDefaults(db), { quickMicro: 100_000, deepMicro: 2_000_000, exploreMonthlyMicro: 10_000_000 });
  mb.setDefaults(db, { quickMicro: 50_000, deepMicro: 3_000_000, exploreMonthlyMicro: 5_000_000 }); assert.equal(mb.getDefaults(db).deepMicro, 3_000_000);
  assert.throws(() => mb.setDefaults(db, { quickMicro: 0, deepMicro: 1, exploreMonthlyMicro: 1 })); assert.throws(() => mb.setDefaults(db, { quickMicro: 1_000, deepMicro: 2e9, exploreMonthlyMicro: 1_000 }));
});

test('keychain: off by default; when on, keys go through stdin (never the command line), are verified, and a failure changes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-kc-')); (config as any).dataDir = dir;
  const store = new Map<string, string>(); const calls: { args: string[]; input?: string }[] = [];
  sec._testHooks.setPlatform('darwin');
  sec._testHooks.setExec((args, input) => { calls.push({ args, input }); if (args[0] === 'find-generic-password') { const v = store.get(args[args.indexOf('-s') + 1]); if (v === undefined) throw new Error('not found'); return v + '\n'; } if (args[0] === '-i') { const m = /-s (\S+) -U -w "([^"]+)"/.exec(input ?? ''); if (m) store.set(m[1], m[2]); return ''; } if (args[0] === 'delete-generic-password') { store.delete(args[args.indexOf('-s') + 1]); return ''; } return ''; });
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ anthropic: 'sk-ant-file-secret-123456' }), { mode: 0o600 });
  assert.equal(sec.keychainEnabled(), false); assert.equal(sec.getSecret('anthropic'), 'sk-ant-file-secret-123456'); assert.equal(calls.length, 0, 'no Keychain calls before opting in');
  const r = sec.migrateToKeychain(false); assert.deepEqual(r, { moved: ['anthropic'], removedFile: false });
  assert.ok(fs.existsSync(path.join(dir, 'secrets.json')), 'the file is kept unless asked'); assert.equal(sec.keychainEnabled(), true);
  assert.equal(calls.some((c) => c.args.join(' ').includes('sk-ant-file-secret')), false, 'the key never appears in command-line arguments'); assert.ok(calls.some((c) => c.input?.includes('sk-ant-file-secret-123456')), 'it goes to stdin');
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ anthropic: 'DIFFERENT-file-value-999999' }))
  sec._testHooks.setExec((args, input) => { if (args[0] === 'find-generic-password') return 'sk-ant-file-secret-123456\n'; return ''; });
  assert.equal(sec.getSecret('anthropic'), 'sk-ant-file-secret-123456', 'Keychain wins over the file once on');
  process.env.ANTHROPIC_API_KEY = 'sk-from-env-0000000'; assert.equal(sec.getSecret('anthropic'), 'sk-from-env-0000000', 'environment still wins');
  delete process.env.ANTHROPIC_API_KEY;
  assert.throws(() => sec.keychainSet('anthropic', 'has"quote-1234567'), /characters/); assert.throws(() => sec.keychainSet('anthropic', 'short'));
  sec._testHooks.setExec(() => ''); fs.rmSync(path.join(dir, 'keychain.enabled'));
  assert.throws(() => sec.migrateToKeychain(true), /did not return|not return/, 'if the round trip fails nothing is removed'); assert.ok(fs.existsSync(path.join(dir, 'secrets.json')), 'file untouched after a failed migration'); assert.equal(sec.keychainEnabled(), false, 'and the Keychain is not switched on');
  sec._testHooks.setPlatform('linux'); assert.throws(() => sec.migrateToKeychain(false), /only available on a Mac/);
});
