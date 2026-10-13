import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/pool.js';
import { actor, drain, inbound, resetDb, type Seeded } from './helpers.js';
import * as rv from '../src/domain/reviews.js';
import * as cx from '../src/integrations/connections.js';
import * as bc from '../src/domain/broadcasts.js';
import { fakeReviewServer as srv } from '../src/integrations/demo/fakeServers.js';
import { createContact, changeConsent } from '../src/domain/contacts.js';
import { simulatorControl } from '../src/providers/sms.js';

let s: Seeded; let owner: ReturnType<typeof actor>; let sam: ReturnType<typeof actor>; let connId: string;
const rev = (n: number) => Array.from({ length: n }, (_, i) => ({ externalId: `R${i + 1}`, rating: [5, 4, 2, 5, 1][i % 5], authorName: `Reviewer ${i + 1}`, body: `Review text ${i + 1}`, reviewedAt: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(), replyText: null as string | null, repliedAt: null as string | null }));
beforeEach(async () => {
  srv.reset(); s = await resetDb(); owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' };
  srv.reviews = rev(5); connId = await cx.connect(owner, 'demo_reviews', { accessToken: srv.accessToken, refreshToken: srv.refreshToken, expiresAt: new Date(srv.tokenExpiresAt).toISOString() }, { writeEnabled: true }); await drain(); srv.listCalls = 0;
});
afterAll(() => pool.end());
const review = async (ext = 'R3') => (await pool.query(`SELECT * FROM reviews WHERE external_id=$1`, [ext])).rows[0];
const reply = async (id: string) => (await pool.query('SELECT * FROM review_replies WHERE id=$1', [id])).rows[0];

describe('reviews from a connected source', () => {
  it('synced reviews are listed, filterable and summarised; source-reported rating is shown next to the computed one', async () => {
    expect((await rv.listReviews(owner, {})).length).toBe(5); expect((await rv.listReviews(owner, { rating: 5 })).length).toBe(2); expect((await rv.listReviews(owner, { replied: 'no' })).length).toBe(5); expect((await rv.listReviews(owner, { search: 'text 4' })).map((x) => x.external_id ?? x.author_name)).toEqual(['Reviewer 4']);
    const sum = (await rv.reviewSummary(owner))[0]; expect(sum).toMatchObject({ source: 'demo_reviews', count: 5, avg_rating: 3.4, unreplied: 5, distribution: [1, 1, 0, 1, 2] }); expect(sum.sourceReported).toMatchObject({ averageRating: 3.4, totalReviewCount: 5 }); expect(sum.manual).toBeFalsy();
  });
});

