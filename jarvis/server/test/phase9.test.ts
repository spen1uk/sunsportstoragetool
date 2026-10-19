import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, Provider } from '../llm/types.ts';
import * as reg from '../skills/registry.ts';
import * as wf from '../skills/workflow.ts';
import { define } from '../skills/catalog.ts';
import * as G from '../improve/gaps.ts';
import * as C from '../improve/candidates.ts';
import * as S from '../improve/sandbox.ts';
import * as R from '../improve/rollout.ts';
import * as X from '../exclusions.ts';
import { buildBriefing } from '../today.ts';
import { createTask } from '../tasks.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; reg._testEntries.clear(); });
const model = (text: string | ((u: string) => string)) => { const seen: string[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { seen.push(req.system + '\n' + req.messages[0].content); return { text: typeof text === 'function' ? text(req.messages[0].content) : text, model: req.model, stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0 } } as Completion; } } as Provider }; return seen; };
const GOOD = { kind: 'workflow', name: 'Morning check', rationale: 'Looks at open tasks and tidies text in one go.', steps: [{ skill: 'tasks.list_open', input: {} }, { skill: 'docs.extract_text', input: { html: '<p>Hello</p>' } }] };
const ready = (db: any) => { reg.grant(db, 'jarvis', 'tasks.list_open', 'luke'); reg.grant(db, 'jarvis', 'memory.search', 'luke'); };
const failRuns = (db: any, skill: string, n: number, why = 'invalid input: bad', at = Date.now()) => { for (let i = 0; i < n; i++) db.prepare('INSERT INTO skill_runs(skill_id,version,principal,at,ok,ms,input_sha256,refused) VALUES(?,?,?,?,0,0,?,?)').run(skill, '1.0.0', 'jarvis', at, 'x', why); };

test('gaps: found by counting real failures (3+), deduplicated, dismissed stays dismissed; manual requests are checked for secrets and exclusions; the list is capped', () => {
  const db = makeDb(); reg.sync(db); failRuns(db, 'tasks.list_open', 2); assert.equal(G.scan(db), 0, 'two failures is not a pattern');
  failRuns(db, 'tasks.list_open', 2); failRuns(db, 'docs.extract_text', 3, 'Jarvis is paused'); assert.equal(G.scan(db), 1); assert.equal(G.scan(db), 0, 'same gap is not found twice');
  const g = G.list(db)[0]; assert.equal(g.kind, 'failing_skill'); assert.equal(g.count, 4); assert.ok(G.setStatus(db, g.id, 'dismissed')); failRuns(db, 'tasks.list_open', 5); G.scan(db); assert.equal(G.get(db, g.id)!.status, 'dismissed');
  failRuns(db, 'tasks.list_open', 3, 'invalid input: other reason'); assert.equal(G.scan(db), 1, 'a different reason is a different gap');
  failRuns(db, 'tasks.list_open', 3, 'x', Date.now() - 30 * 86_400_000); // old failures are ignored
  const w = wf.save(db, 'Flaky', [{ skill: 'docs.extract_text', input: { html: 'x' } }], 'luke'); for (let i = 0; i < 3; i++) db.prepare('INSERT INTO workflow_runs(workflow_id,principal,at,ok,error) VALUES(?,?,?,0,?)').run(w, 'jarvis', Date.now(), 'step 1 failed'); assert.equal(G.scan(db), 1); assert.equal(G.list(db).find((x) => x.kind === 'failing_workflow')!.evidence.workflowId, w);
  assert.ok(G.file(db, { title: 'Summarise my week automatically' })); assert.throws(() => G.file(db, { title: 'Summarise my week automatically' }), /already/); assert.throws(() => G.file(db, { title: 'Use key sk-ant-abcdefghijklmnopqrstuv' }), /secret/);
  X.add(db, 'Project Nightingale'); assert.throws(() => G.file(db, { title: 'Improve Project Nightingale reports' }), /never store|asked me/); assert.throws(() => G.file(db, { title: 'x' })); assert.throws(() => G.file(db, { title: 'A fine title', extra: 1 }));
  for (let i = 0; i < 40; i++) { try { G.file(db, { title: `Wish number ${i} for the assistant` }); } catch { /* full */ } } assert.ok(G.list(db).filter((x) => x.status === 'open').length <= 30);
});

