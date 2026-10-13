import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import * as inv from '../src/domain/inventory.js';
import * as outreach from '../src/domain/outreach.js';
import { queueOutbound } from '../src/domain/messaging.js';
import { simulatorControl } from '../src/providers/sms.js';
import { buildApp } from '../src/server/app.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>;
beforeEach(async () => { s = await resetDb(); sam = actor(s, 'sam', 'staff', ['sales']); owner = actor(s, 'owner', 'owner'); });
afterAll(() => pool.end());

const boat = (o: Partial<inv.BoatInput> = {}): inv.BoatInput => ({ externalId: 'B' + Math.random().toString(36).slice(2, 8), status: 'available', year: 2019, make: 'Sea Ray', model: 'SLX 250', boatType: 'bowrider', lengthFt: 25, price: 32000, features: ['bimini top', 'depth finder'], mediaIds: [], ...o });
const prefs = (o: object = {}) => ({ budgetMax: 35000, boatTypes: ['bowrider'], lengthMin: 22, lengthMax: 27, features: ['bimini'], ...o });
const run = async () => { await drain(); };
// drain() only knows registered handlers; recompute is a handler, so one drain processes it.

describe('scoring', () => {
  const P = (o: Partial<inv.Prefs> = {}): inv.Prefs => ({ budget_min: null, budget_max: 35000, boat_types: ['bowrider'], length_min: 22, length_max: 27, features: ['bimini'], ...o });
  const B = (o: Partial<inv.BoatRow> = {}): inv.BoatRow => ({ year: 2019, make: 'Sea Ray', model: 'SLX', boat_type: 'bowrider', length_ft: 25, price: 32000, features: ['Bimini Top'], ...o });
  it('explains every criterion; full match scores 100', () => {
    const r = inv.scoreBoat(P(), B()); expect(r.verdict).toBe('match'); expect(r.score).toBe(100);
    expect(r.reasons.map((x) => [x.criterion, x.result])).toEqual([['budget', 'match'], ['type', 'match'], ['length', 'match'], ['features', 'match']]);
  });
  it('over budget / wrong type / far outside length DISQUALIFY with a reason; just-outside length is partial', () => {
    expect(inv.scoreBoat(P(), B({ price: 40000 })).reasons[0]).toMatchObject({ result: 'disqualified', detail: expect.stringContaining('$5,000 over') });
    expect(inv.scoreBoat(P(), B({ boat_type: 'pontoon' })).verdict).toBe('excluded');
    expect(inv.scoreBoat(P(), B({ length_ft: 40 })).verdict).toBe('excluded');
    expect(inv.scoreBoat(P(), B({ length_ft: 21.5 })).reasons.find((x) => x.criterion === 'length')!.result).toBe('partial');
  });
  it('missing data is NOT a match and NOT disqualifying: listed, lowers score', () => {
    const r = inv.scoreBoat(P(), B({ price: null, features: [] }));
    expect(r.verdict).toBe('match'); expect(r.reasons.filter((x) => x.result === 'missing_data').map((x) => x.criterion)).toEqual(['budget', 'features']);
    expect(r.score).toBeLessThan(inv.scoreBoat(P(), B()).score);
  });
  it('no explicit preferences → no matches (nothing is guessed)', () => {
    expect(inv.scoreBoat(P({ budget_max: null, boat_types: [], length_min: null, length_max: null, features: [] }), B())).toMatchObject({ verdict: 'excluded', hasCriteria: false });
  });
});

