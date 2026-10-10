import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, fakeSession } from './helpers.ts';
import * as appr from '../approvals.ts';
import { setPaused } from '../pause.ts';
import { getCap } from '../budget.ts';
import { sha256 } from '../db.ts';

const mkPublish = (db: any) => {
  db.prepare("INSERT OR IGNORE INTO artifacts(id,title,current_version,status,created_at) VALUES('a1','Doc',1,'approved','x')").run();
  return appr.requestApproval(db, { actionType: 'publish_artifact', payload: { artifactId: 'a1', title: 'Doc', version: 1 }, requestedBy: 'luke' });
};
const dig = (db: any, id: string) => (db.prepare('SELECT digest FROM approvals WHERE id=?').get(id) as any).digest;

test('standard approval executes exactly once; replay and duplicate are refused', () => {
  const db = makeDb(); const id = mkPublish(db);
  assert.deepEqual(appr.decide(db, id, 'approve', { digest: dig(db, id), channel: 'dashboard', session: fakeSession() }), { ok: true });
  const first = appr.execute(db, id), second = appr.execute(db, id);
  assert.equal(first.ok, true); assert.equal(second.ok, false);
  assert.match(second.outcome, /executed/);
  assert.equal((db.prepare("SELECT status FROM artifacts WHERE id='a1'").get() as any).status, 'published');
});

test('approval is bound to the digest: wrong digest rejected', () => {
  const db = makeDb(); const id = mkPublish(db);
  const r = appr.decide(db, id, 'approve', { digest: sha256('something else'), channel: 'dashboard', session: fakeSession() });
  assert.equal(r.ok, false);
});

test('changed payload after approval invalidates it and nothing executes', () => {
  const db = makeDb(); const id = mkPublish(db);
  appr.decide(db, id, 'approve', { digest: dig(db, id), channel: 'dashboard', session: fakeSession() });
  db.prepare("UPDATE approvals SET payload=? WHERE id=?").run(JSON.stringify({ artifactId: 'a1', title: 'EVIL', version: 1 }), id);
  const r = appr.execute(db, id);
  assert.equal(r.ok, false);
  assert.equal((db.prepare('SELECT status FROM approvals WHERE id=?').get(id) as any).status, 'invalidated');
  assert.equal((db.prepare("SELECT status FROM artifacts WHERE id='a1'").get() as any).status, 'approved');
});

test('expired approvals cannot be decided or executed', () => {
  const db = makeDb(); const id = mkPublish(db);
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(Date.now() - 1, id);
  assert.equal(appr.decide(db, id, 'approve', { digest: dig(db, id), channel: 'dashboard', session: fakeSession() }).ok, false);
  const id2 = mkPublish(db);
  appr.decide(db, id2, 'approve', { digest: dig(db, id2), channel: 'dashboard', session: fakeSession() });
  db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(Date.now() - 1, id2);
  assert.equal(appr.execute(db, id2).ok, false);
});

test('high-risk approval needs step-up; phone/sms channel and missing session never suffice', () => {
  const db = makeDb();
  const id = appr.requestApproval(db, { actionType: 'budget_increase', payload: { newCapMicroUsd: 150_000_000 }, requestedBy: 'luke' });
  const d = dig(db, id);
  assert.equal(appr.decide(db, id, 'approve', { digest: d, channel: 'dashboard', session: fakeSession(false) }).ok, false);
  assert.equal(appr.decide(db, id, 'approve', { digest: d, channel: 'sms', session: null }).ok, false);
  assert.equal(appr.decide(db, id, 'approve', { digest: d, channel: 'call', session: fakeSession(true) }).ok, false);
  assert.equal(getCap(db), 100_000_000);
  assert.equal(appr.decide(db, id, 'approve', { digest: d, channel: 'dashboard', session: fakeSession(true) }).ok, true);
  assert.equal(appr.execute(db, id).ok, true);
  assert.equal(getCap(db), 150_000_000);
});

test('send_message / trade can be requested and approved but never execute (no adapter)', () => {
  const db = makeDb();
  for (const [t, p] of [['send_message', { channel: 'sms', recipient: '+1555', text: 'hi' }], ['trade_or_transfer', { symbol: 'X', qty: 1 }]] as const) {
    const id = appr.requestApproval(db, { actionType: t, payload: p, requestedBy: 'jarvis' });
    appr.decide(db, id, 'approve', { digest: dig(db, id), channel: 'dashboard', session: fakeSession(true) });
    const r = appr.execute(db, id);
    assert.equal(r.ok, false);
    assert.notEqual((db.prepare('SELECT status FROM approvals WHERE id=?').get(id) as any).status, 'executed');
  }
});

test('pause blocks execution of an already-approved action', () => {
  const db = makeDb(); const id = mkPublish(db);
  appr.decide(db, id, 'approve', { digest: dig(db, id), channel: 'dashboard', session: fakeSession() });
  setPaused(db, true);
  assert.equal(appr.execute(db, id).ok, false);
  setPaused(db, false);
  assert.equal(appr.execute(db, id).ok, true);
});

test('unknown action types cannot be requested', () => {
  assert.throws(() => appr.requestApproval(makeDb(), { actionType: 'rm_rf', payload: {}, requestedBy: 'jarvis' }));
});
