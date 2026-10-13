import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError, atLeastManager, type Actor } from './authz.js';
import { audit, publish } from './events.js';
import { emitEvent } from './outbound-events.js';
import { createBroadcast } from './broadcasts.js';
import { PermanentAuthError, TransientError, getAdapter, type ExternalReview } from '../integrations/adapter.js';
import { assertWritable, withAuth, registerSyncApplier, type ConnRow } from '../integrations/connections.js';
import { maskSecrets } from '../integrations/crypto.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Hash of the externally-visible state. repliedAt is excluded (timestamps differ between our write and the platform's echo) so our own reply never looks like an outside change. */
const stateHash = (r: { rating: number; authorName?: string | null; body?: string | null; reviewedAt: string; replyText?: string | null }) => sha(JSON.stringify([r.rating, r.authorName ?? '', r.body ?? '', new Date(r.reviewedAt).toISOString(), r.replyText ?? '']));

registerSyncApplier('reviews', async (conn: ConnRow, page) => {
  let created = 0, updated = 0, skipped = 0;
  for (const raw of page.items as ExternalReview[]) {
    const h = stateHash(raw);
    await tx(async (c) => {
      const map = (await c.query(`SELECT local_id, content_hash FROM external_mappings WHERE connection_id=$1 AND entity_type='review' AND external_id=$2 FOR UPDATE`, [conn.id, raw.externalId])).rows[0];
      if (map && map.content_hash === h) { skipped++; return; }                       // unchanged (includes the echo of a reply WE posted): no write, no loop
      const vals = [conn.workspace_id, conn.id, conn.provider, raw.externalId, raw.rating, raw.authorName ?? null, raw.body ?? null, raw.reviewedAt, raw.replyText ?? null, raw.repliedAt ?? null];
      const r = (await c.query(
        `INSERT INTO reviews (workspace_id, connection_id, source, external_id, rating, author_name, body, reviewed_at, reply_text, replied_at, reply_origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $9::text IS NULL THEN NULL ELSE 'external' END)
         ON CONFLICT (workspace_id, source, external_id) DO UPDATE SET rating=EXCLUDED.rating, author_name=EXCLUDED.author_name, body=EXCLUDED.body, reviewed_at=EXCLUDED.reviewed_at, updated_at=now(),
           reply_text=COALESCE(EXCLUDED.reply_text, reviews.reply_text), replied_at=COALESCE(EXCLUDED.replied_at, reviews.replied_at),
           reply_origin=CASE WHEN EXCLUDED.reply_text IS NOT NULL AND EXCLUDED.reply_text IS DISTINCT FROM reviews.reply_text THEN 'external' ELSE reviews.reply_origin END
         RETURNING id, (xmax = 0) AS inserted`, vals)).rows[0];
      await c.query(`INSERT INTO external_mappings (connection_id, entity_type, local_id, external_id, content_hash, last_origin) VALUES ($1,'review',$2,$3,$4,'external') ON CONFLICT (connection_id, entity_type, external_id) DO UPDATE SET content_hash=EXCLUDED.content_hash, last_origin='external', updated_at=now()`, [conn.id, r.id, raw.externalId, h]);
      // A reply whose outcome was UNKNOWN is now confirmed by the platform itself.
      if (raw.replyText) await c.query(`UPDATE review_replies SET status='posted', posted_at=COALESCE(posted_at, now()), error=NULL WHERE review_id=$1 AND status='unknown' AND body=$2`, [r.id, raw.replyText]);
      if (r.inserted) { created++; await publish(c, conn.workspace_id, 'review.created', { reviewId: r.id }); await emitEvent(c, conn.workspace_id, 'review.created', { reviewId: r.id, rating: raw.rating, source: conn.provider }, { author: raw.authorName ?? null, text: raw.body ?? null }); } else updated++;
    });
  }
  if (page.stats) await pool.query(`UPDATE connections SET credentials_meta = credentials_meta || $2::jsonb WHERE id=$1`, [conn.id, JSON.stringify({ sourceStats: { ...page.stats, at: new Date().toISOString() } })]);
  return { created, updated, skipped };
});