describe('replying: draft → approve → post (a human decision, bound to the exact text)', () => {
  it('rule-based drafts are labelled "no AI", assert nothing specific, promise nothing, and only mention a phone number the business entered', async () => {
    const low = await review('R5'); const d1 = await rv.draftReply(sam, low.id); expect(d1.draftMethod).toBe('rules-v1 (no AI)'); expect(d1.body).toMatch(/sorry your experience/); expect(d1.body).not.toMatch(/\d{3}/); expect(d1.body).not.toMatch(/refund|discount|free|guarantee|fix|compensat/i);
    await pool.query(`INSERT INTO workspace_settings VALUES ($1,'business_phone','262-555-0100',NULL)`, [s.workspaceId]); const d2 = await rv.draftReply(sam, low.id); expect(d2.body).toContain('262-555-0100'); expect((await reply(d1.id)).status).toBe('rejected');   // superseded
    expect((await rv.draftReply(sam, (await review('R1')).id)).body).toMatch(/Thank you, Reviewer/);
  });
  it('NOTHING is published without approval: staff cannot approve/post; unapproved, edited-after-approval and manual-import replies are refused; nothing reaches the platform', async () => {
    const r = await review(); const d = await rv.draftReply(sam, r.id, 'Thanks so much for the kind words!');
    await expect(rv.approveReply(sam, d.id)).rejects.toThrow(/manager/); await expect(rv.postReply(owner, d.id)).rejects.toThrow(/must be approved/); await expect(rv.postReply(sam, d.id)).rejects.toThrow(/manager/);
    await rv.approveReply(owner, d.id); await rv.editReply(sam, d.id, 'Edited AFTER approval: thanks!'); expect((await reply(d.id)).status).toBe('draft'); await expect(rv.postReply(owner, d.id)).rejects.toThrow(/must be approved/);   // any edit voids approval
    await pool.query(`UPDATE review_replies SET status='approved', approved_by=$2, approved_body_hash='deadbeef' WHERE id=$1`, [d.id, s.users.owner]); await expect(rv.postReply(owner, d.id)).rejects.toThrow(/approve it again/);   // tampering with the stored body is caught
    expect(srv.replyCalls).toHaveLength(0); expect((await review()).reply_text).toBeNull();
  });
  it('write access is a separate permission: with writes disabled nothing posts even when approved', async () => {
    const r = await review(); const d = await rv.draftReply(owner, r.id, 'Thank you!'); await rv.approveReply(owner, d.id); await cx.setPermissions(owner, connId, { write: false });
    await expect(rv.postReply(owner, d.id)).rejects.toThrow(/write access is not enabled/); expect(srv.replyCalls).toHaveLength(0); expect((await reply(d.id)).status).toBe('approved');
  });
  it('approved + write-enabled: posts exactly once with an idempotency key, audits who approved what, updates the review, and re-posting is refused', async () => {
    const r = await review(); const d = await rv.draftReply(sam, r.id, 'Thank you for choosing Sun Sport Marine!'); await rv.approveReply(owner, d.id);
    expect(await rv.postReply(owner, d.id)).toEqual({ status: 'posted' }); expect(srv.replyCalls).toEqual([{ id: 'R3', body: 'Thank you for choosing Sun Sport Marine!', key: d.id }]);
    expect(await review()).toMatchObject({ reply_text: 'Thank you for choosing Sun Sport Marine!', reply_origin: 'relay' }); expect((await reply(d.id)).status).toBe('posted');
    const au = (await pool.query(`SELECT actor_user_id, meta FROM audit_events WHERE action='review.reply.posted'`)).rows; expect(au).toHaveLength(1); expect(au[0]).toMatchObject({ actor_user_id: s.users.owner }); expect(au[0].meta).toMatchObject({ reviewId: r.id, externalId: 'R3', approvedBy: s.users.owner, provider: 'demo_reviews' }); expect(au[0].meta.bodyHash).toHaveLength(64);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_events WHERE action='review.reply.approved'`)).rows[0].n).toBe(1);
    await expect(rv.postReply(owner, d.id)).rejects.toThrow(/must be approved/); await expect(rv.draftReply(owner, r.id)).rejects.toThrow(/already has a reply/); expect(srv.replyCalls).toHaveLength(1);
  });
  it('concurrent post clicks publish once', async () => {
    const r = await review(); const d = await rv.draftReply(owner, r.id, 'Thanks!'); await rv.approveReply(owner, d.id);
    const out = await Promise.allSettled([rv.postReply(owner, d.id), rv.postReply(owner, d.id)]); expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect(srv.replyCalls).toHaveLength(1);
  });
  it('AMBIGUOUS outcome → "unknown": never retried automatically; the next sync confirms it', async () => {
    const r = await review(); const d = await rv.draftReply(owner, r.id, 'Appreciate it!'); await rv.approveReply(owner, d.id); srv.replyMode = 'ambiguous';
    const out = await rv.postReply(owner, d.id); expect(out.status).toBe('unknown'); expect((await reply(d.id)).status).toBe('unknown'); await expect(rv.postReply(owner, d.id)).rejects.toThrow(/must be approved/); expect(srv.replyCalls).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int n FROM audit_events WHERE action='review.reply.unknown'`)).rows[0].n).toBe(1);
    await cx.runSync(connId, 'reviews'); expect((await reply(d.id)).status).toBe('posted'); expect((await review()).reply_text).toBe('Appreciate it!');            // platform shows it → confirmed
  });
  it('rejection is surfaced with the platform\'s reason; a not-sent (transient) failure is safe to retry; revoked authorization needs re-auth', async () => {
    const r = await review(); const d = await rv.draftReply(owner, r.id, 'Reply text'); await rv.approveReply(owner, d.id); srv.replyMode = 'reject';
    expect(await rv.postReply(owner, d.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('content policy') }); expect((await review()).reply_text).toBeNull();
    const d2 = await rv.draftReply(owner, r.id, 'Reply text 2'); await rv.approveReply(owner, d2.id); srv.replyMode = 'transient'; await expect(rv.postReply(owner, d2.id)).rejects.toThrow(/not sent/); expect((await reply(d2.id)).status).toBe('approved');
    srv.replyMode = 'ok'; expect((await rv.postReply(owner, d2.id)).status).toBe('posted');
    const r4 = await review('R4'); const d3 = await rv.draftReply(owner, r4.id, 'Another'); await rv.approveReply(owner, d3.id); srv.revoked = true; await expect(rv.postReply(owner, d3.id)).rejects.toThrow(/re-authorized/); expect((await pool.query('SELECT status FROM connections')).rows[0].status).toBe('needs_reauth');
  });
  it('FEEDBACK LOOP: our own reply echoing back on the next sync is not treated as an external change', async () => {
    const r = await review(); const d = await rv.draftReply(owner, r.id, 'Thank you!'); await rv.approveReply(owner, d.id); await rv.postReply(owner, d.id);
    const res = await cx.runSync(connId, 'reviews'); expect(res).toMatchObject({ status: 'ok', created: 0, updated: 0, skipped: 5 }); expect((await review()).reply_origin).toBe('relay');
    srv.reviews[2].replyText = 'Edited on the platform by someone else'; expect(await cx.runSync(connId, 'reviews')).toMatchObject({ updated: 1 }); expect((await review()).reply_origin).toBe('external');   // a genuine outside change IS applied
  });
  it('the ONLY code that publishes to a review platform is postReply (static guard)', () => {
    const hits: string[] = []; const walk = (dir: string) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.ts') && /postReviewReply[?!]?\(/.test(readFileSync(p, 'utf8'))) hits.push(path.relative('src', p)); } }; walk('src');
    expect(hits.sort()).toEqual(['domain/reviews.ts', 'integrations/adapter.ts', 'integrations/demo/adapters.ts']);
  });
});

