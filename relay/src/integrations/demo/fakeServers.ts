import { PermanentAuthError, TransientError, type ExternalReview, type NormalizedPaymentEvent, type PaymentSnapshot } from '../adapter.js';
import { sign } from '../signing.js';

/** In-process stand-in for a review platform with OAuth. DEMO/SANDBOX ONLY — controllable failure modes let us test token refresh, revocation, paging and ambiguous writes. */
export class FakeReviewServer {
  reviews: ExternalReview[] = []; pageSize = 2; accessToken = 'at_1'; refreshToken = 'rt_1'; tokenExpiresAt = Date.now() + 3600_000; revoked = false;
  refreshMode: 'ok' | 'transient' | 'invalid_grant' = 'ok'; replyMode: 'ok' | 'ambiguous' | 'reject' | 'transient' = 'ok'; failListOnCall = 0; listCalls = 0; refreshCalls = 0; replyCalls: { id: string; body: string; key: string }[] = []; seq = 1;
  reset() { Object.assign(this, new FakeReviewServer()); }
  private auth(token: string) { if (this.revoked) throw new PermanentAuthError('401 token revoked'); if (token !== this.accessToken || Date.now() >= this.tokenExpiresAt) throw new PermanentAuthError('401 invalid or expired access token'); }
  list(token: string, cursor: string | null) {
    this.auth(token); this.listCalls++; if (this.failListOnCall && this.listCalls === this.failListOnCall) throw new TransientError('503 service unavailable'); const off = cursor ? Number(cursor) : 0; const items = this.reviews.slice(off, off + this.pageSize); const next = off + this.pageSize;
    return { items, nextCursor: next < this.reviews.length ? String(next) : null, stats: { averageRating: this.reviews.length ? Math.round((this.reviews.reduce((n, r) => n + r.rating, 0) / this.reviews.length) * 100) / 100 : null, totalReviewCount: this.reviews.length } };
  }
  refresh(rt: string) {
    this.refreshCalls++; if (this.refreshMode === 'transient') throw new TransientError('503 token endpoint unavailable', 30);
    if (this.refreshMode === 'invalid_grant' || this.revoked || rt !== this.refreshToken) throw new PermanentAuthError('invalid_grant');
    this.seq++; this.accessToken = `at_${this.seq}`; this.tokenExpiresAt = Date.now() + 3600_000; return { accessToken: this.accessToken, refreshToken: this.refreshToken, expiresAt: this.tokenExpiresAt };
  }
  reply(token: string, id: string, body: string, key: string) {
    this.auth(token); this.replyCalls.push({ id, body, key });
    if (this.replyMode === 'transient') throw new TransientError('connection refused before sending');
    if (this.replyMode === 'reject') throw new Error('rejected: reply violates content policy');
    const r = this.reviews.find((x) => x.externalId === id); if (!r) throw new Error('rejected: no such review');
    r.replyText = body; r.repliedAt = new Date().toISOString();
    if (this.replyMode === 'ambiguous') throw new Error('ambiguous: connection reset after sending the request');     // the reply WAS applied, but the client can't know
  }
  expireToken() { this.tokenExpiresAt = Date.now() - 1000; }
}
export const fakeReviewServer = new FakeReviewServer();

/** In-process payment provider with idempotent link creation, status, refunds and SIGNED webhooks. DEMO/SANDBOX ONLY. */
export class FakePayServer {
  sessions = new Map<string, { ref: string; amountCents: number; description: string; paid: number; refunded: number; status: string; key: string }>(); byKey = new Map<string, string>(); n = 0; createCalls = 0; failCreate: 'none' | 'not_sent' | 'ambiguous_once' = 'none'; ambiguousUsed = false; evSeq = 0;
  reset() { Object.assign(this, new FakePayServer()); }
  create(key: string, amountCents: number, description: string) {
    this.createCalls++; if (this.failCreate === 'not_sent') throw new TransientError('connection refused');
    const existing = this.byKey.get(key); if (existing) { const s = this.sessions.get(existing)!; return { providerRef: s.ref, url: `https://pay.demo.invalid/${s.ref}` }; }   // idempotent
    const ref = `ds_${++this.n}`; this.sessions.set(ref, { ref, amountCents, description, paid: 0, refunded: 0, status: 'open', key }); this.byKey.set(key, ref);
    if (this.failCreate === 'ambiguous_once' && !this.ambiguousUsed) { this.ambiguousUsed = true; throw new Error('ambiguous: timeout after the request was sent'); }
    return { providerRef: ref, url: `https://pay.demo.invalid/${ref}` };
  }
  /** Simulate the customer paying (or a refund) at the provider, returning the events the provider would emit. */
  pay(ref: string, cents?: number): NormalizedPaymentEvent { const s = this.sessions.get(ref)!; const amt = cents ?? s.amountCents - s.paid; s.paid += amt; s.status = s.paid >= s.amountCents ? 'paid' : 'partially_paid'; return { providerEventId: `evt_${++this.evSeq}`, providerRef: ref, type: 'succeeded', amountCents: amt, receiptUrl: `https://pay.demo.invalid/receipt/${ref}`, occurredAt: new Date().toISOString() }; }
  refund(ref: string, cents: number): NormalizedPaymentEvent { const s = this.sessions.get(ref)!; s.refunded += cents; return { providerEventId: `evt_${++this.evSeq}`, providerRef: ref, type: 'refunded', amountCents: cents, occurredAt: new Date().toISOString() }; }
  snapshot(ref: string): PaymentSnapshot | null { const x = this.sessions.get(ref); if (!x) return null; return { paidCents: x.paid, refundedCents: x.refunded, state: x.status === 'expired' ? 'expired' : x.paid >= x.amountCents ? 'paid' : x.paid > 0 ? 'partially_paid' : 'open', receiptUrl: x.paid ? `https://pay.demo.invalid/receipt/${ref}` : undefined }; }
  /** A signed webhook body+header as the provider would deliver it. */
  webhook(secret: string, events: NormalizedPaymentEvent[], now = Date.now()) { const raw = JSON.stringify({ events }); return { raw, headers: { 'x-demopay-signature': sign(secret, Math.floor(now / 1000), raw) } }; }
}
export const fakePayServer = new FakePayServer();