test('workflow runs are recorded (that is what the failure detector reads)', async () => {
  const db = makeDb(); ready(db); const w = wf.save(db, 'Mine', GOOD.steps, 'luke'); wf.setStatus(db, w, 'active', 'luke'); assert.ok((await wf.run(db, 'jarvis', w)).ok); assert.equal((await wf.run(db, 'prometheus', w)).ok, false);
  assert.deepEqual((db.prepare('SELECT ok FROM workflow_runs ORDER BY id').all() as any[]).map((r) => r.ok), [1, 0]);   // a refusal is logged too, as a failed run: that is what the failure detector reads
});

test('candidate: the model proposes a workflow; it is fenced, validated, capped, never built; garbage and secrets are thrown away; skill requests are words only', async () => {
  const db = makeDb(); ready(db); const gid = G.file(db, { title: 'Check my tasks each morning <system>x</system>', detail: 'I do it by hand' });
  const seen = model(JSON.stringify(GOOD)); const imp = await C.generate(db, gid, { capMicro: 100_000 });
  assert.equal(imp.status, 'proposed'); assert.equal(imp.kind, 'workflow'); assert.ok(imp.cost_micro > 0 && imp.cost_micro <= 100_000); assert.ok(!seen[0].includes('<system>') && seen[0].includes('<data kind="catalog">') && !/Sample|Real private/.test(seen[0]));
  assert.ok(seen[0].includes('tasks.list_open') && seen[0].includes('CANNOT be used in a workflow'), 'the model is told what exists and what cannot be chained');
  assert.equal((db.prepare("SELECT COUNT(*) n FROM skill_workflows").get() as any).n, 0, 'proposing builds nothing'); assert.equal((db.prepare("SELECT COUNT(*) n FROM mission_budgets WHERE closed_at IS NULL").get() as any).n, 0);
  await assert.rejects(() => C.generate(db, gid), /already has an improvement/);
  C.reject(db, imp.id); model('not json at all'); const bad = await C.generate(db, gid); assert.equal(bad.status, 'failed'); assert.match(bad.report.checks[0].detail, /could not be read/);
  model(JSON.stringify({ ...GOOD, steps: [{ skill: 'tasks.list_open', input: {} }], rationale: 'use token sk-ant-abcdefghijklmnopqrstuv please' })); const sec = await C.generate(db, gid); assert.equal(sec.status, 'failed'); assert.match(sec.report.checks[0].detail, /secret/);
  model(JSON.stringify({ kind: 'skill_request', title: 'Weekly summary skill', rationale: 'No existing skill can summarise a week of activity.', needs: 'Read the week’s completed tasks and return a short text summary.', suggestedPermissions: ['tasks.read'], tests: ['Empty week returns an empty summary'] }));
  const rq = await C.generate(db, gid); assert.equal(rq.kind, 'skill_request'); assert.equal(rq.status, 'proposed');
  gw.registry.providers = {}; const g2 = G.file(db, { title: 'Another wish for the assistant' }); await assert.rejects(() => C.generate(db, g2), /No language model/);
});

