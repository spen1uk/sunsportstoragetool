import { PermanentAuthError, registerAdapter, type Capability, type ProviderAdapter } from '../adapter.js';
import { verify } from '../signing.js';
import { fakePayServer, fakeReviewServer } from './fakeServers.js';

/** SANDBOX adapters: they run the real framework paths (encryption, refresh, sync, signed webhooks) against in-process fakes. They never touch a network. */
const sbx = (id: string, label: string, read: boolean, write: boolean, note?: string): Capability => ({ id, label, read, write, state: 'sandbox-tested', note });

export const demoReviews: ProviderAdapter = {
  key: 'demo_reviews', displayName: 'Demo review platform (sandbox)', category: 'reviews', authType: 'oauth2', sandbox: true,
  capabilities: [sbx('reviews.read', 'Read reviews + source rating', true, false, 'in-process fake server'), sbx('reviews.reply', 'Post a reply to a review', false, true, 'requires write permission and explicit staff approval')],
  syncResources: ['reviews'],
  async validateCredentials(c) { try { fakeReviewServer.list(c.accessToken, null); } catch (e) { if (e instanceof PermanentAuthError) throw e; throw e; } return { accountLabel: 'Demo Marine Reviews', scopes: ['reviews.read', 'reviews.reply'], expiresAt: new Date(fakeReviewServer.tokenExpiresAt).toISOString() }; },
  async refresh(c) { const r = fakeReviewServer.refresh(c.refreshToken); return { ...c, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: new Date(r.expiresAt).toISOString() }; },
  async revoke(c) { void c; },
  async sync({ creds, cursor }) { const r = fakeReviewServer.list(creds.accessToken, cursor); return { items: r.items, nextCursor: r.nextCursor, hasMore: !!r.nextCursor, stats: r.stats }; },
  async postReviewReply(c, id, body, key) { fakeReviewServer.reply(c.accessToken, id, body, key); },
};

export const demoPay: ProviderAdapter = {
  key: 'demo_pay', displayName: 'Demo payments (sandbox)', category: 'payments', authType: 'api_key', sandbox: true,
  capabilities: [sbx('payments.links', 'Create provider-hosted payment links (idempotent)', false, true), sbx('payments.webhooks', 'Signed payment webhooks', true, false, 'timestamped HMAC-SHA256, 5-minute tolerance'), sbx('payments.reconcile', 'Fetch payment state for reconciliation', true, false), sbx('payments.refunds', 'Refunds', false, true)],
  async validateCredentials(c) { if (typeof c.apiKey !== 'string' || !c.apiKey.startsWith('demo_key_')) throw new PermanentAuthError('401 invalid API key'); if (!c.webhookSecret || String(c.webhookSecret).length < 16) throw new Error('webhookSecret (16+ chars) is required'); return { accountLabel: 'Demo Pay account', scopes: ['payments.write', 'payments.read'] }; },
  async createPaymentLink(_c, r) { return fakePayServer.create(r.idempotencyKey, r.amountCents, r.description); },
  async getPaymentSnapshot(_c, ref) { return fakePayServer.snapshot(ref); },
  async refundPayment(_c, ref, cents) { fakePayServer.refund(ref, cents); },
  verifyWebhook(headers, raw, c) { const h = headers['x-demopay-signature']; verify(c.webhookSecret, Array.isArray(h) ? h[0] : h, raw); return (JSON.parse(raw).events ?? []) as never; },
};
export function registerDemoAdapters() { registerAdapter(demoReviews); registerAdapter(demoPay); }
registerDemoAdapters();
