import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { bus } from '../events.ts';
import { createTask, completeTask, claimNext } from '../tasks.ts';
import { tick } from '../worker.ts';

function capture<T>(fn: () => Promise<T> | T) {
  const got: any[] = []; const on = (e: any) => { if (e.type === 'pulse') got.push(e); }; bus.on('event', on);
  return Promise.resolve(fn()).finally(() => bus.off('event', on)).then(() => got);
}

test('pulses fire only for real agent-run work: dispatch on claim, attention when it needs Luke', async () => {
  const db = makeDb();
  createTask(db, { title: 'r', kind: 'research', input: { question: 'boat storage', urls: ['https://unlisted.example/'] } });
  const got = await capture(() => tick(db, 'w'));
  assert.deepEqual(got.map((p) => p.kind), ['dispatch', 'attention', 'attention'].slice(0, got.length));
  assert.equal(got[0].kind, 'dispatch'); assert.ok(got.some((p) => p.kind === 'attention'));
  assert.ok(got.every((p) => p.system === 'proj'));
});

test('manual tasks (Luke\'s own to-dos) never produce pulses; completing an agent task does', async () => {
  const db = makeDb();
  const m = createTask(db, { title: 'call marina' });
  assert.deepEqual(await capture(() => completeTask(db, m, 'luke', 'done')), []);
  const r = createTask(db, { title: 'research', kind: 'research', input: { question: 'q q q', urls: ['https://a.example/'] } });
  assert.deepEqual((await capture(() => completeTask(db, r, 'luke', 'accepted'))).map((p) => p.kind), ['done']);
});

test('nothing is emitted when nothing is happening (no ambient fake pulses)', async () => {
  const db = makeDb();
  assert.deepEqual(await capture(() => { claimNext(db, 'w'); }), []);
});