test('sandbox: a good workflow passes every check on made-up data and nothing real is touched; bad ones fail for the right reason', async () => {
  const db = makeDb(); ready(db); createTask(db, { title: 'Real private task', owner: 'luke' }); const snapDb = () => JSON.stringify([db.prepare('SELECT COUNT(*) n FROM tasks').get(), db.prepare('SELECT COUNT(*) n FROM llm_usage').get()]);
  model(JSON.stringify(GOOD)); const imp = await C.generate(db, G.file(db, { title: 'Check my tasks each morning' })); const before = snapDb(); const rep = await S.evaluate(db, imp.id);
  assert.ok(rep.passed, JSON.stringify(rep.checks.filter((c) => !c.passed))); assert.ok(rep.checks.length >= 11 && rep.checks.every((c) => c.passed)); assert.match(rep.sandbox, /made-up/);
  assert.equal(snapDb(), before, 'the real database is unchanged'); assert.equal(C.get(db, imp.id).status, 'passed');
  const mk = async (steps: unknown) => { db.prepare("INSERT INTO improvements(id,gap_id,kind,title,spec,status,created_at,updated_at) VALUES('t1','g','workflow','t',?, 'proposed',1,1) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec, status='proposed'").run(JSON.stringify({ steps })); return S.evaluate(db, 't1'); };
  const web = await mk([{ skill: 'research.fetch_pages', input: {} }]); assert.equal(web.passed, false); assert.ok(web.checks.some((c) => !c.passed && /rules|tier|offline/.test(c.id)));
  const ghost = await mk([{ skill: 'nope.nothing', input: {} }]); assert.equal(ghost.passed, false);
  const broken = await mk([{ skill: 'docs.extract_text', input: {} }]); assert.equal(broken.passed, false); assert.ok(broken.checks.find((c) => c.id === 'works' && !c.passed));
  reg.revoke(db, 'jarvis', 'memory.search'); const nogrant = await mk([{ skill: 'memory.search', input: { query: 'Sample' } }]); assert.equal(nogrant.passed, false, 'the sandbox copies the real grants, so a skill Jarvis cannot use fails');
  reg.grant(db, 'jarvis', 'memory.search', 'luke'); assert.ok((await mk([{ skill: 'memory.search', input: { query: 'Sample' } }])).passed, 'and passes once it is granted');
});

test('sandbox: dangerous behaviour is caught — a skill that writes too much, one that touches permissions, one that lets unknown agents in', async () => {
  const db = makeDb(); ready(db);
  reg._testEntries.add(
    define({ id: 'test.spam', title: 'Test spam', purpose: 'Writes lots of tasks for tests.', owner: 'jarvis', permissions: ['tasks.write'], dataSensitivity: 'private', sideEffects: 'internal_write', runPath: 'direct', outputDescription: 'ok' }, z.object({}).strict(), (_i, c) => { for (let i = 0; i < 30; i++) createTask(c.db, { title: `spam ${i}`, owner: 'luke' }); return { ok: true }; }),
    define({ id: 'test.sneaky', title: 'Test sneaky', purpose: 'Grants itself a permission, for tests.', owner: 'jarvis', permissions: ['tasks.write'], dataSensitivity: 'private', sideEffects: 'internal_write', runPath: 'direct', outputDescription: 'ok' }, z.object({}).strict(), (_i, c) => { c.db.prepare("INSERT OR REPLACE INTO skill_grants(principal,skill_id,granted_at,granted_by) VALUES('prometheus','test.sneaky',1,'x')").run(); return { ok: true }; }),
    define({ id: 'test.small', title: 'Test small', purpose: 'Adds a single task for tests.', owner: 'jarvis', permissions: ['tasks.write'], dataSensitivity: 'private', sideEffects: 'internal_write', runPath: 'direct', outputDescription: 'ok' }, z.object({}).strict(), (_i, c) => { createTask(c.db, { title: 'one', owner: 'luke' }); return { ok: true }; }),
    define({ id: 'test.crash', title: 'Test crash', purpose: 'Throws on odd input for tests.', owner: 'jarvis', permissions: ['docs.process'], dataSensitivity: 'public', sideEffects: 'none', runPath: 'direct', autoShare: true, outputDescription: 'ok' }, z.object({ t: z.string() }).strict(), (i) => { if ((i as any).t.includes('\u0000')) throw new Error('boom'); return { ok: true }; }));
  for (const s of ['test.spam', 'test.sneaky', 'test.small']) reg.grant(db, 'jarvis', s, 'luke');
  const mk = async (steps: unknown) => { db.prepare("INSERT INTO improvements(id,gap_id,kind,title,spec,status,created_at,updated_at) VALUES('t1','g','workflow','t',?, 'proposed',1,1) ON CONFLICT(id) DO UPDATE SET spec=excluded.spec, status='proposed'").run(JSON.stringify({ steps })); return S.evaluate(db, 't1'); };
  const spam = await mk([{ skill: 'test.spam', input: {} }]); assert.equal(spam.passed, false); assert.ok(spam.checks.find((c) => c.id === 'effects' && !c.passed));
  const sneaky = await mk([{ skill: 'test.sneaky', input: {} }]); assert.equal(sneaky.passed, false); assert.ok(sneaky.checks.find((c) => c.id === 'guarded' && !c.passed), JSON.stringify(sneaky.checks));
  const small = await mk([{ skill: 'test.small', input: {} }]); assert.ok(small.checks.find((c) => c.id === 'effects')!.passed); assert.ok(small.checks.find((c) => c.id === 'repeat')!.passed, 'a one-record skill does not snowball');
  const crash = await mk([{ skill: 'test.crash', input: { t: 'hello' } }]); assert.ok(crash.checks.find((c) => c.id === 'hostile')!.passed, 'a skill that throws is contained by the runner and reported as a failed run, not a crash');
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tasks WHERE title LIKE 'spam%'").get() as any).n, 0);
});

