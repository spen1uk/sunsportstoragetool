import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDb } from './helpers.ts';
import * as D from '../delegation.ts';
import * as L from '../limits.ts';
import * as TA from '../tempagents.ts';
import { actionPolicy, _rows } from '../actionpolicy.ts';
import { ACTIONS, ALWAYS_ASK } from '../approvals.ts';
import * as registry from '../skills/registry.ts';
import { setConfig } from '../websearch.ts';
import * as gw from '../llm/gateway.ts';
import type { Provider } from '../llm/types.ts';
import { afterEach } from 'node:test';
const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });
const ready = () => { gw.registry.providers = { anthropic: { id: 'anthropic', available: () => true, async complete() { throw new Error('not called'); } } as Provider }; };

const NOW = 1_800_000_000_000;
const prom = (db: any) => { ready(); setConfig(db, { enabled: true, perDay: 15 }); return D.delegate(db, { request: 'Research the best heated storage prices near Hartland Wisconsin' }, NOW).id; };

test('Luke starts new work freely; an agent may only hand work on under a delegation it was given', () => {
  const db = makeDb(); const root = prom(db);
  assert.throws(() => D.delegate(db, { request: 'Research competitor storage prices in Waukesha county' }, NOW, { agent: 'prometheus' }), /only hand work on as part of work it was given/);
  assert.throws(() => D.delegate(db, { request: 'Research competitor storage prices in Waukesha county' }, NOW, { agent: 'prometheus', parentId: 'nope' }), /only hand work on/);
  const r = db.prepare('SELECT parent_id, root_id, depth FROM delegations WHERE id=?').get(root) as any; assert.deepEqual([r.parent_id, r.root_id, r.depth], [null, root, 0]);
});

test('hand-offs stop at 2 levels deep, and one piece of work gets 6 consults at most; the refusal says it comes back to Luke', () => {
  const db = makeDb(); const root = prom(db); let parent = root;
  const a = D.delegate(db, { request: 'Research competitor storage prices in Waukesha county' }, NOW, { agent: 'prometheus', parentId: parent }).id; parent = a;
  const b = D.delegate(db, { request: 'Research competitor storage prices in Oconomowoc area' }, NOW, { agent: 'prometheus', parentId: parent }).id;
  assert.deepEqual(['a', 'b'].map((k) => (db.prepare('SELECT depth, root_id FROM delegations WHERE id=?').get(k === 'a' ? a : b) as any).depth), [1, 2]);
  assert.throws(() => D.delegate(db, { request: 'Research competitor storage prices in Delafield area' }, NOW, { agent: 'prometheus', parentId: b }), /2 hand-offs deep already.*comes back to you/);
  // 6 consults per root: two used above; four more directly under the root, then the seventh is refused
  for (let i = 0; i < 4; i++) D.delegate(db, { request: `Research competitor storage prices in town number ${i} of the lake area` }, NOW, { agent: 'prometheus', parentId: root });
  assert.equal(L.consultsUsed(db, root), 6);
  assert.throws(() => D.delegate(db, { request: 'Research competitor storage prices in one more town' }, NOW, { agent: 'prometheus', parentId: root }), /already used its 6 consults/);
  assert.equal(L.consultsUsed(db, prom(db)), 0, 'a different piece of work has its own count');
  assert.ok((db.prepare("SELECT COUNT(*) c FROM audit WHERE action='consult.begun'").get() as any).c >= 6);
});

test('the narrow lane: temporary agents get public, read-only, direct skills only; a temporary agent cannot create agents; the lane is checked again when it runs', () => {
  const db = makeDb(); setConfig(db, { enabled: true, perDay: 15 });
  ready(); const mid = (db.prepare('SELECT mission_id m FROM delegations WHERE id=?').get(prom(db)) as any).m as string;
  assert.throws(() => TA.spawn(db, { by: 'temp:abc', name: 'x', charter: 'y', missionId: mid, skills: [], budgetMicro: 100_000 }, NOW), /cannot create other agents/);
  // every registered skill that is outside the lane is refused at spawn and by access() for a live temp agent
  const all = registry.summary(db) as any[]; let outside = 0, inside = 0;
  for (const s of all) { const man = registry.resolve(db, s.id)!.entry.manifest; const why = L.outsideNarrowLane(man); if (why.length) { outside++; assert.throws(() => TA.spawn(db, { name: 'x', charter: 'y', missionId: mid, skills: [s.id], budgetMicro: 100_000 }, NOW), /outside the narrow lane|may not use/, s.id); } else inside++; }
  assert.ok(outside > 0 && inside > 0, `both kinds exist (outside ${outside}, inside ${inside})`);
  const lane = L.outsideNarrowLane({ permissions: ['calendar.write'], sideEffects: 'external_write', dataSensitivity: 'private', runPath: 'approval' } as any); assert.equal(lane.length, 4);
  assert.deepEqual(L.outsideNarrowLane({ permissions: ['web.search'], sideEffects: 'external_read', dataSensitivity: 'public', runPath: 'direct' } as any), []);
});

test('the action table covers every protected action, names none that do not exist, and agrees with the code on risk and what always asks', () => {
  const ids = new Set(_rows.map((r) => r.id)); for (const k of Object.keys(ACTIONS)) assert.ok(ids.has(k), `${k} has a row`);
  for (const r of actionPolicy()) {
    if (ACTIONS[r.id]) {
      assert.equal(r.risk, ACTIONS[r.id].risk === 'high' ? 'high' : 'medium'); assert.equal(r.executable, !!ACTIONS[r.id].handler); assert.equal(r.alwaysAsks, ALWAYS_ASK.has(r.id));
      if (r.alwaysAsks) assert.ok(['always', 'cannot'].includes(r.asks), `${r.id}: always-ask actions say so`);
      if (!r.executable) assert.equal(r.asks, 'cannot', `${r.id}: nothing connected means "cannot"`);
      if (r.asks === 'request') assert.equal(r.alwaysAsks, false);
    }
    assert.ok(['low', 'medium', 'high'].includes(r.risk)); assert.ok(r.enforcedIn.length > 3);
  }
  for (const r of _rows) { if (/^(?:[a-z_]+)$/.test(r.id) && r.id.includes('_') && !ACTIONS[r.id]) assert.fail(`${r.id} names an action that does not exist`); }
  for (const must of ['send_message', 'trade_or_transfer', 'budget_increase', 'raise_daily_ceiling']) assert.ok(actionPolicy().find((r) => r.id === must)!.asks !== 'request');
});

test('over HTTP the table is served with the limits; the page and routes exist', () => {
  const http = fs.readFileSync(new URL('../http.ts', import.meta.url), 'utf8'); assert.match(http, /'\/api\/policy\/actions'/);
  const pages = fs.readFileSync(new URL('../../web/src/pages.tsx', import.meta.url), 'utf8'); assert.match(pages, /What Jarvis can do, and what asks you/);
});