describe('inventory freshness and ranking', () => {
  it('ranks matches; sold boats are excluded (never recommended); stale source flags boats unverified and blocks packaging', async () => {
    const { contactId } = await newCustomerConvo(s, sam, '(414) 201-0601');
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'A', price: 30000 }), boat({ externalId: 'B', price: 34000, features: [] }), boat({ externalId: 'C', status: 'sold' }), boat({ externalId: 'D', price: 50000 }), boat({ externalId: 'E', boatType: 'pontoon' })]);
    await inv.setPreferences(sam, contactId, prefs()); await run();
    let m = await inv.getMatches(sam, contactId, { includeExcluded: true });
    expect(m.matches.map((x) => x.title + '|' + x.price)).toEqual(['2019 Sea Ray SLX 250|30000', '2019 Sea Ray SLX 250|34000']);        // A (100) before B (missing features)
    expect(m.matches.every((x) => x.availability === 'available' && x.packageable)).toBe(true);
    expect(m.excluded!.find((x) => x.excludedBecause.includes('sold'))).toBeTruthy(); expect(m.excluded!.find((x) => x.excludedBecause.includes('budget'))).toBeTruthy(); expect(m.excluded!.find((x) => x.excludedBecause.includes('type'))).toBeTruthy();
    // inventory source goes stale → still shown but flagged, never "available", not packageable
    await pool.query(`UPDATE inventory_sources SET last_success_sync_at = now() - interval '3 days'`);
    m = await inv.getMatches(sam, contactId);
    expect(m.matches.every((x) => x.availability === 'unverified_stale' && !x.packageable)).toBe(true);
    await expect(outreach.createPackage(sam, contactId, [m.matches[0].boatId])).rejects.toThrow(/cannot be offered/);
    await inv.confirmSourceCurrent(owner, 'manual'); m = await inv.getMatches(sam, contactId); expect(m.matches[0].availability).toBe('available');
  });
  it('recalculates on inventory add, price change, status change and preference update', async () => {
    const { contactId } = await newCustomerConvo(s, sam, '(414) 201-0602');
    await inv.setPreferences(sam, contactId, prefs()); await run();
    expect((await inv.getMatches(sam, contactId)).matches).toHaveLength(0);
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'X', price: 36000 })]); await run();
    expect((await inv.getMatches(sam, contactId, { includeExcluded: true })).excluded).toHaveLength(1);       // over budget → excluded
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'X', price: 33000 })]); await run();         // price drop
    expect((await inv.getMatches(sam, contactId)).matches).toHaveLength(1);
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'X', price: 33000, status: 'sold' })]); await run();   // sold
    expect((await inv.getMatches(sam, contactId)).matches).toHaveLength(0);
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'X', price: 33000, status: 'available' })]); await run();
    await inv.setPreferences(sam, contactId, prefs({ budgetMax: 20000 })); await run();                      // preference change
    expect((await inv.getMatches(sam, contactId)).matches).toHaveLength(0);
  });
  it('full sync that omits a boat marks it unknown (not sold) and removes it from confident matches', async () => {
    const { contactId } = await newCustomerConvo(s, sam, '(414) 201-0603');
    await inv.upsertBoats(owner, 'feed', [boat({ externalId: 'K1' }), boat({ externalId: 'K2' })]); await inv.setPreferences(sam, contactId, prefs()); await run();
    await inv.upsertBoats(owner, 'feed', [boat({ externalId: 'K1' })], { fullSync: true }); await run();
    expect((await inv.getMatches(sam, contactId)).matches).toHaveLength(1);
    expect((await pool.query(`SELECT status FROM inventory_boats WHERE external_id='K2'`)).rows[0].status).toBe('unknown');
  });
  it('feedback is tracked and dismissed matches stop being packageable; staff cannot change inventory', async () => {
    const { contactId } = await newCustomerConvo(s, sam, '(414) 201-0604');
    await expect(inv.upsertBoats(sam, 'manual', [boat()])).rejects.toThrow(/manager/);
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'F1' })]); await inv.setPreferences(sam, contactId, prefs()); await run();
    const b = (await inv.getMatches(sam, contactId)).matches[0];
    await inv.matchFeedback(sam, contactId, b.boatId, 'dismissed', 'too big');
    const after = (await inv.getMatches(sam, contactId)).matches[0]; expect(after).toMatchObject({ userStatus: 'dismissed', feedbackReason: 'too big', packageable: false });
    await inv.matchFeedback(sam, contactId, b.boatId, 'interested');
    expect((await pool.query(`SELECT count(*)::int n FROM customer_boats WHERE contact_id=$1 AND relation='interested' AND confirmed=false`, [contactId])).rows[0].n).toBe(1);
  });
});

