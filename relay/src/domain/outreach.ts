import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { HttpError, canSeeContact, type Actor } from './authz.js';
import { availabilityOf } from './inventory.js';

/** Build a DRAFT boat package from verified inventory. Nothing is sent: a human reviews it in the composer and sends it. */
export async function createPackage(a: Actor, contactId: string, boatIds: string[]) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  if (!boatIds.length || boatIds.length > 5) throw new HttpError(400, 'choose 1–5 boats');
  const boats = (await pool.query(`SELECT b.*, s.last_success_sync_at, s.stale_after_hours, s.is_source_of_truth FROM inventory_boats b JOIN inventory_sources s ON s.id=b.source_id WHERE b.workspace_id=$1 AND b.id = ANY($2::uuid[])`, [a.workspaceId, boatIds])).rows;
  if (boats.length !== new Set(boatIds).size) throw new HttpError(404, 'boat not found');
  const problems = boats.map((b) => ({ b, av: availabilityOf(b, b) })).filter((x) => x.av !== 'available');
  if (problems.length) throw new HttpError(409, 'some boats cannot be offered as available', { problems: problems.map((p) => ({ boatId: p.b.id, availability: p.av })) });
  const ct = (await pool.query('SELECT first_name FROM contacts WHERE id=$1', [contactId])).rows[0];
  const name = ct.first_name && !/^\+?\d[\d\s()-]*$/.test(ct.first_name) ? ct.first_name : '';
  const checked = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' });
  const lines = boats.map((b, i) => `${i + 1}) ${[b.year, b.make, b.model].filter(Boolean).join(' ')}${b.price != null ? ` — $${Math.round(Number(b.price)).toLocaleString('en-US')}` : ''}${b.length_ft ? `, ${b.length_ft} ft` : ''}${b.listing_url ? `\n${b.listing_url}` : ''}`);
  const body = `${name ? `Hi ${name}, ` : 'Hi, '}here are boats that fit what you told us:\n${lines.join('\n')}\nPrice and availability were confirmed ${checked} (Central) and can change.`;
  const snapshot = Object.fromEntries(boats.map((b) => [b.id, { price: b.price != null ? Number(b.price) : null, status: b.status, updatedAt: b.updated_at }]));
  const mediaIds = [...new Set(boats.flatMap((b) => b.media_ids as string[]))].slice(0, 5);
  const prior = (await pool.query(`SELECT boat_id, max(sent_at) AS at FROM outreach_log WHERE contact_id=$1 AND boat_id = ANY($2::uuid[]) GROUP BY boat_id`, [contactId, boatIds])).rows;
  const r = await pool.query(`INSERT INTO outreach_packages (workspace_id, contact_id, created_by, boat_ids, snapshot, body, media_ids) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [a.workspaceId, contactId, a.userId, boatIds, JSON.stringify(snapshot), body, mediaIds]);
  return { id: r.rows[0].id as string, body, mediaIds, duplicateWarnings: prior.map((p) => ({ boatId: p.boat_id, alreadySentAt: p.at })) };
}

/** Called inside the send transaction. Returns a refusal reason when the draft no longer reflects reality. */
export async function verifyPackageFresh(c: PoolClient, workspaceId: string, packageId: string): Promise<string | null> {
  const p = (await c.query('SELECT * FROM outreach_packages WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [packageId, workspaceId])).rows[0];
  if (!p) return 'package_not_found';
  if (p.status !== 'draft') return 'package_already_sent';
  const boats = (await c.query(`SELECT b.*, s.last_success_sync_at, s.stale_after_hours, s.is_source_of_truth FROM inventory_boats b JOIN inventory_sources s ON s.id=b.source_id WHERE b.id = ANY($1::uuid[])`, [p.boat_ids])).rows;
  if (boats.length !== p.boat_ids.length) return 'package_boat_missing';
  for (const b of boats) {
    const av = availabilityOf(b, b);
    if (av === 'sold') return 'package_boat_sold';
    if (av === 'unverified_stale') return 'package_inventory_stale';
    if (av !== 'available') return 'package_boat_unavailable';
    const snap = p.snapshot[b.id];
    if ((snap?.price ?? null) !== (b.price != null ? Number(b.price) : null)) return 'package_price_changed';
  }
  return null;
}

export async function recordPackageSent(c: PoolClient, packageId: string, messageId: string) {
  const p = (await c.query(`UPDATE outreach_packages SET status='sent', sent_message_id=$2 WHERE id=$1 RETURNING contact_id, boat_ids`, [packageId, messageId])).rows[0];
  for (const bid of p.boat_ids) await c.query('INSERT INTO outreach_log (contact_id, boat_id, message_id) VALUES ($1,$2,$3)', [p.contact_id, bid, messageId]);
}

/**
 * FUTURE automatic outreach policy (not wired to any sender: initial proactive match outreach is draft/approval only).
 * Encodes the guardrails the owner asked for so enabling it later is a configuration change, not a redesign.
 */
export interface ProactivePolicy { enabled: boolean; ownerAuthorized: boolean; maxPerWeek: number; quietStartHour: number; quietEndHour: number }
export const DEFAULT_PROACTIVE_POLICY: ProactivePolicy = { enabled: false, ownerAuthorized: false, maxPerWeek: 1, quietStartHour: 21, quietEndHour: 8 };
export function evaluateProactiveOutreach(p: ProactivePolicy, i: { marketingStatus: string; smsOptedOut: boolean; sentLast7Days: number; localHour: number }): { allowed: boolean; reason?: string } {
  if (!p.enabled || !p.ownerAuthorized) return { allowed: false, reason: 'not_authorized' };
  if (i.smsOptedOut) return { allowed: false, reason: 'sms_opted_out' };
  if (i.marketingStatus !== 'opt_in') return { allowed: false, reason: 'no_marketing_consent' };
  if (i.sentLast7Days >= p.maxPerWeek) return { allowed: false, reason: 'frequency_cap' };
  const quiet = p.quietStartHour > p.quietEndHour ? i.localHour >= p.quietStartHour || i.localHour < p.quietEndHour : i.localHour >= p.quietStartHour && i.localHour < p.quietEndHour;
  if (quiet) return { allowed: false, reason: 'quiet_hours' };
  return { allowed: true };
}