describe('manually imported reviews (e.g. exported from a platform without API access)', () => {
  it('are clearly labelled, deduplicated, never claim platform verification, and replies are done on the platform then marked here', async () => {
    const rows = [{ source: 'google', rating: 5, authorName: 'A. Boater', body: 'Great experience', reviewedAt: '2026-05-01T12:00:00Z' }, { source: 'google', rating: 2, authorName: 'B. Skipper', body: 'Slow service', reviewedAt: '2026-05-03T12:00:00Z' }];
    await expect(rv.importReviews(sam, rows)).rejects.toThrow(/manager/); expect(await rv.importReviews(owner, rows)).toEqual({ created: 2, skipped: 0 }); expect(await rv.importReviews(owner, rows)).toEqual({ created: 0, skipped: 2 });
    await expect(rv.importReviews(owner, [{ rating: 6, reviewedAt: '2026-05-01' }])).rejects.toThrow(); await expect(rv.importReviews(owner, [{ rating: 5, reviewedAt: 'not a date' }])).rejects.toThrow(/invalid reviewedAt/);
    const m = (await rv.reviewSummary(owner)).find((x) => x.source === 'manual:google')!; expect(m).toMatchObject({ count: 2, manual: true }); expect(m.note).toMatch(/not verified/); expect(m.sourceReported).toBeNull();
    const rid = (await pool.query(`SELECT id FROM reviews WHERE source='manual:google' AND rating=2`)).rows[0].id; const d = await rv.draftReply(owner, rid); await rv.approveReply(owner, d.id);
    await expect(rv.postReply(owner, d.id)).rejects.toThrow(/imported manually/); await rv.markRepliedManually(owner, rid, 'Replied on Google by Fran'); expect((await pool.query('SELECT reply_text FROM reviews WHERE id=$1', [rid])).rows[0].reply_text).toBe('Replied on Google by Fran'); expect(srv.replyCalls).toHaveLength(0);
  });
});

