export type EvidenceState = 'verified-docs' | 'sandbox-tested' | 'production-tested' | 'unsupported' | 'pending-investigation';
export interface Capability { id: string; label: string; read: boolean; write: boolean; state: EvidenceState; scopes?: string[]; note?: string }
export type Credentials = Record<string, any>;

/** Credentials are no longer valid and cannot be refreshed: stop calling, ask an admin to re-authorize. Never retried automatically. */
export class PermanentAuthError extends Error {}
/** Temporary failure: retry later with backoff. */
export class TransientError extends Error { constructor(msg: string, public retryAfterSeconds?: number) { super(msg); } }

export interface ExternalReview { externalId: string; rating: number; authorName?: string | null; body?: string | null; reviewedAt: string; replyText?: string | null; repliedAt?: string | null }
export interface SyncPage<T = unknown> { items: T[]; nextCursor: string | null; hasMore: boolean; stats?: Record<string, unknown> }
/** Authenticated provider-side TOTALS for one payment (used for reconciliation; cumulative, so it can never double-count webhook events). */
export interface PaymentSnapshot { paidCents: number; refundedCents: number; state: 'open' | 'paid' | 'partially_paid' | 'expired' | 'cancelled' | 'unknown'; receiptUrl?: string }
export interface NormalizedPaymentEvent { providerEventId: string; providerRef: string; type: 'succeeded' | 'failed' | 'refunded' | 'expired' | 'cancelled'; amountCents?: number; terminal?: boolean; receiptUrl?: string; occurredAt: string }

export interface ProviderAdapter {
  key: string; displayName: string; category: 'payments' | 'reviews' | 'messaging' | 'accounting' | 'crm' | 'calendar' | 'email' | 'storage' | 'ai' | 'other';
  authType: 'api_key' | 'oauth2'; sandbox: boolean; capabilities: Capability[];
  validateCredentials(creds: Credentials): Promise<{ accountLabel: string; scopes: string[]; expiresAt?: string }>;
  refresh?(creds: Credentials): Promise<Credentials>;                                  // throws PermanentAuthError | TransientError
  revoke?(creds: Credentials): Promise<void>;
  syncResources?: string[];
  sync?(ctx: { creds: Credentials; resource: string; cursor: string | null }): Promise<SyncPage>;
  // payments
  createPaymentLink?(creds: Credentials, req: { amountCents: number; currency: string; description: string; idempotencyKey: string; expiresAt?: Date; reference?: string }): Promise<{ providerRef: string; url: string; expiresAt?: string }>;
  getPaymentSnapshot?(creds: Credentials, providerRef: string): Promise<PaymentSnapshot | null>;      // authenticated fetch used for reconciliation
  refundPayment?(creds: Credentials, providerRef: string, amountCents: number, idempotencyKey: string): Promise<void>;
  verifyWebhook?(headers: Record<string, string | string[] | undefined>, rawBody: string, creds: Credentials): NormalizedPaymentEvent[];   // throws on bad signature
  // reviews
  postReviewReply?(creds: Credentials, externalReviewId: string, body: string, idempotencyKey: string): Promise<void>;   // reject → plain Error('rejected: …'); TransientError ONLY when nothing reached the provider; anything that may have been applied → Error('ambiguous: …')
}

const registry = new Map<string, ProviderAdapter>();
export const registerAdapter = (a: ProviderAdapter) => { registry.set(a.key, a); };
export const getAdapter = (key: string) => registry.get(key);
export const listAdapters = () => [...registry.values()];