// ---------- reading ----------
export async function listReviews(a: Actor, q: { source?: string; rating?: number; replied?: 'yes' | 'no'; search?: string; from?: string; to?: string }) {
  return (await pool.query(
    `SELECT r.id, r.source, r.rating, r.author_name, r.body, r.reviewed_at, r.reply_text, r.replied_at, r.reply_origin, r.imported_manually,
       (SELECT json_build_object('id', x.id, 'status', x.status, 'body', x.body, 'draftMethod', x.draft_method, 'approvedBy', x.approved_by, 'error', x.error) FROM review_replies x WHERE x.review_id=r.id ORDER BY x.created_at DESC LIMIT 1) AS latest_reply
     FROM reviews r WHERE r.workspace_id=$1 AND ($2::text IS NULL OR r.source=$2) AND ($3::int IS NULL OR r.rating=$3) AND ($4::text IS NULL OR ($4='yes' AND r.reply_text IS NOT NULL) OR ($4='no' AND r.reply_text IS NULL))
       AND ($5::text IS NULL OR r.body ILIKE $5 OR r.author_name ILIKE $5) AND ($6::timestamptz IS NULL OR r.reviewed_at >= $6) AND ($7::timestamptz IS NULL OR r.reviewed_at < $7) ORDER BY r.reviewed_at DESC LIMIT 200`,
    [a.workspaceId, q.source ?? null, q.rating ?? null, q.replied ?? null, q.search ? `%${q.search}%` : null, q.from ?? null, q.to ?? null])).rows;
}
export async function reviewSummary(a: Actor) {
  const bySource = (await pool.query(`SELECT source, count(*)::int AS count, round(avg(rating)::numeric, 2)::float AS avg_rating, count(*) FILTER (WHERE reply_text IS NULL)::int AS unreplied, bool_or(imported_manually) AS manual, max(connection_id::text) AS connection_id FROM reviews WHERE workspace_id=$1 GROUP BY source ORDER BY source`, [a.workspaceId])).rows;
  const dist = (await pool.query(`SELECT source, rating, count(*)::int AS n FROM reviews WHERE workspace_id=$1 GROUP BY 1,2`, [a.workspaceId])).rows;
  const metas = (await pool.query(`SELECT id, credentials_meta->'sourceStats' AS s FROM connections WHERE workspace_id=$1`, [a.workspaceId])).rows;
  return bySource.map((s) => ({ ...s, distribution: [1, 2, 3, 4, 5].map((r) => dist.find((d) => d.source === s.source && d.rating === r)?.n ?? 0),
    sourceReported: metas.find((m) => m.id === s.connection_id)?.s ?? null,
    note: s.manual ? 'Manually imported: not verified against the platform.' : 'Computed from reviews synced into Relay. "Source reported" is what the platform says; they can differ until sync completes.' }));
}

// ---------- manual import ----------
const manualSchema = z.array(z.object({ source: z.string().min(1).max(40).default('manual'), externalId: z.string().max(100).optional(), rating: z.number().int().min(1).max(5), authorName: z.string().max(100).nullish(), body: z.string().max(5000).nullish(), reviewedAt: z.string(), replyText: z.string().max(5000).nullish() })).min(1).max(500);
export async function importReviews(a: Actor, rows: unknown) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required'); const items = manualSchema.parse(rows); let created = 0, skipped = 0;
  for (const r of items) { const ext = r.externalId ?? sha([r.source, r.authorName, r.reviewedAt, r.body].join('|')).slice(0, 24); const d = new Date(r.reviewedAt); if (isNaN(d.getTime())) throw new HttpError(400, 'invalid reviewedAt');
    const x = await pool.query(`INSERT INTO reviews (workspace_id, source, external_id, rating, author_name, body, reviewed_at, reply_text, reply_origin, imported_manually) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8::text IS NULL THEN NULL ELSE 'external' END, true) ON CONFLICT (workspace_id, source, external_id) DO NOTHING RETURNING id`, [a.workspaceId, `manual:${r.source}`, ext, r.rating, r.authorName ?? null, r.body ?? null, d, r.replyText ?? null]);
    if (x.rowCount) created++; else skipped++; }
  return { created, skipped };
}

