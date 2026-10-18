import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { makeDb } from './helpers.ts';
import { ACTION_TYPES } from '../proposals.ts';
import { ACTIONS } from '../approvals.ts';
import { ELIGIBLE } from '../standing.ts';
import { manifestSchema, tierOf, PRINCIPALS, CAPABILITIES } from '../skills/manifest.ts';
import { ALL_BUILTIN, define } from '../skills/catalog.ts';
import * as reg from '../skills/registry.ts';
import * as wf from '../skills/workflow.ts';
import { setPaused } from '../pause.ts';
import { remember } from '../memory.ts';
import { createTask } from '../tasks.ts';
import * as src from '../sources.ts';

afterEach(() => reg._testEntries.clear());
const M = (m: any) => m.manifest;
const vstatus = (db: any, v: string) => (db.prepare("SELECT status FROM skill_versions WHERE skill_id='test.echo' AND version=?").get(v) as any).status as string;
const echo = (version: string, out: string, extra: any = {}) => define({ id: 'test.echo', title: 'Test echo', purpose: 'Returns a fixed word for tests.', owner: 'jarvis', permissions: ['docs.process'], dataSensitivity: 'public', sideEffects: 'none', runPath: 'direct', autoShare: true, version, outputDescription: 'a word', ...extra }, z.object({}).strict(), () => ({ out }));

test('parity: every chat suggestion and protected action in the old tables has exactly one catalog entry, with matching risk and flags', () => {
  const by = (path: string) => ALL_BUILTIN.map(M).filter((m) => m.runPath === path);
  assert.deepEqual(by('proposal').map((m) => m.legacyKey).sort(), [...ACTION_TYPES].sort());
  assert.deepEqual(by('approval').map((m) => m.legacyKey).sort(), Object.keys(ACTIONS).sort());
  assert.deepEqual(by('proposal').filter((m) => m.standingEligible).map((m) => m.legacyKey).sort(), [...ELIGIBLE].sort());
  assert.ok(by('proposal').every((m) => m.modelProposable) && by('approval').every((m) => !m.modelProposable), 'only the strictly-validated proposal kinds can come from the model');
  for (const m of by('approval')) assert.equal(ACTIONS[m.legacyKey!].risk === 'high', tierOf(m) >= 3, `${m.id}: risk and tier agree`);
  for (const k of ['send_message', 'trade_or_transfer']) { const m = by('approval').find((x) => x.legacyKey === k)!; assert.equal(ACTIONS[k].handler, null); assert.ok(tierOf(m) >= 3); }
  assert.equal(new Set(ALL_BUILTIN.map((e) => e.manifest.id)).size, ALL_BUILTIN.length, 'ids are unique');
  for (const m of by('proposal')) assert.ok(tierOf(m) <= 1, `${m.id}: chat suggestions stay at tier 0-1`);
});

