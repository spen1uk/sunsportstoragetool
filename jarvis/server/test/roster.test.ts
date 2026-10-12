import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './helpers.ts';
import { seedStructure } from '../seed.ts';
import { TRADING, INVESTING } from '../roster.ts';

const agents = (db: any, parent: string) => db.prepare('SELECT * FROM agents WHERE parent_id=? ORDER BY sort').all(parent) as any[];

test('Trading and Investing appear as PLANNED systems with grouped departments and their members', () => {
  const db = makeDb();
  const t = agents(db, 'trading'), i = agents(db, 'investing');
  assert.deepEqual(t.map((d) => d.name), ['Inputs', 'Risk', 'Execution', 'Records', 'Learning', 'Oversight']);
  assert.deepEqual(i.map((d) => d.name), ['Briefing', 'Research', 'Data & Inputs', 'Portfolio']);
  for (const a of [...t, ...i, db.prepare("SELECT * FROM agents WHERE id IN ('trading','investing')").all()].flat() as any[]) assert.equal(a.status_kind, 'planned', `${a.id} must not claim to be live`);
  const names = (d: any) => (JSON.parse(d.members) as any[]).map((m) => m.name);
  assert.deepEqual(names(t[1]), ['Risk Manager']);
  assert.ok(names(t[2]).includes('Reconciler') && names(t[3]).includes('Performance Accountant'));          // additions from the review
  assert.equal(TRADING.depts.flatMap((d) => d.members).length, 17);                                          // Luke's 16 minus the Supervisor (the system's sun) = 15, incl. Reporter shown as handled by Jarvis, + 2 additions (Reconciler, Performance Accountant)
});

test('review decisions are recorded: Reporter and Ask the System are Jarvis\'s job, not separate agents', () => {
  const all = [...TRADING.depts, ...INVESTING.depts].flatMap((d) => d.members);
  assert.equal(all.find((m) => m.name === 'Reporter')!.claimed, 'jarvis'); assert.equal(all.find((m) => m.name === 'Ask the System')!.claimed, 'jarvis');
  assert.equal(all.find((m) => m.name === 'Go-Live Gatekeeper')!.claimed, 'not_built');                      // stays honest about what is unbuilt
  assert.ok(all.filter((m) => m.claimed === 'unstated').length >= 8);                                          // Investing statuses were not given; never invented
});

test('statuses are labelled as claims; nothing in the roster says connected or live', () => {
  const claims = new Set([...TRADING.depts, ...INVESTING.depts].flatMap((d) => d.members).map((m) => m.claimed));
  for (const c of claims) assert.ok(['built', 'partial', 'not_built', 'new', 'later', 'jarvis', 'unstated'].includes(c), c);
  const db = makeDb(); const c = db.prepare("SELECT status,note FROM connections WHERE id IN ('trading-system','investing-system')").all() as any[];
  assert.equal(c.length, 2); assert.ok(c.every((x) => x.status === 'planned'));
  assert.match(c.find((x) => /never holds exchange keys/.test(x.note))!.note, /never places trades/);
});

test('re-seeding refreshes planned text but never overwrites a system that has been connected', () => {
  const db = makeDb();
  db.prepare("UPDATE agents SET description='stale text' WHERE id='trading-risk'").run(); seedStructure(db);
  assert.notEqual((db.prepare("SELECT description FROM agents WHERE id='trading-risk'").get() as any).description, 'stale text');
  db.prepare("UPDATE agents SET status_kind='connected', description='LIVE heartbeat ok' WHERE id='trading'").run(); seedStructure(db);
  const t = db.prepare("SELECT status_kind,description FROM agents WHERE id='trading'").get() as any; assert.deepEqual([t.status_kind, t.description], ['connected', 'LIVE heartbeat ok']);
});
