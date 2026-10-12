import test from 'node:test';
import assert from 'node:assert/strict';
import { greeting, statusLine, chicagoHour } from '../../web/src/greeting.ts';

const at = (iso: string) => new Date(iso);

test('greeting follows Chicago time, including daylight saving', () => {
  assert.equal(greeting(at('2026-10-12T13:00:00Z')), 'Good morning, sir.');      // 08:00 CDT
  assert.equal(greeting(at('2026-12-14T14:00:00Z')), 'Good morning, sir.');      // 08:00 CST
  assert.equal(greeting(at('2026-10-12T18:30:00Z')), 'Good afternoon, sir.');    // 13:30 CDT
  assert.equal(greeting(at('2026-10-12T23:00:00Z')), 'Good evening, sir.');      // 18:00 CDT
  assert.equal(greeting(at('2026-10-13T05:30:00Z')), 'Working late, sir?');      // 00:30 CDT
  assert.equal(chicagoHour(at('2026-03-08T08:30:00Z')), 3);                      // spring-forward morning: 02:30 does not exist, 08:30Z = 03:30 CDT
  assert.equal(greeting(at('2026-10-12T13:00:00Z'), ' Luke '), 'Good morning, Luke.'); assert.equal(greeting(at('2026-10-12T13:00:00Z'), ''), 'Good morning, sir.');
});

test('status line is built only from real counts and reads naturally', () => {
  const z = { approvals: 0, review: 0, blocked: 0, running: 0, paused: false };
  assert.equal(statusLine(z), 'All quiet. Nothing needs you right now.');
  assert.equal(statusLine({ ...z, approvals: 1 }), '1 decision waiting for you.');
  assert.equal(statusLine({ ...z, approvals: 2, review: 1 }), '2 decisions waiting for you and 1 draft ready to review.');
  assert.equal(statusLine({ ...z, approvals: 2, review: 3, blocked: 1, running: 4 }), '2 decisions waiting for you, 3 drafts ready to review, 1 task stuck and 4 jobs running.');
  assert.match(statusLine({ ...z, approvals: 5, paused: true }), /paused/);       // pause outranks everything
});
