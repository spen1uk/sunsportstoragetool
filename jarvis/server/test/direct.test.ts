import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import * as appr from '../approvals.ts';
import { setDirect } from '../calendarwrite.ts';

const status = (db: any, id: string) => ({ ...(db.prepare('SELECT status, decided_by FROM approvals WHERE id=?').get(id) as any) });

test('direct mode: Luke\'s own requests inside Jarvis are done at once and recorded; money, messages and anything an agent asks for on its own still wait', () => {
  const db = makeDb();
  const r = appr.requestOrDo(db, { actionType: 'allow_domain', payload: { host: 'noaa.gov' }, requestedBy: 'luke' }); assert.equal(r.direct, true); assert.deepEqual(status(db, r.approvalId), { status: 'executed', decided_by: 'luke (direct)' });
  assert.equal((db.prepare('SELECT COUNT(*) c FROM allowed_domains WHERE host=?').get('noaa.gov') as any).c, 1);
  for (const [t, p] of [['budget_increase', { newCapMicroUsd: 200_000_000 }], ['raise_daily_ceiling', { newCeilingMicroUsd: 9_000_000 }], ['send_message', { channel: 'sms', recipient: 'Sam', text: 'hi' }], ['trade_or_transfer', { x: 1 }]] as const) {
    const x = appr.requestOrDo(db, { actionType: t, payload: p, requestedBy: 'luke' }); assert.equal(x.direct, false, t); assert.equal(status(db, x.approvalId).status, 'pending', t);
  }
  const agent = appr.requestApproval(db, { actionType: 'allow_domain', payload: { host: 'evil.example' }, requestedBy: 'jarvis' }); assert.equal(status(db, agent).status, 'pending', 'an agent asking on its own waits for Luke');
  setDirect(db, false); const off = appr.requestOrDo(db, { actionType: 'allow_domain', payload: { host: 'cdc.gov' }, requestedBy: 'luke' }); assert.equal(off.direct, false); assert.equal(status(db, off.approvalId).status, 'pending', 'switched off: approvals are back');
});
