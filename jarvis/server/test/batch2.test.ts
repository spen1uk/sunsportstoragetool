import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as gw from '../llm/gateway.ts';
import type { Completion, Provider } from '../llm/types.ts';
import * as K from '../knowledge.ts';
import * as X from '../exclusions.ts';
import * as D from '../decisions.ts';
import { buildRecap } from '../today.ts';
import { requestApproval } from '../approvals.ts';

const orig = gw.registry.providers; afterEach(() => { gw.registry.providers = orig; });

test('nightly review: lists what needs your decision tonight; research findings are kept in the knowledge graph, once, and never for excluded topics', () => {
  const db = makeDb(); assert.deepEqual(buildRecap(db).decisionsNeeded, []);
  requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 150_000_000 }, requestedBy: 'luke' });
  const d = D.create(db, { title: 'Move the shop', expectedBy: '2026-01-01' }); D.decide(db, d.id, { chosen: 'move' });
  const r = buildRecap(db, Date.UTC(2026, 9, 19)); assert.ok(r.decisionsNeeded.some((x) => /approval/.test(x))); assert.ok(r.decisionsNeeded.some((x) => /look back on “Move the shop”/.test(x)));
  const id = K.saveFindings(db, 'task1', 'What are the best crypto cold storage wallets?', 'Hardware wallets such as Ledger and Trezor are the usual picks.'); assert.ok(id);
  const e = K.getEntity(db, id!)!; assert.deepEqual([e.kind, e.origin, e.scope], ['topic', 'prometheus', 'public']); assert.match(e.notes, /Ledger/); assert.ok(db.prepare("SELECT 1 FROM entity_links WHERE entity_id=? AND kind='research'").get(id));
  assert.equal(K.saveFindings(db, 'task1', 'What are the best crypto cold storage wallets?', 'Updated summary.'), id, 'same job updates in place'); assert.match(K.getEntity(db, id!)!.notes, /Updated/);
  const other = K.saveFindings(db, 'task2', 'What are the best crypto cold storage wallets', 'Another look.'); assert.ok(other && other !== id, 'same topic from another job is kept separately');
  X.add(db, 'Project Nightingale'); assert.equal(K.saveFindings(db, 'task3', 'Project Nightingale competitors', 'x'), null);
});