describe('review requests are sentiment-blind', () => {
  const setup = async () => { await pool.query(`INSERT INTO workspace_settings VALUES ($1,'review_link','https://g.page/r/sun-sport-marine',NULL)`, [s.workspaceId]); await pool.query(`INSERT INTO automation_settings (workspace_id, quiet_start_hour, quiet_end_hour) VALUES ($1,0,0) ON CONFLICT (workspace_id) DO UPDATE SET quiet_start_hour=0, quiet_end_hour=0`, [s.workspaceId]); };
  const customer = async (first: string, phone: string, o: { optIn?: boolean; stop?: boolean } = {}) => { const id = await createContact(owner, { firstName: first, phone, tags: ['purchased'] }); if (o.optIn !== false) await changeConsent(owner, id, 'marketing_opt_in', 'form'); if (o.stop) await changeConsent(owner, id, 'sms_stop', 'STOP'); return id; };
  const body = 'Hi {{first_name}}, thanks for choosing Sun Sport Marine! Would you share your experience? {{review_link}} Or just reply here with private feedback.';
  it('needs the business\'s own review link; the message must carry {{review_link}}; the schema is strict so no rating/sentiment filter can be supplied', async () => {
    await expect(rv.createReviewRequest(owner, { name: 'n', body, audienceTags: ['purchased'] })).rejects.toThrow(/review link/); await setup();
    await expect(rv.createReviewRequest(owner, { name: 'n', body: 'Please review us!', audienceTags: ['purchased'] })).rejects.toThrow(/review_link/);
    for (const extra of [{ minRating: 4 }, { sentiment: 'positive' }, { onlyHappy: true }, { contactIds: ['x'] }]) await expect(rv.createReviewRequest(owner, { name: 'n', body, audienceTags: ['purchased'], ...extra })).rejects.toThrow();
    await expect(rv.createReviewRequest(sam, { name: 'n', body, audienceTags: ['purchased'] })).rejects.toThrow(/manager/);
  });
  it('everyone who can be texted is asked — exclusions are ONLY consent/contactability or "asked in the last 90 days"; replies are tagged private feedback', async () => {
    await setup(); await customer('Ann', '(414) 201-1401'); await customer('Bob', '(414) 201-1402'); await customer('Cy', '(414) 201-1403', { stop: true }); await customer('Di', '(414) 201-1404', { optIn: false });
    const r = await rv.createReviewRequest(owner, { name: 'Post-purchase review ask', body, audienceTags: ['purchased'] }); expect(r.policy).toMatch(/no way to filter by satisfaction/);
    const pv = await bc.previewBroadcast(owner, r.id); expect(pv.eligibleCount).toBe(2); expect(pv.excludedByReason).toEqual({ sms_opted_out: 1, no_marketing_consent: 1 });
    expect(pv.samples[0].text).toContain('https://g.page/r/sun-sport-marine');
    await bc.approveBroadcast(owner, r.id, { sendNow: true }); await drain(); expect(simulatorControl.sent.filter((x) => x.body.includes('g.page'))).toHaveLength(2);
    // asked again within 90 days → skipped
    const r2 = await rv.createReviewRequest(owner, { name: 'Again', body, audienceTags: ['purchased'] }); const pv2 = await bc.previewBroadcast(owner, r2.id); expect(pv2.eligibleCount).toBe(0); expect(pv2.excludedByReason.recently_asked).toBe(2);
    // a reply is PRIVATE FEEDBACK: tagged for staff, never auto-published or filtered
    await inbound('+14142011401', 'The service was slow, honestly.'); const c = (await pool.query(`SELECT tags FROM conversations cv JOIN contact_identities ci ON ci.contact_id=cv.contact_id WHERE ci.normalized='+14142011401'`)).rows[0]; expect(c.tags).toContain('review-feedback');
    expect((await pool.query(`SELECT count(*)::int n FROM reviews`)).rows[0].n).toBe(5);        // untouched: feedback never becomes a public review
  });
});
