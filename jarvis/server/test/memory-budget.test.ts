import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as memory from '../memory.ts';
import * as budget from '../budget.ts';
import { audit } from '../audit.ts';

test('secrets never become memory; correction supersedes; forget hard-deletes', () => {
  const db = makeDb();
  for (const s of ['my password is hunter2', 'api key sk-abcdefghijklmnopqrstuvwx', 'card 4111111111111111', 'the verification code: 123456'])
    assert.equal(memory.remember(db, s, { source: 't' }).ok, false, s);
  const a = memory.remember(db, 'Luke prefers espresso', { source: 't' }) as any;
  const b = memory.update(db, a.id, 'Luke prefers flat white') as any;
  assert.equal((db.prepare('SELECT superseded_by FROM memories WHERE id=?').get(a.id) as any).superseded_by, b.id);
  assert.equal((memory.search(db, 'espresso') as any[]).length, 0);
  assert.equal(memory.forget(db, a.id), true); assert.equal(memory.forget(db, b.id), true);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM memories').get() as any).c, 0);
});

test('audit redacts secret-looking content', () => {
  const db = makeDb(); audit(db, 'x', 'test', 't', { note: 'token=abc123 and sk-abcdefghijklmnopqrstuvwxyz' });
  const d = (db.prepare('SELECT detail FROM audit ORDER BY id DESC LIMIT 1').get() as any).detail;
  assert.ok(!d.includes('abc123') && !d.includes('sk-abcdef')); assert.match(d, /REDACTED/);
});

test('budget: fixed costs reserved first; 75/90/cap levels; optional blocked at 90%; cap never exceeded', () => {
  const db = makeDb();
  assert.equal(budget.summary(db).level, 'ok');
  budget.addFixedCost(db, 'hosting', 74_000_000, 'test');
  assert.equal(budget.summary(db).level, 'ok');
  const r = budget.reserve(db, 2_000_000, 'ai') as any; assert.equal(r.ok, true);
  assert.equal(budget.summary(db).level, 'watch75');
  budget.settle(db, r.id, 1_500_000);
  const s = budget.summary(db); assert.equal(s.usageMicroUsd, 1_500_000); assert.equal(s.reservedMicroUsd, 0);
  budget.reserve(db, 14_000_000, 'ai'); // → 89.5M
  assert.equal(budget.summary(db).level, 'watch75');
  budget.reserve(db, 1_000_000, 'ai');  // → 90.5M
  assert.equal(budget.summary(db).level, 'limit90');
  assert.equal((budget.reserve(db, 1000, 'research', { optional: true }) as any).ok, false);
  assert.equal((budget.reserve(db, 1000, 'essential') as any).ok, true);
  assert.equal((budget.reserve(db, 20_000_000, 'essential') as any).ok, false); // would exceed cap
  assert.ok(budget.summary(db).committedMicroUsd <= budget.summary(db).capMicroUsd);
});

test('budget period follows America/Chicago, not UTC', () => {
  // 2026-11-01 03:30 UTC is still Oct 31 in Chicago (CDT→CST change is that morning).
  assert.equal(budget.currentPeriod(new Date('2026-11-01T03:30:00Z')), '2026-10');
  assert.equal(budget.currentPeriod(new Date('2026-11-01T06:30:00Z')), '2026-11');
});
