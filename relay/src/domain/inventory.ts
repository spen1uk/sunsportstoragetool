import { z } from 'zod';
import { pool, tx, type Db } from '../db/pool.js';
import { HttpError, atLeastManager, canSeeContact, type Actor } from './authz.js';
import { enqueue } from './queue.js';
import { publish } from './events.js';

export const boatSchema = z.object({
  externalId: z.string().min(1).max(100),
  status: z.enum(['available', 'pending', 'hold', 'sold', 'unknown']).default('unknown'),
  year: z.number().int().min(1950).max(2100).nullish(), make: z.string().max(60).nullish(), model: z.string().max(80).nullish(), boatType: z.string().max(40).nullish(),
  lengthFt: z.number().positive().max(200).nullish(), price: z.number().nonnegative().max(1e8).nullish(),
  engine: z.string().max(120).nullish(), capacity: z.number().int().positive().max(100).nullish(), engineHours: z.number().int().nonnegative().nullish(),
  features: z.array(z.string().max(60)).max(40).default([]), listingUrl: z.string().url().max(500).nullish(), mediaIds: z.array(z.string().uuid()).max(10).default([]),
});
export type BoatInput = z.infer<typeof boatSchema>;

export async function ensureSource(db: Db, workspaceId: string, key: string, kind: 'manual' | 'import' | 'connector' = 'manual', name?: string) {
  const r = await db.query(`INSERT INTO inventory_sources (workspace_id, key, name, kind) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id, key) DO UPDATE SET key=EXCLUDED.key RETURNING *`, [workspaceId, key, name ?? key, kind]);
  return r.rows[0];
}

const isFresh = (src: { last_success_sync_at: Date | null; stale_after_hours: number }) => !!src.last_success_sync_at && Date.now() - new Date(src.last_success_sync_at).getTime() < src.stale_after_hours * 3600_000;

export async function upsertBoats(a: Actor, sourceKey: string, boats: BoatInput[], opts: { fullSync?: boolean; kind?: 'manual' | 'import' } = {}) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to change inventory');
  const parsed = boats.map((b) => boatSchema.parse(b));
  const touched: string[] = [];
  await tx(async (c) => {
    const src = await ensureSource(c, a.workspaceId, sourceKey, opts.kind ?? 'manual');
    for (const b of parsed) {
      const r = await c.query(
        `INSERT INTO inventory_boats (workspace_id, source_id, external_id, status, year, make, model, boat_type, length_ft, price, engine, capacity, engine_hours, features, listing_url, media_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (source_id, external_id) DO UPDATE SET status=EXCLUDED.status, year=EXCLUDED.year, make=EXCLUDED.make, model=EXCLUDED.model, boat_type=EXCLUDED.boat_type, length_ft=EXCLUDED.length_ft, price=EXCLUDED.price,
           engine=EXCLUDED.engine, capacity=EXCLUDED.capacity, engine_hours=EXCLUDED.engine_hours, features=EXCLUDED.features, listing_url=EXCLUDED.listing_url, media_ids=EXCLUDED.media_ids, updated_at=now()
         RETURNING id`,
        [a.workspaceId, src.id, b.externalId, b.status, b.year ?? null, b.make ?? null, b.model ?? null, b.boatType ?? null, b.lengthFt ?? null, b.price ?? null, b.engine ?? null, b.capacity ?? null, b.engineHours ?? null, b.features, b.listingUrl ?? null, b.mediaIds]);
      touched.push(r.rows[0].id);
    }
    // A full sync that no longer lists a boat does NOT prove it sold; it becomes 'unknown' (excluded from confident matches).
    if (opts.fullSync) await c.query(`UPDATE inventory_boats SET status='unknown', updated_at=now() WHERE source_id=$1 AND external_id <> ALL($2::text[]) AND status<>'sold'`, [src.id, parsed.map((b) => b.externalId)]);
    await c.query('UPDATE inventory_sources SET last_success_sync_at=now(), last_error=NULL WHERE id=$1', [src.id]);
    await enqueue(c, 'recompute_matches', { all: true }, { workspaceId: a.workspaceId, dedupeKey: `all:${a.workspaceId}` });
    await publish(c, a.workspaceId, 'inventory.updated', {});
  });
  return { upserted: touched.length };
}

export async function confirmSourceCurrent(a: Actor, sourceKey: string) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required');
  const r = await pool.query('UPDATE inventory_sources SET last_success_sync_at=now() WHERE workspace_id=$1 AND key=$2 RETURNING id', [a.workspaceId, sourceKey]);
  if (!r.rowCount) throw new HttpError(404, 'source not found');
  await enqueue(pool, 'recompute_matches', { all: true }, { workspaceId: a.workspaceId, dedupeKey: `all:${a.workspaceId}` });
}