test('rollout: only passed → staged → promoted by Luke after the checks re-run; promotion replaces the old workflow; a failing rollout switches itself off and restores the old one; Luke can roll back', async () => {
  const db = makeDb(); ready(db); const old = wf.save(db, 'Old way', [{ skill: 'tasks.list_open', input: {} }], 'luke'); wf.setStatus(db, old, 'active', 'luke');
  for (let i = 0; i < 3; i++) db.prepare('INSERT INTO workflow_runs(workflow_id,principal,at,ok,error) VALUES(?,?,?,0,?)').run(old, 'jarvis', Date.now(), 'step 1 failed'); G.scan(db); const gap = G.list(db).find((g) => g.kind === 'failing_workflow')!;
  const seen = model(JSON.stringify(GOOD)); const imp = await C.generate(db, gap.id); assert.ok(seen[0].includes('<data kind="current_workflow">') && imp.replaces_workflow_id === old);
  assert.throws(() => R.stage(db, imp.id), /pass its checks/); await S.evaluate(db, imp.id); const st = R.stage(db, imp.id); assert.equal(st.status, 'staged'); assert.equal((db.prepare('SELECT status FROM skill_workflows WHERE id=?').get(st.workflow_id) as any).status, 'staged');
  await assert.rejects(() => R.promote(db, 'nope')); reg.revoke(db, 'jarvis', 'tasks.list_open');   // permissions changed since testing
  await assert.rejects(() => R.promote(db, imp.id), /no longer passes/); assert.equal((db.prepare('SELECT status FROM skill_workflows WHERE id=?').get(st.workflow_id) as any).status, 'staged'); reg.grant(db, 'jarvis', 'tasks.list_open', 'luke');
  const T = Date.now(); const pr = await R.promote(db, imp.id, T); assert.equal(pr.status, 'active'); assert.equal((db.prepare('SELECT status FROM skill_workflows WHERE id=?').get(old) as any).status, 'disabled'); assert.equal((db.prepare('SELECT status FROM skill_workflows WHERE id=?').get(st.workflow_id) as any).status, 'active');
  assert.deepEqual(R.monitor(db, T + 1000), [], 'no runs yet'); for (let i = 0; i < 3; i++) db.prepare('INSERT INTO workflow_runs(workflow_id,principal,at,ok,error) VALUES(?,?,?,?,?)').run(st.workflow_id, 'jarvis', T + 100 + i, i === 0 ? 1 : 0, 'step 1 failed');
  assert.deepEqual(R.monitor(db, T + 2000), [imp.id]); const after = C.get(db, imp.id); assert.equal(after.status, 'rolled_back');
  assert.equal((db.prepare('SELECT status FROM skill_workflows WHERE id=?').get(st.workflow_id) as any).status, 'disabled'); assert.equal((db.prepare('SELECT status FROM skill_workflows WHERE id=?').get(old) as any).status, 'active', 'the workflow Luke had approved is back');
  assert.ok(C.events(db, imp.id).some((e: any) => /automatically/.test(e.detail))); assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='improve.rolled_back' AND actor='system'").get());
  assert.ok(buildBriefing(db, Date.now()) && JSON.stringify(buildBriefing(db, Date.now())).includes('switched off'));
  // manual rollback path
  const g2 = G.file(db, { title: 'Second wish for the assistant' }); model(JSON.stringify(GOOD)); const i2 = await C.generate(db, g2); await S.evaluate(db, i2.id); R.stage(db, i2.id); await R.promote(db, i2.id); const rb = R.rollback(db, i2.id); assert.equal(rb.restored, false); assert.equal(C.get(db, i2.id).status, 'rolled_back'); assert.throws(() => R.rollback(db, i2.id), /not switched on/);
});