describe('outreach packages (draft only; re-verified at send)', () => {
  async function setup() {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0610', 'Dana');
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'P1', price: 31000, listingUrl: 'https://example.test/p1' })]); await inv.setPreferences(sam, contactId, prefs()); await run();
    const b = (await inv.getMatches(sam, contactId)).matches[0]; const pkg = await outreach.createPackage(sam, contactId, [b.boatId]);
    return { contactId, conversationId, b, pkg };
  }
  const send = (conversationId: string, pkg: { id: string; body: string }, key = 'pkg-send-0001') => queueOutbound({ workspaceId: s.workspaceId, conversationId, body: pkg.body, senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: key, packageId: pkg.id });
  it('builds the draft from verified data only and sends NOTHING by itself', async () => {
    const { pkg } = await setup(); await drain();
    expect(pkg.body).toContain('Hi Dana,'); expect(pkg.body).toContain('2019 Sea Ray SLX 250 — $31,000'); expect(pkg.body).toContain('https://example.test/p1'); expect(pkg.body).toMatch(/confirmed .* and can change/);
    expect(simulatorControl.sent).toHaveLength(0); expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE direction='outbound'`)).rows[0].n).toBe(0);
  });
  it('sends when still accurate, logs outreach, and warns about duplicate outreach next time', async () => {
    const { conversationId, contactId, b, pkg } = await setup();
    expect(await send(conversationId, pkg)).toMatchObject({ ok: true }); await drain(); expect(simulatorControl.sent).toHaveLength(1);
    expect((await send(conversationId, pkg, 'pkg-send-0002'))).toMatchObject({ ok: false, reason: 'package_already_sent' });
    const again = await outreach.createPackage(sam, contactId, [b.boatId]); expect(again.duplicateWarnings).toHaveLength(1);
    expect((await inv.getMatches(sam, contactId)).matches[0].alreadySentAt).toBeTruthy();
  });
  it('REFUSES to send when the price changed, the boat sold, or inventory went stale since drafting', async () => {
    let t = await setup();
    await inv.upsertBoats(owner, 'manual', [boat({ externalId: 'P1', price: 29000, listingUrl: 'https://example.test/p1' })]);
    expect(await send(t.conversationId, t.pkg)).toMatchObject({ ok: false, reason: 'package_price_changed' });
    t = await setup(); await pool.query(`UPDATE inventory_boats SET status='sold'`);
    expect(await send(t.conversationId, t.pkg, 'pkg-send-0003')).toMatchObject({ ok: false, reason: 'package_boat_sold' });
    await pool.query(`UPDATE inventory_boats SET status='available'`); await pool.query(`UPDATE inventory_sources SET last_success_sync_at = now() - interval '3 days'`);
    expect(await send(t.conversationId, t.pkg, 'pkg-send-0004')).toMatchObject({ ok: false, reason: 'package_inventory_stale' });
    expect(simulatorControl.sent).toHaveLength(0);
  });
  it('proactive outreach policy (future): off by default; consent, frequency cap and quiet hours enforced', () => {
    const on = { ...outreach.DEFAULT_PROACTIVE_POLICY, enabled: true, ownerAuthorized: true };
    const ok = { marketingStatus: 'opt_in', smsOptedOut: false, sentLast7Days: 0, localHour: 12 };
    expect(outreach.evaluateProactiveOutreach(outreach.DEFAULT_PROACTIVE_POLICY, ok)).toMatchObject({ allowed: false, reason: 'not_authorized' });
    expect(outreach.evaluateProactiveOutreach(on, ok)).toEqual({ allowed: true });
    expect(outreach.evaluateProactiveOutreach(on, { ...ok, marketingStatus: 'opt_in_not_received' }).reason).toBe('no_marketing_consent');
    expect(outreach.evaluateProactiveOutreach(on, { ...ok, sentLast7Days: 1 }).reason).toBe('frequency_cap');
    expect(outreach.evaluateProactiveOutreach(on, { ...ok, localHour: 22 }).reason).toBe('quiet_hours'); expect(outreach.evaluateProactiveOutreach(on, { ...ok, localHour: 7 }).reason).toBe('quiet_hours');
  });
});

describe('inventory API', () => {
  it('manager imports JSON; staff cannot; invalid rows are rejected with 400', async () => {
    const app = await buildApp();
    const login = async (email: string) => { const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email, password: 'test-password-123' } }); return (r.headers['set-cookie'] as string).split(';')[0]; };
    const call = async (cookie: string, method: string, url: string, payload?: object) => { const r = await app.inject({ method: method as any, url, headers: { cookie, 'x-relay-csrf': '1' }, payload }); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }; };
    const mgr = await login('owner@demo.relay.test'), stf = await login('sam@demo.relay.test');
    expect((await call(stf, 'POST', '/api/inventory/import', { sourceKey: 'csv', boats: [boat()] })).status).toBe(403);
    expect((await call(mgr, 'POST', '/api/inventory/import', { sourceKey: 'csv', boats: [{ externalId: 'x', price: -5 }] })).status).toBe(400);
    expect((await call(mgr, 'POST', '/api/inventory/import', { sourceKey: 'csv', boats: [boat({ externalId: 'ok1' })] })).body).toEqual({ upserted: 1 });
    const list = await call(stf, 'GET', '/api/inventory'); expect(list.body.boats).toHaveLength(1); expect(list.body.sources[0]).toMatchObject({ key: 'csv', fresh: true });
    await app.close();
  });
});