test('manifests: the vocabulary is closed; ids, versions and permissions are validated', () => {
  const ok = { id: 'a.b', title: 'Title ok', purpose: 'A purpose long enough.', owner: 'jarvis', version: '1.0.0', permissions: ['docs.process'], dataSensitivity: 'public', sideEffects: 'none', trust: 'reviewed', runPath: 'direct', outputDescription: 'x' };
  assert.ok(manifestSchema.safeParse(ok).success);
  for (const bad of [{ id: 'nodots' }, { id: 'A.b' }, { version: '1.0' }, { permissions: ['root.everything'] }, { sideEffects: 'launch_missiles' }, { trust: 'self-approved' }, { runPath: 'shell' }, { owner: 'Not Valid' }]) assert.equal(manifestSchema.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  assert.equal(PRINCIPALS.prometheus.capabilities.includes('memory.read' as any), false); assert.ok(CAPABILITIES['money.move'] === 4);
});

test('sharing: free public read-only skills reach every agent that can hold them; private ones never reach Prometheus; everything else needs your grant', () => {
  const db = makeDb(); reg.sync(db);
  for (const id of ['research.catalog_lookup', 'docs.extract_text', 'weather.current']) for (const p of ['jarvis', 'prometheus']) { const a = reg.access(db, p, id); assert.equal(a.allowed, true, `${p} ${id}`); assert.equal(a.via, 'auto'); }
  assert.equal(reg.access(db, 'jarvis', 'memory.search').allowed, false); assert.match(reg.access(db, 'jarvis', 'memory.search').reasons[0], /not granted/);
  assert.equal(reg.access(db, 'prometheus', 'memory.search').allowed, false); assert.match(reg.access(db, 'prometheus', 'memory.search').reasons.join(';'), /cannot hold: memory\.read|private data/);
  assert.throws(() => reg.grant(db, 'prometheus', 'memory.search', 'luke'), /cannot ever hold|can never hold|may not use/); assert.throws(() => reg.grant(db, 'prometheus', 'tasks.list_open', 'luke'));
  assert.throws(() => reg.grant(db, 'jarvis', 'memory.search', 'prometheus'), /Only you/); assert.throws(() => reg.grant(db, 'jarvis', 'memory.search', 'jarvis'), /Only you/);
  assert.throws(() => reg.grant(db, 'jarvis', 'messages.send', 'luke'), /never be granted/); assert.throws(() => reg.grant(db, 'jarvis', 'finance.trade_or_transfer', 'luke')); assert.throws(() => reg.grant(db, 'nobody', 'memory.search', 'luke'), /unknown agent/);
  reg.grant(db, 'jarvis', 'memory.search', 'luke'); assert.equal(reg.access(db, 'jarvis', 'memory.search').via, 'grant'); assert.equal(reg.revoke(db, 'jarvis', 'memory.search'), true); assert.equal(reg.access(db, 'jarvis', 'memory.search').allowed, false);
});

test('invoke: runs only registry skills the agent may use, validates input, honours pause and the off switch, logs every attempt without storing inputs', async () => {
  const db = makeDb(); remember(db, 'Luke likes tea at four', { source: 'test' }); createTask(db, { title: 'Buy flax seed oil' });
  const r1 = await reg.invoke(db, 'prometheus', 'docs.extract_text', { html: '<html><title>Hi</title><body><p>Hello world</p></body></html>' }); assert.equal(r1.ok, true); assert.match(JSON.stringify((r1 as any).result), /Hello world/);
  const bad = await reg.invoke(db, 'prometheus', 'docs.extract_text', { html: 1 }); assert.equal(bad.ok, false); assert.match((bad as any).refused, /invalid input/);
  assert.equal((await reg.invoke(db, 'prometheus', 'docs.extract_text', { html: 'x', extra: 1 })).ok, false, 'unknown fields are refused');
  assert.match((await reg.invoke(db, 'prometheus', 'memory.search', { query: 'tea' }) as any).refused, /cannot hold|private|not granted/); reg.grant(db, 'jarvis', 'memory.search', 'luke'); const m = await reg.invoke(db, 'jarvis', 'memory.search', { query: 'tea' }); assert.equal(m.ok, true); assert.match(JSON.stringify((m as any).result), /tea/);
  assert.match((await reg.invoke(db, 'jarvis', 'tasks.add', {}) as any).refused, /own path \(proposal\)/, 'suggestion-path skills are not run by the registry');
  assert.match((await reg.invoke(db, 'jarvis', 'messages.send', {}) as any).refused, /own path \(approval\)/); assert.match((await reg.invoke(db, 'someone-else', 'docs.extract_text', { html: 'x' }) as any).refused, /unknown agent/); assert.match((await reg.invoke(db, 'jarvis', 'nope.nope', {}) as any).refused, /no such skill/);
  reg.setStatus(db, 'docs.extract_text', 'disabled'); assert.match((await reg.invoke(db, 'prometheus', 'docs.extract_text', { html: 'x' }) as any).refused, /switched off/); reg.setStatus(db, 'docs.extract_text', 'active');
  setPaused(db, true); assert.match((await reg.invoke(db, 'prometheus', 'docs.extract_text', { html: 'x' }) as any).refused, /paused/); setPaused(db, false);
  const rows = db.prepare('SELECT * FROM skill_runs ORDER BY id').all() as any[]; assert.ok(rows.length >= 8); assert.ok(rows.every((x) => /^[0-9a-f]{64}$/.test(x.input_sha256))); assert.doesNotMatch(JSON.stringify(rows), /Hello world|flax|tea at four/, 'run history never stores what was asked or returned');
  const st = reg.stats(db, 'docs.extract_text'); assert.ok(st.runs >= 4 && st.ok >= 1 && st.refused >= 2);
});

test('versions: a new version waits staged; activating it is Luke\'s call; rolling back restores the old behaviour and is recorded; manifest edits are flagged', async () => {
  const db = makeDb(); reg._testEntries.add(echo('1.0.0', 'one')); reg.sync(db);
  assert.equal((await reg.invoke(db, 'jarvis', 'test.echo', {}) as any).result.out, 'one');
  reg._testEntries.add(echo('1.1.0', 'two')); reg.sync(db);   // add() resets the sync cache so the new version is noticed
  assert.equal((await reg.invoke(db, 'jarvis', 'test.echo', {}) as any).result.out, 'one', 'the new version is staged, not live');
  assert.equal(vstatus(db, '1.1.0'), 'staged');
  assert.deepEqual(reg.activate(db, 'test.echo', '1.1.0'), { rolledBack: false }); assert.equal((await reg.invoke(db, 'jarvis', 'test.echo', {}) as any).result.out, 'two');
  assert.deepEqual(reg.activate(db, 'test.echo', '1.0.0'), { rolledBack: true }); assert.equal((await reg.invoke(db, 'jarvis', 'test.echo', {}) as any).result.out, 'one');
  assert.equal(vstatus(db, '1.1.0'), 'rolled_back');
  assert.throws(() => reg.activate(db, 'test.echo', '9.9.9'), /not in the codebase/); assert.ok(reg.detail(db, 'test.echo')!.history.some((h: any) => h.action === 'skill.rolled_back'));
  reg._testEntries.clear(); const db3 = makeDb(); reg._testEntries.add(echo('1.0.0', 'one')); reg.sync(db3); reg._testEntries.clear(); reg._testEntries.add(echo('1.0.0', 'one', { purpose: 'A quietly changed purpose.' })); reg.sync(db3);
  assert.equal((db3.prepare("SELECT COUNT(*) c FROM audit WHERE action='skill.manifest_drift'").get() as any).c, 1);
});

test('workflows: combined permissions are the union, the tier is the highest, web output cannot feed side effects, and nothing runs outside the agent\'s own rights', async () => {
  const db = makeDb();
  reg._testEntries.add(
    define({ id: 'test.web', title: 'Test web', purpose: 'Pretends to read the web.', owner: 'prometheus', permissions: ['web.search'], dataSensitivity: 'public', sideEffects: 'external_read', untrustedOutput: true, runPath: 'direct', outputDescription: 'text' }, z.object({}).strict(), () => ({ text: 'from the web' })),
    define({ id: 'test.write', title: 'Test write', purpose: 'Writes something internally.', owner: 'jarvis', permissions: ['tasks.write'], dataSensitivity: 'private', sideEffects: 'internal_write', runPath: 'direct', outputDescription: 'ok' }, z.object({ text: z.string() }).strict(), () => ({ wrote: true })),
    define({ id: 'test.upper', title: 'Test upper', purpose: 'Upper-cases text. Pure.', owner: 'jarvis', permissions: ['docs.process'], dataSensitivity: 'public', sideEffects: 'none', runPath: 'direct', autoShare: true, outputDescription: 'text' }, z.object({ text: z.string() }).strict(), (i: any) => ({ up: String(i.text).toUpperCase() })));
  reg.sync(db);
  const ex = { skill: 'docs.extract_text', input: { html: '<p>hello</p>' } }, up = { skill: 'test.upper', input: { text: { $step: 0, path: 'text' } } };
  const good = wf.validate(db, [ex, up], 'prometheus'); assert.equal(good.ok, true, good.violations.join()); assert.deepEqual(good.effective, { permissions: ['docs.process'], tier: 0, sideEffects: 'none', dataSensitivity: 'public', untrusted: false, runnable: true });
  const mixed = wf.validate(db, [{ skill: 'test.web' }, { skill: 'test.upper', input: { text: { $step: 0, path: 'text' } } }]); assert.equal(mixed.ok, true, 'web output may flow into a pure, side-effect-free step'); assert.deepEqual(mixed.effective!.permissions.sort(), ['docs.process', 'web.search']); assert.equal(mixed.effective!.sideEffects, 'external_read'); assert.equal(mixed.effective!.untrusted, true);
  const bad = wf.validate(db, [{ skill: 'test.web' }, { skill: 'test.write', input: { text: { $step: 0, path: 'text' } } }]); assert.equal(bad.ok, false); assert.match(bad.violations.join(), /cannot feed a skill that has side effects/); assert.equal(bad.effective!.dataSensitivity, 'private');
  assert.match(wf.validate(db, [{ skill: 'test.upper', input: { text: { $step: 1, path: '' } } }, up]).violations.join(), /EARLIER step/); assert.match(wf.validate(db, [{ skill: 'nope.nope' }]).violations.join(), /no such skill/);
  assert.match(wf.validate(db, [{ skill: 'memory.search', input: { query: 'x' } }], 'prometheus').violations.join(), /may not use it/, 'a workflow cannot give an agent a skill it could not use alone');
  assert.equal(wf.validate(db, [{ skill: 'tasks.add' }, { skill: 'messages.send' }]).effective!.runnable, false); assert.equal(wf.validate(db, [{ skill: 'messages.send' }]).effective!.tier, 3);
  assert.equal(wf.validate(db, 'nope').ok, false); assert.equal(wf.validate(db, Array(9).fill(ex)).ok, false);
  assert.throws(() => wf.save(db, 'bad one', [{ skill: 'test.web' }, { skill: 'test.write', input: { text: { $step: 0, path: 'text' } } }], 'luke'), /side effects/);
  const wid = wf.save(db, 'Shout', [ex, up], 'prometheus'); assert.equal(wf.list(db)[0].status, 'staged'); assert.deepEqual((await wf.run(db, 'prometheus', wid)), { ok: false, error: 'this workflow is not active', outputs: [] });
  assert.throws(() => wf.setStatus(db, wid, 'active', 'prometheus'), /Only you/); wf.setStatus(db, wid, 'active', 'luke');
  const out = await wf.run(db, 'prometheus', wid); assert.equal(out.ok, true); assert.equal((out as any).outputs[1].up, 'HELLO');
  reg.setStatus(db, 'test.upper', 'disabled'); const off = await wf.run(db, 'prometheus', wid); assert.equal(off.ok, false); assert.match((off as any).error, /switched off|may not use/, 'a workflow is re-checked against the live skills every run');
  assert.equal(wf.remove(db, wid), true);
});

test('catalog skills with the web in them are flagged, and Prometheus owns the research ones', () => {
  const db = makeDb(); const s = Object.fromEntries(reg.summary(db).map((x) => [x.id, x]));
  assert.equal(s['research.deep'].untrustedOutput, true); assert.equal(s['research.deep'].owner, 'prometheus'); assert.equal(s['research.web_answer'].untrustedOutput, true); assert.equal(s['memory.search'].dataSensitivity, 'private');
  assert.equal(s['tasks.add'].standingEligible, true); assert.equal(s['tasks.complete'].standingEligible, false); assert.equal(s['finance.trade_or_transfer'].tier, 4);
  src.upsert(db, { host: 'noaa.gov', status: 'trusted', topics: ['weather'] });
});
