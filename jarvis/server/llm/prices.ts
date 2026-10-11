/**
 * $ per million tokens == micro-dollars per token. Source: Anthropic model table cached 2026-10-06
 * (Haiku 5.5 is $0.10/$0.50 for prompts up to 100K tokens). VERIFY against Anthropic's pricing page before relying on it;
 * unknown models are priced at a deliberately high default so the budget errs on the safe side.
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50 },
  'claude-sonnet-5-5': { in: 2.00, out: 10.00 },
};
export const UNKNOWN_PRICE = { in: 10, out: 50 };
export const priceOf = (model: string) => PRICES[model] ?? UNKNOWN_PRICE;
export const costMicro = (model: string, inTok: number, outTok: number) => { const p = priceOf(model); return Math.ceil(inTok * p.in + outTok * p.out); };
/** Rough pre-flight token estimate (≈3.5 chars/token, deliberately conservative). */
export const estTokens = (s: string) => Math.ceil(s.length / 3.5);
