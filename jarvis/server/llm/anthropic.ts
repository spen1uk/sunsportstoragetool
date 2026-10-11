import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type Completion, type CompletionRequest, type Provider } from './types.ts';
import { getSecret } from './secrets.ts';

/**
 * Anthropic via the official SDK. Notes for the models we default to (Haiku 5.5 / Sonnet 5.5):
 *  - `thinking` is omitted (adaptive is the default; disabled is rejected), so `effort` is the cost lever — chat uses low.
 *  - no sampling params, no prefill, no forced tool_choice (we use no tools at all).
 *  - a safety `refusal` stop reason is surfaced as an error, never retried on another model.
 */
export function anthropicProvider(opts: { baseURL?: string; apiKey?: string; maxRetries?: number } = {}): Provider {
  let client: Anthropic | null = null;
  const key = () => opts.apiKey ?? getSecret('anthropic');
  const get = () => { const k = key(); if (!k) throw new LlmError('unavailable', 'No Anthropic API key configured'); return (client ??= new Anthropic({ apiKey: k, baseURL: opts.baseURL, maxRetries: opts.maxRetries ?? 2, timeout: 60_000 })); };
  return {
    id: 'anthropic',
    available: () => !!key(),
    async complete(req: CompletionRequest): Promise<Completion> {
      const c = get();
      try {
        const r = await c.messages.create({
          model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages,
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
        });
        if (r.stop_reason === 'refusal') throw new LlmError('refusal', `The model declined this request${r.stop_details?.category ? ` (${r.stop_details.category})` : ''}.`);
        const text = r.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
        return { text, model: r.model, stopReason: r.stop_reason ?? 'unknown',
          usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, cacheReadTokens: r.usage.cache_read_input_tokens ?? 0 } };
      } catch (e) {
        if (e instanceof LlmError) throw e;
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LlmError('auth', 'Anthropic rejected the API key');
        if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) throw new LlmError('bad_request', (e as Error).message.slice(0, 200));
        if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.APIConnectionError || (e instanceof Anthropic.APIError && (e.status ?? 0) >= 500)) throw new LlmError('transient', (e as Error).message.slice(0, 200));
        throw new LlmError('transient', (e as Error).message.slice(0, 200));
      }
    },
  };
}
