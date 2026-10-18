import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as reg from '../skills/registry.ts';
import { overview } from '../agentsview.ts';
import { createTask } from '../tasks.ts';
import * as memory from '../memory.ts';
import { createAssigned } from '../missions.ts';

test('agents page: shows the real agents with what the live registry lets each do; Prometheus never gets private skills; counts and spend are real; planned ones are labelled not connected', async () => {
  const db = makeDb(); createTask(db, { title: 'Secret marina deal', owner: 'luke' }); memory.remember(db, 'private fact about boats', { source: 't' });
  reg.grant(db, 'jarvis', 'memory.search', 'luke'); const before = overview(db); const j = before.agents.find((a) => a.id === 'jarvis')!, p = before.agents.find((a) => a.id === 'prometheus')!;
  assert.ok(j.skills.some((s: any) => s.id === 'memory.search') && !p.skills.some((s: any) => s.id === 'memory.search'));
  assert.ok(p.skills.every((s: any) => s.data === 'public'), 'Prometheus only has public-data skills'); assert.match(p.sees, /public/); assert.match(j.sees, /private/);
  assert.ok(j.now[0].startsWith('1 open task')); assert.equal(p.status, 'Idle');
  reg.revoke(db, 'jarvis', 'memory.search'); assert.ok(!overview(db).agents[0].skills.some((s: any) => s.id === 'memory.search'), 'read live: revoking removes it at once');
  db.prepare("INSERT INTO llm_usage(at,task,provider,model,cost_micro_usd,ok) VALUES(?,?,?,?,?,1)").run(Date.now(), 'chat', 'anthropic', 'm', 12_000); db.prepare("INSERT INTO llm_usage(at,task,provider,model,cost_micro_usd,ok) VALUES(?,?,?,?,?,1)").run(Date.now(), 'web', 'anthropic', 'm', 30_000);
  const o = overview(db); assert.equal(o.agents[0].month, 12_000); assert.equal(o.agents[1].month, 30_000);
  db.prepare("INSERT INTO skill_runs(skill_id,version,principal,at,ok,ms,input_sha256,refused) VALUES('memory.search','1.0.0','jarvis',?,0,0,'x','not granted')").run(Date.now()); assert.match(overview(db).agents[0].recent[0].text, /refused/i);
  createAssigned(db, { goal: 'Work out the best way to cut winter storage costs' }); assert.match(overview(db).agents[1].status, /Working/);
  assert.ok(o.planned.length >= 3 && o.planned.every((x) => ['planned', 'demo', 'connected', 'live', 'stale', 'disconnected'].includes(x.status))); assert.ok(o.planned.some((x) => x.status === 'planned'));
  assert.ok(!JSON.stringify(o).includes('Secret marina') && !JSON.stringify(o).includes('private fact'), 'no private content ever appears');
});