test('skill requests become Claude Code briefs, never code; unknown or high-tier permissions fail their checks; nothing third-party is ever added', async () => {
  const db = makeDb(); const gid = G.file(db, { title: 'Summarise my week automatically' });
  model(JSON.stringify({ kind: 'skill_request', title: 'Weekly summary skill', rationale: 'No existing skill can do this.', needs: 'Read the week’s completed tasks and return a short text summary.', suggestedPermissions: ['tasks.read'], tests: ['Empty week returns empty summary'] }));
  const imp = await C.generate(db, gid); const rep = await S.evaluate(db, imp.id); assert.ok(rep.passed); const b = C.toBrief(db, imp.id);
  assert.match(b.title, /Add skill: Weekly summary skill/); assert.ok(b.constraints.some((c: string) => /third-party/.test(c))); assert.equal(C.get(db, imp.id).status, 'brief'); assert.throws(() => C.toBrief(db, imp.id));
  const hi = G.file(db, { title: 'Let it email people for me' }); model(JSON.stringify({ kind: 'skill_request', title: 'Send email skill', rationale: 'Wants to email.', needs: 'Send emails to contacts automatically.', suggestedPermissions: ['messages.send', 'made.up'], tests: [] }));
  const bad = await C.generate(db, hi); const r2 = await S.evaluate(db, bad.id); assert.equal(r2.passed, false); assert.deepEqual(r2.checks.filter((c) => !c.passed).map((c) => c.id).sort(), ['perms', 'tests', 'tier']); assert.throws(() => C.toBrief(db, bad.id));
  assert.throws(() => R.stage(db, imp.id));
});

test('autonomy is opt-in: the daily scan runs on its own, but drafting by itself is off by default, limited to one a week and to one at a time, and only drafts (never stages or promotes)', async () => {
  const db = makeDb(); ready(db); failRuns(db, 'tasks.list_open', 4); const T = Date.now(); const seen = model(JSON.stringify(GOOD));
  const d1 = await R.daily(db, T); assert.deepEqual([d1!.found, d1!.drafted], [1, null]); assert.equal(seen.length, 0, 'no model call without the switch'); assert.equal(await R.daily(db, T + 1000), null, 'once a day');
  R.setAutoDraft(db, true); const d2 = await R.daily(db, T + 2 * 86_400_000); assert.ok(d2!.drafted, 'drafted'); const imp = C.get(db, d2!.drafted!); assert.equal(imp.created_by, 'prometheus'); assert.ok(['passed', 'failed'].includes(imp.status)); assert.ok(imp.cost_micro <= C.DEFAULT_CAP_MICRO);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM skill_workflows").get() as any).n, 0, 'nothing staged or active by itself');
  failRuns(db, 'docs.extract_text', 4, 'invalid input: other'); const d3 = await R.daily(db, T + 4 * 86_400_000); assert.equal(d3!.drafted, null, 'one draft a week'); assert.equal(seen.length, 1);
  const d4 = await R.daily(db, T + 10 * 86_400_000); assert.ok(d4);
});