// ---------- reply workflow: draft → approve (bound to exact text) → post (explicit) ----------
export function rulesDraft(rating: number, authorName: string | null, phone?: string): string {
  const first = authorName?.trim().split(/\s+/)[0]; const who = first ? `, ${first}` : '';
  if (rating >= 4) return `Thank you${who}, for taking the time to share your feedback with Sun Sport Marine. We appreciate it.`;
  if (rating === 3) return `Thank you for your feedback${who}. We appreciate you sharing your experience with Sun Sport Marine${phone ? ` — please call us at ${phone} so we can hear more` : ''}.`;
  return `Thank you for letting us know${who}. We're sorry your experience didn't meet expectations${phone ? `; please contact us at ${phone} so we can look into it` : ''}.`;
}
async function reviewFor(a: Actor, id: string) { const r = (await pool.query('SELECT * FROM reviews WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0]; if (!r) throw new HttpError(404, 'review not found'); return r; }
async function replyFor(a: Actor, id: string) { const r = (await pool.query(`SELECT rr.*, rv.workspace_id, rv.connection_id, rv.external_id, rv.source FROM review_replies rr JOIN reviews rv ON rv.id=rr.review_id WHERE rr.id=$1 AND rv.workspace_id=$2`, [id, a.workspaceId])).rows[0]; if (!r) throw new HttpError(404, 'reply not found'); return r; }

export async function draftReply(a: Actor, reviewId: string, body?: string) {
  const rv = await reviewFor(a, reviewId); if (rv.reply_text) throw new HttpError(409, 'this review already has a reply');
  const phone = (await pool.query(`SELECT value FROM workspace_settings WHERE workspace_id=$1 AND key='business_phone'`, [a.workspaceId])).rows[0]?.value;
  const text = body?.trim() || rulesDraft(rv.rating, rv.author_name, phone);
  return tx(async (c) => {
    await c.query(`UPDATE review_replies SET status='rejected', error='superseded by a newer draft' WHERE review_id=$1 AND status IN ('draft','approved')`, [reviewId]);
    const r = (await c.query(`INSERT INTO review_replies (review_id, body, draft_method, drafted_by) VALUES ($1,$2,$3,$4) RETURNING id`, [reviewId, text, body?.trim() ? 'staff' : 'rules-v1 (no AI)', a.userId])).rows[0];
    return { id: r.id as string, body: text, draftMethod: body?.trim() ? 'staff' : 'rules-v1 (no AI)' };
  });
}
export async function editReply(a: Actor, replyId: string, body: string) {
  const r = await replyFor(a, replyId); if (!['draft', 'approved'].includes(r.status)) throw new HttpError(409, `cannot edit a ${r.status} reply`);
  if (!body.trim()) throw new HttpError(400, 'reply is empty');
  await pool.query(`UPDATE review_replies SET body=$2, status='draft', approved_by=NULL, approved_at=NULL, approved_body_hash=NULL WHERE id=$1`, [replyId, body]);   // any edit voids a prior approval
}
export async function approveReply(a: Actor, replyId: string) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to approve public replies'); const r = await replyFor(a, replyId);
  if (r.status !== 'draft') throw new HttpError(409, `cannot approve a ${r.status} reply`);
  await pool.query(`UPDATE review_replies SET status='approved', approved_by=$2, approved_at=now(), approved_body_hash=$3 WHERE id=$1`, [replyId, a.userId, sha(r.body)]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'review.reply.approved', targetType: 'review_reply', targetId: replyId, meta: { bodyHash: sha(r.body) } });
}
/** The ONLY path that publishes anything to a review platform. */
export async function postReply(a: Actor, replyId: string) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to post public replies'); const r = await replyFor(a, replyId);
  if (r.status !== 'approved') throw new HttpError(409, `a reply must be approved before posting (status: ${r.status})`);
  if (r.approved_body_hash !== sha(r.body)) throw new HttpError(409, 'the text changed after approval; approve it again');
  if (!r.connection_id) throw new HttpError(409, 'this review was imported manually: post the reply on the platform, then mark it as replied');
  const conn = (await pool.query('SELECT * FROM connections WHERE id=$1', [r.connection_id])).rows[0] as ConnRow; assertWritable(conn);
  const ad = getAdapter(conn.provider); if (!ad?.postReviewReply) throw new HttpError(409, 'this integration cannot post replies');
  const claim = await pool.query(`UPDATE review_replies SET status='posting' WHERE id=$1 AND status='approved' RETURNING id`, [replyId]);     // exactly one poster
  if (!claim.rowCount) throw new HttpError(409, 'already being posted');
  let creds; const done = async (status: string, error: string | null) => { await pool.query(`UPDATE review_replies SET status=$2, error=$3, posted_at=CASE WHEN $2='posted' THEN now() ELSE posted_at END WHERE id=$1`, [replyId, status, error]); };
  try {
    await withAuth(conn, (cr) => { creds = cr; return ad.postReviewReply!(cr, r.external_id, r.body, replyId); });
    await tx(async (c) => {
      await c.query(`UPDATE review_replies SET status='posted', posted_at=now(), error=NULL WHERE id=$1`, [replyId]);
      await c.query(`UPDATE reviews SET reply_text=$2, replied_at=now(), reply_origin='relay', updated_at=now() WHERE id=$1`, [r.review_id, r.body]);
      const rv = (await c.query('SELECT * FROM reviews WHERE id=$1', [r.review_id])).rows[0];
      await c.query(`UPDATE external_mappings SET content_hash=$3, last_origin='local', updated_at=now() WHERE connection_id=$1 AND entity_type='review' AND local_id=$2`, [conn.id, r.review_id, stateHash({ rating: rv.rating, authorName: rv.author_name, body: rv.body, reviewedAt: rv.reviewed_at.toISOString(), replyText: r.body })]);
      await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'review.reply.posted', targetType: 'review_reply', targetId: replyId, meta: { reviewId: r.review_id, externalId: r.external_id, approvedBy: r.approved_by, bodyHash: sha(r.body), provider: conn.provider } });
    });
    return { status: 'posted' };
  } catch (e) {
    const err = e as Error; const msg = maskSecrets(err.message, creds ?? {});
    if (err instanceof TransientError) { await done('approved', `not sent, safe to retry: ${msg}`); throw new HttpError(503, `not sent (temporary problem); you can retry: ${msg}`); }
    if (err instanceof PermanentAuthError) { await done('failed', `authorization problem: ${msg}`); throw new HttpError(409, 'the connection needs to be re-authorized before replies can be posted'); }
    if (/^ambiguous:/i.test(err.message)) { await done('unknown', msg); await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'review.reply.unknown', targetType: 'review_reply', targetId: replyId, meta: { error: msg } }); return { status: 'unknown', note: 'The platform may or may not have published the reply. Relay will NOT retry automatically; the next sync will confirm it. Check the platform before posting again.' }; }
    await done('failed', msg); await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'review.reply.failed', targetType: 'review_reply', targetId: replyId, meta: { error: msg } }); return { status: 'failed', error: msg };
  }
}
export async function markRepliedManually(a: Actor, reviewId: string, text: string) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required'); const rv = await reviewFor(a, reviewId);
  await pool.query(`UPDATE reviews SET reply_text=$2, replied_at=now(), reply_origin='relay', updated_at=now() WHERE id=$1`, [rv.id, text]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'review.reply.marked_manual', targetType: 'review', targetId: reviewId, meta: { bodyHash: sha(text) } });
}

// ---------- review requests (sentiment-blind) ----------
const requestSchema = z.object({ name: z.string().min(1).max(100), body: z.string().min(1).max(1000), audienceTags: z.array(z.string().min(1).max(40)).min(1).max(10) }).strict();   // strict: no rating/sentiment filters can be smuggled in
export async function createReviewRequest(a: Actor, input: unknown) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required'); const b = requestSchema.parse(input);
  const link = (await pool.query(`SELECT value FROM workspace_settings WHERE workspace_id=$1 AND key='review_link'`, [a.workspaceId])).rows[0]?.value;
  if (!link) throw new HttpError(409, 'Enter your review link in Settings → Business facts first');
  if (!/\{\{\s*review_link\s*\}\}/i.test(b.body)) throw new HttpError(400, 'the message must include {{review_link}} so every customer gets the same public link');
  const id = await createBroadcast(a, { name: b.name, purpose: 'marketing', body: b.body, audience: { tags: b.audienceTags, matchAll: false, contactIds: [] }, batchSize: 10, intervalSeconds: 120 }, 'review_request');
  return { id, policy: 'Everyone in this group who can be texted is asked — there is no way to filter by satisfaction. People asked in the last 90 days are skipped. Replies come back as private feedback.' };
}
