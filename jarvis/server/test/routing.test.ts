import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, Provider } from '../llm/types.ts';
import * as reg from '../skills/registry.ts';
import * as wf from '../skills/workflow.ts';
import { define } from '../skills/catalog.ts';
import * as R from '../skills/router.ts';
import { converse } from '../converse.ts';
import * as memory from '../memory.ts';
import * as X from '../exclusions.ts';
import { setPaused } from '../pause.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; reg._testEntries.clear(); });
/** A scripted router: answers the routing prompt with `pick`, anything else with a plain chat line. */
const model = (pick: (u: string) => unknown) => { const calls: { system: string; user: string }[] = []; gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete(req) { const u = req.messages[0].content; calls.push({ system: req.system, user: u }); const routing = req.system.includes('route a request'); return { text: routing ? JSON.stringify(pick(u)) : 'Plain chat answer.', model: req.model, stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } } as Completion; } } as Provider }; return calls; };
const routingCalls = (c: { system: string }[]) => c.filter((x) => x.system.includes('route a request')).length;

test('routing: a plain request is matched to one skill; only an allowed, read-only skill runs; the reply says which; the model never sees results', async () => {
  const db = makeDb(); memory.remember(db, 'Harbor Lights budget is tight this quarter', { source: 't' }); reg.grant(db, 'jarvis', 'memory.search', 'luke');
  const calls = model(() => ({ skill: 'memory.search', input: { query: 'harbor' } }));
  const r = await converse(db, 'check my memories on the harbor budget'); assert.equal(r.source, 'command'); assert.match(r.text, /I used “Search memory”/); assert.match(r.text, /Harbor Lights budget is tight/);
  assert.ok(!calls.some((c) => c.user.includes('Harbor Lights budget')), 'the private result never goes to the model'); assert.ok((db.prepare("SELECT COUNT(*) n FROM skill_runs WHERE skill_id='memory.search' AND ok=1").get() as any).n === 1); assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='skill.routed'").get());
});

test('routing: not granted → explained, nothing runs; model picks an unknown or null skill → ordinary chat; bad input → ordinary chat; paused, private mode and SMS never route', async () => {
  const db = makeDb(); memory.remember(db, 'secret-ish fact about boats', { source: 't' });
  let calls = model(() => ({ skill: 'memory.search', input: { query: 'boats' } })); const no = await converse(db, 'use the memory search for boats'); assert.match(no.text, /not allowed to use it yet.*Skills page/); assert.equal((db.prepare("SELECT COUNT(*) n FROM skill_runs WHERE ok=1").get() as any).n, 0);
  reg.grant(db, 'jarvis', 'memory.search', 'luke');
  for (const pick of [{ skill: null }, { skill: 'made.up' }, { skill: 'memory.search', input: { query: 1 } }, { skill: 'memory.search', input: { query: 'boats', extra: 'x' } }]) { calls = model(() => pick); const r = await converse(db, 'check my memories on boats'); assert.match(r.text, /Plain chat answer/, JSON.stringify(pick)); }
  calls = model(() => ({ skill: 'memory.search', input: { query: 'boats' } })); await converse(db, 'check my memories on boats', { private: true }); await converse(db, 'check my memories on boats', { channel: 'sms' }); assert.equal(routingCalls(calls), 0);
  setPaused(db, true); await converse(db, 'check my memories on boats'); assert.equal(routingCalls(calls), 0, 'paused: no model calls'); setPaused(db, false);
});

test('routing: ordinary chat pays nothing extra (the cheap word-overlap gate), excluded names are never sent, and tier-3 or non-direct skills are never offered', async () => {
  const db = makeDb(); reg.grant(db, 'jarvis', 'memory.search', 'luke'); const calls = model(() => ({ skill: null }));
  await converse(db, 'tell me a joke about elephants'); assert.equal(routingCalls(calls), 0); await converse(db, 'check my memories on harbor'); assert.equal(routingCalls(calls), 1);
  X.add(db, 'Project Nightingale'); await converse(db, 'check my memories on Project Nightingale'); assert.equal(routingCalls(calls), 1, 'excluded names are not routed');
  const ids = R.candidates(db).map((c) => c.id); assert.ok(ids.includes('memory.search') && ids.includes('search.everything')); assert.ok(!ids.includes('research.deep') && !ids.includes('research.web_answer'), 'turn/job/proposal skills are not routable'); assert.ok(R.candidates(db).every((c) => !c.id.startsWith('tasks.add')));
  assert.ok(R.prefilter('what are my open tasks', R.candidates(db)).some((c) => c.id === 'tasks.list_open')); assert.equal(R.prefilter('hello', R.candidates(db)).length, 0);
});

test('routing: skills that change things are explained not run; active workflows can be run by plain words; render is plain and capped', async () => {
  const db = makeDb();
  reg._testEntries.add(define({ id: 'test.writer', title: 'Test writer', purpose: 'Writes a note somewhere for tests.', owner: 'jarvis', permissions: ['tasks.write'], dataSensitivity: 'private', sideEffects: 'internal_write', runPath: 'direct', outputDescription: 'ok' }, z.object({ text: z.string() }).strict(), () => ({ wrote: true })));
  reg.grant(db, 'jarvis', 'test.writer', 'luke'); let calls = model(() => ({ skill: 'test.writer', input: { text: 'x' } })); const w = await converse(db, 'use the test writer to write a note'); assert.match(w.text, /changes things, so I won't run it from a chat message/); assert.equal((db.prepare("SELECT COUNT(*) n FROM skill_runs WHERE skill_id='test.writer'").get() as any).n, 0);
  reg.grant(db, 'jarvis', 'tasks.list_open', 'luke'); const id = wf.save(db, 'Morning look', [{ skill: 'tasks.list_open', input: {} }], 'luke'); wf.setStatus(db, id, 'active', 'luke');
  calls = model(() => ({ skill: `workflow:${id}`, input: {} })); const r = await converse(db, 'run my morning look workflow'); assert.match(r.text, /I ran your “Morning look” workflow/); assert.equal(routingCalls(calls), 1);
  assert.equal(R.render([{ title: 'A', snippet: 'B' }, 'plain']), '- A — B\n- plain'); assert.ok(R.render(Array.from({ length: 50 }, (_, i) => ({ t: 'x'.repeat(200) + i }))).length <= 1400); assert.equal(R.render([]), 'Nothing to show.');
});
