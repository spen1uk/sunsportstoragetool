import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** Explicit send outcomes. `ambiguous` must NEVER be blindly retried (the provider may have sent it). */
export type SendOutcome =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected'; error: string }            // provider definitively refused
  | { kind: 'not_sent'; error: string }            // failed before reaching provider: safe to retry
  | { kind: 'ambiguous'; error: string };          // timeout after request left: outcome unknown

export type NormalizedWebhook =
  | { type: 'inbound'; eventId: string; providerMessageId: string; from: string; to: string; body: string; occurredAt: Date; media?: { contentType: string; dataBase64?: string; url?: string }[] }
  | { type: 'status'; eventId: string; providerMessageId: string; status: 'delivered' | 'failed' | 'provider_accepted'; occurredAt: Date; error?: string };

export interface SmsProvider {
  key: string;
  isSimulated: boolean;
  send(req: { from: string; to: string; body: string; idempotencyKey: string; media?: { url: string; contentType: string }[] }): Promise<SendOutcome>;
  /** Throws on bad signature / stale timestamp. Returns normalized events. */
  verifyAndParse(headers: Record<string, string | string[] | undefined>, rawBody: string): NormalizedWebhook[];
}

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

export function verifySignature(secret: string, header: string | undefined, rawBody: string, now = Date.now()): void {
  if (!header) throw new Error('missing signature');
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) throw new Error('malformed signature');
  if (Math.abs(now / 1000 - t) > config.webhookToleranceSeconds) throw new Error('stale timestamp');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  const given = Buffer.from(parts.v1);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error('bad signature');
}

// ---------- Simulator (DEMO ONLY: nothing leaves this process) ----------
export const simulatorControl = {
  /** Test hook: queue outcomes for upcoming sends. */
  nextOutcomes: [] as SendOutcome[],
  sent: [] as { from: string; to: string; body: string; idempotencyKey: string; providerMessageId: string; media?: { url: string; contentType: string }[] }[],
  reset() { this.nextOutcomes = []; this.sent = []; },
};
let simCounter = 0;

export const simulatorProvider: SmsProvider = {
  key: 'simulator',
  isSimulated: true,
  async send(req) {
    const forced = simulatorControl.nextOutcomes.shift();
    if (forced) {
      if (forced.kind === 'accepted') simulatorControl.sent.push({ ...req, providerMessageId: forced.providerMessageId });
      return forced;
    }
    const providerMessageId = `SIM${Date.now().toString(36)}${(++simCounter).toString(36)}`;
    simulatorControl.sent.push({ ...req, providerMessageId });
    return { kind: 'accepted', providerMessageId };
  },
  verifyAndParse(headers, rawBody) {
    const sig = headers['x-relay-signature'];
    verifySignature(config.simulatorWebhookSecret, Array.isArray(sig) ? sig[0] : sig, rawBody);
    const b = JSON.parse(rawBody);
    const events = Array.isArray(b.events) ? b.events : [b];
    return events.map((e: any): NormalizedWebhook =>
      e.type === 'status'
        ? { type: 'status', eventId: String(e.eventId), providerMessageId: String(e.providerMessageId), status: e.status, occurredAt: new Date(e.occurredAt ?? Date.now()), error: e.error }
        : { type: 'inbound', eventId: String(e.eventId), providerMessageId: String(e.providerMessageId), from: String(e.from), to: String(e.to), body: String(e.body ?? ''), occurredAt: new Date(e.occurredAt ?? Date.now()), media: e.media });
  },
};

const registry: Record<string, SmsProvider> = { simulator: simulatorProvider };
export const getProvider = (key: string) => registry[key];
export const registerProvider = (p: SmsProvider) => { registry[p.key] = p; };