export async function listInventory(a: Actor) {
  const rows = (await pool.query(`SELECT b.*, s.key AS source_key, s.name AS source_name, s.kind AS source_kind, s.is_source_of_truth, s.last_success_sync_at, s.stale_after_hours FROM inventory_boats b JOIN inventory_sources s ON s.id=b.source_id WHERE b.workspace_id=$1 ORDER BY b.updated_at DESC LIMIT 500`, [a.workspaceId])).rows;
  const sources = (await pool.query('SELECT key, name, kind, is_source_of_truth, last_success_sync_at, stale_after_hours, last_error FROM inventory_sources WHERE workspace_id=$1', [a.workspaceId])).rows.map((s) => ({ ...s, fresh: isFresh(s) }));
  return { sources, boats: rows.map((b) => ({ ...b, availability: availabilityOf(b, b) })) };
}

/** What we may honestly say about a boat right now. */
export function availabilityOf(b: { status: string }, src: { last_success_sync_at: Date | null; stale_after_hours: number; is_source_of_truth?: boolean }): 'available' | 'unverified_stale' | 'pending' | 'sold' | 'unknown' {
  if (b.status === 'sold') return 'sold';
  if (b.status === 'pending' || b.status === 'hold') return 'pending';
  if (b.status !== 'available') return 'unknown';
  return isFresh(src) && src.is_source_of_truth !== false ? 'available' : 'unverified_stale';
}

