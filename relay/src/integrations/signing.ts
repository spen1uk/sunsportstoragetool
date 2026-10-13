import { createHmac, timingSafeEqual } from 'node:crypto';

/** Timestamped HMAC-SHA256 over `${t}.${rawBody}`, header `t=<unix>,v1=<hex>[,v1=<hex>…]` — the scheme documented by Stripe for webhooks and used by Relay for its own webhooks. */
export function sign(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}
/** Throws on missing/malformed header, stale timestamp, or no matching signature. Accepts several v1 values (secret rollover) and ignores other schemes (e.g. v0). */
export function verify(secret: string, header: string | undefined, rawBody: string, opts: { toleranceSeconds?: number; now?: number } = {}): void {
  if (!header) throw new Error('missing signature');
  const parts = header.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const; });
  const t = Number(parts.find(([k]) => k === 't')?.[1]); const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) throw new Error('malformed signature');
  const tol = opts.toleranceSeconds ?? 300; if (tol > 0 && Math.abs((opts.now ?? Date.now()) / 1000 - t) > tol) throw new Error('stale timestamp');
  const want = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'));
  if (!sigs.some((s) => { const g = Buffer.from(s); return g.length === want.length && timingSafeEqual(g, want); })) throw new Error('bad signature');
}