// ---------- preferences ----------
const prefSchema = z.object({
  budgetMin: z.number().nonnegative().nullish(), budgetMax: z.number().nonnegative().nullish(), boatTypes: z.array(z.string().max(40)).max(10).default([]),
  lengthMin: z.number().positive().nullish(), lengthMax: z.number().positive().nullish(), features: z.array(z.string().max(60)).max(30).default([]),
  useCase: z.string().max(300).nullish(), tradeNotes: z.string().max(500).nullish(), provenance: z.enum(['customer_stated', 'staff_entered']).default('staff_entered'), confirmed: z.boolean().default(false),
});
export async function getPreferences(a: Actor, contactId: string) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  return (await pool.query('SELECT * FROM contact_preferences WHERE contact_id=$1', [contactId])).rows[0] ?? null;
}
export async function setPreferences(a: Actor, contactId: string, input: unknown) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  const p = prefSchema.parse(input);
  if (p.budgetMin != null && p.budgetMax != null && p.budgetMin > p.budgetMax) throw new HttpError(400, 'budget minimum exceeds maximum');
  if (p.lengthMin != null && p.lengthMax != null && p.lengthMin > p.lengthMax) throw new HttpError(400, 'length minimum exceeds maximum');
  await tx(async (c) => {
    await c.query(
      `INSERT INTO contact_preferences (contact_id, workspace_id, budget_min, budget_max, boat_types, length_min, length_max, features, use_case, trade_notes, provenance, confirmed, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (contact_id) DO UPDATE SET budget_min=EXCLUDED.budget_min, budget_max=EXCLUDED.budget_max, boat_types=EXCLUDED.boat_types, length_min=EXCLUDED.length_min, length_max=EXCLUDED.length_max, features=EXCLUDED.features,
         use_case=EXCLUDED.use_case, trade_notes=EXCLUDED.trade_notes, provenance=EXCLUDED.provenance, confirmed=EXCLUDED.confirmed, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [contactId, a.workspaceId, p.budgetMin ?? null, p.budgetMax ?? null, p.boatTypes, p.lengthMin ?? null, p.lengthMax ?? null, p.features, p.useCase ?? null, p.tradeNotes ?? null, p.provenance, p.confirmed, a.userId]);
    await enqueue(c, 'recompute_matches', { contactId }, { workspaceId: a.workspaceId, dedupeKey: `c:${contactId}` });
  });
}

// ---------- matching ----------
export type Result = 'match' | 'partial' | 'missing_data' | 'disqualified';
export interface Reason { criterion: string; result: Result; detail: string; points: number; possible: number }
export interface Prefs { budget_min: number | null; budget_max: number | null; boat_types: string[]; length_min: number | null; length_max: number | null; features: string[] }
export interface BoatRow { year: number | null; make: string | null; model: string | null; boat_type: string | null; length_ft: number | null; price: number | null; features: string[] }
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** Explainable scoring. Missing data never counts as a match and never disqualifies; it lowers confidence and is listed. */
export function scoreBoat(p: Prefs, b: BoatRow): { verdict: 'match' | 'excluded'; score: number; reasons: Reason[]; hasCriteria: boolean } {
  const reasons: Reason[] = [];
  const price = num(b.price), len = num(b.length_ft);
  const bmax = num(p.budget_max), lmin = num(p.length_min), lmax = num(p.length_max);
  if (bmax !== null) {
    if (price === null) reasons.push({ criterion: 'budget', result: 'missing_data', detail: 'No price on file for this boat', points: 0, possible: 35 });
    else if (price <= bmax) reasons.push({ criterion: 'budget', result: 'match', detail: `${usd(price)} is within the ${usd(bmax)} budget`, points: 35, possible: 35 });
    else reasons.push({ criterion: 'budget', result: 'disqualified', detail: `${usd(price)} is ${usd(price - bmax)} over the ${usd(bmax)} budget`, points: 0, possible: 35 });
  }
  if (p.boat_types.length) {
    if (!b.boat_type) reasons.push({ criterion: 'type', result: 'missing_data', detail: 'Boat type not recorded', points: 0, possible: 25 });
    else if (p.boat_types.some((t) => t.toLowerCase() === b.boat_type!.toLowerCase())) reasons.push({ criterion: 'type', result: 'match', detail: `${b.boat_type} is a wanted type`, points: 25, possible: 25 });
    else reasons.push({ criterion: 'type', result: 'disqualified', detail: `${b.boat_type} is not among wanted types (${p.boat_types.join(', ')})`, points: 0, possible: 25 });
  }
  if (lmin !== null || lmax !== null) {
    if (len === null) reasons.push({ criterion: 'length', result: 'missing_data', detail: 'Length not recorded', points: 0, possible: 20 });
    else {
      const lo = lmin ?? 0, hi = lmax ?? Infinity;
      if (len >= lo && len <= hi) reasons.push({ criterion: 'length', result: 'match', detail: `${len} ft fits the wanted range`, points: 20, possible: 20 });
      else {
        const off = len < lo ? (lo - len) / lo : (len - hi) / hi;
        if (off <= 0.05) reasons.push({ criterion: 'length', result: 'partial', detail: `${len} ft is just outside the wanted range (within 5%)`, points: 10, possible: 20 });
        else reasons.push({ criterion: 'length', result: 'disqualified', detail: `${len} ft is outside the wanted ${lmin ?? '…'}–${lmax ?? '…'} ft range`, points: 0, possible: 20 });
      }
    }
  }
  if (p.features.length) {
    if (!b.features.length) reasons.push({ criterion: 'features', result: 'missing_data', detail: 'No feature list on file, so wanted features cannot be confirmed', points: 0, possible: 20 });
    else {
      const have = p.features.filter((f) => b.features.some((x) => x.toLowerCase().includes(f.toLowerCase())));
      const missing = p.features.filter((f) => !have.includes(f));
      const pts = Math.round(20 * have.length / p.features.length);
      reasons.push({ criterion: 'features', result: missing.length === 0 ? 'match' : have.length ? 'partial' : 'partial', detail: missing.length === 0 ? `Has all wanted features (${have.join(', ')})` : `Has ${have.join(', ') || 'none'}; not listed: ${missing.join(', ')}`, points: pts, possible: 20 });
    }
  }
  const hasCriteria = reasons.length > 0;
  const dq = reasons.some((r) => r.result === 'disqualified');
  const known = reasons.filter((r) => r.result !== 'missing_data');
  const possible = known.reduce((s, r) => s + r.possible, 0);
  const earned = known.reduce((s, r) => s + r.points, 0);
  const missingCount = reasons.filter((r) => r.result === 'missing_data').length;
  const score = dq || !hasCriteria ? 0 : Math.max(0, Math.round((possible ? (earned / possible) * 100 : 50) - 8 * missingCount));
  return { verdict: dq || !hasCriteria ? 'excluded' : 'match', score, reasons, hasCriteria };
}

export async function recomputeForContact(contactId: string) {
  const p = (await pool.query('SELECT * FROM contact_preferences WHERE contact_id=$1', [contactId])).rows[0];
  const ws = p?.workspace_id ?? (await pool.query('SELECT workspace_id FROM contacts WHERE id=$1', [contactId])).rows[0]?.workspace_id;
  if (!ws) return;
  if (!p) { await pool.query('DELETE FROM match_results WHERE contact_id=$1', [contactId]); return; }
  const boats = (await pool.query('SELECT * FROM inventory_boats WHERE workspace_id=$1', [ws])).rows;
  await tx(async (c) => {
    for (const b of boats) {
      const r = scoreBoat(p, b);
      const explanation = { reasons: r.reasons, hasCriteria: r.hasCriteria, missingData: r.reasons.filter((x) => x.result === 'missing_data').map((x) => x.criterion), disqualifiedBy: r.reasons.filter((x) => x.result === 'disqualified').map((x) => x.criterion) };
      await c.query(
        `INSERT INTO match_results (contact_id, boat_id, workspace_id, verdict, score, explanation) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (contact_id, boat_id) DO UPDATE SET verdict=EXCLUDED.verdict, score=EXCLUDED.score, explanation=EXCLUDED.explanation, computed_at=now()`, [contactId, b.id, ws, r.verdict, r.score, JSON.stringify(explanation)]);
    }
    await c.query('DELETE FROM match_results WHERE contact_id=$1 AND boat_id <> ALL($2::uuid[])', [contactId, boats.map((b) => b.id)]);
  });
}
export async function recomputeAll(workspaceId: string) {
  for (const r of (await pool.query('SELECT contact_id FROM contact_preferences WHERE workspace_id=$1', [workspaceId])).rows) await recomputeForContact(r.contact_id);
}

export async function getMatches(a: Actor, contactId: string, opts: { includeExcluded?: boolean } = {}) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  const prefs = (await pool.query('SELECT * FROM contact_preferences WHERE contact_id=$1', [contactId])).rows[0] ?? null;
  const rows = (await pool.query(
    `SELECT m.*, b.status, b.year, b.make, b.model, b.boat_type, b.length_ft, b.price, b.engine, b.features, b.listing_url, b.media_ids, b.updated_at AS boat_updated_at, s.key AS source_key, s.last_success_sync_at, s.stale_after_hours, s.is_source_of_truth,
       (SELECT max(sent_at) FROM outreach_log o WHERE o.contact_id=m.contact_id AND o.boat_id=m.boat_id) AS last_outreach_at
     FROM match_results m JOIN inventory_boats b ON b.id=m.boat_id JOIN inventory_sources s ON s.id=b.source_id WHERE m.contact_id=$1`, [contactId])).rows;
  const shape = (r: any) => ({ boatId: r.boat_id, title: [r.year, r.make, r.model].filter(Boolean).join(' ') || 'Boat', price: num(r.price), lengthFt: num(r.length_ft), boatType: r.boat_type, listingUrl: r.listing_url,
    score: r.score, verdict: r.verdict, availability: availabilityOf(r, r), explanation: r.explanation, userStatus: r.user_status, feedbackReason: r.feedback_reason, alreadySentAt: r.last_outreach_at, sourceKey: r.source_key,
    sourceFresh: isFresh(r), packageable: r.verdict === 'match' && availabilityOf(r, r) === 'available' && r.user_status !== 'dismissed' });
  const all = rows.map(shape);
  // Sold boats and boats with unknown availability are never recommended; they appear only in the excluded list with the reason.
  const matches = all.filter((m) => m.verdict === 'match' && m.availability !== 'sold' && m.availability !== 'unknown').sort((x, y) => y.score - x.score || (x.price ?? 1e12) - (y.price ?? 1e12));
  const excluded = all.filter((m) => m.verdict === 'excluded' || m.availability === 'sold' || m.availability === 'unknown').map((m) => ({ ...m, excludedBecause: m.availability === 'sold' ? ['sold'] : m.availability === 'unknown' ? ['availability_unknown'] : m.explanation.hasCriteria ? m.explanation.disqualifiedBy : ['no_explicit_preferences'] }));
  return { preferences: prefs, hasPreferences: !!prefs, matches, excluded: opts.includeExcluded ? excluded : undefined, excludedCount: excluded.length };
}

export async function matchFeedback(a: Actor, contactId: string, boatId: string, status: 'suggested' | 'dismissed' | 'interested', reason?: string) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  const r = await pool.query('UPDATE match_results SET user_status=$3, feedback_reason=$4 WHERE contact_id=$1 AND boat_id=$2 RETURNING boat_id', [contactId, boatId, status, reason ?? null]);
  if (!r.rowCount) throw new HttpError(404, 'match not found');
  if (status === 'interested') await pool.query(`INSERT INTO customer_boats (workspace_id, contact_id, relation, year, make, model, provenance, confirmed) SELECT $1,$2,'interested',year,make,model,'staff_entered',false FROM inventory_boats WHERE id=$3 AND NOT EXISTS (SELECT 1 FROM customer_boats cb WHERE cb.contact_id=$2 AND cb.relation='interested' AND cb.model IS NOT DISTINCT FROM (SELECT model FROM inventory_boats WHERE id=$3))`, [a.workspaceId, contactId, boatId]);
}
