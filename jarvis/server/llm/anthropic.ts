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
    capabilities: { webSearch: true },
    async complete(req: CompletionRequest): Promise<Completion> {
      const c = get();
      if (req.tools?.length) {   // tool use: ONE model step. The caller (agent.ts) runs the tools and calls again; nothing here executes anything.
        try {
          const r = await c.messages.create({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: (req.blocks ?? req.messages) as Anthropic.MessageParam[], tools: req.tools as Anthropic.Tool[],
            ...(req.cache ? { cache_control: { type: 'ephemeral' as const } } : {}), ...(req.effort ? { output_config: { effort: req.effort } } : {}) });
          if (r.stop_reason === 'refusal') throw new LlmError('refusal', `The model declined this request${r.stop_details?.category ? ` (${r.stop_details.category})` : ''}.`);
          let text = ''; const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
          for (const b of r.content) { if (b.type === 'text') text += b.text; else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown> }); }
          return { text, toolCalls, content: r.content, model: r.model, stopReason: r.stop_reason ?? 'unknown', usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens, cacheReadTokens: r.usage.cache_read_input_tokens ?? 0, cacheWriteTokens: r.usage.cache_creation_input_tokens ?? 0 } };
        } catch (e) {
          if (e instanceof LlmError) throw e;
          if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new LlmError('auth', 'Anthropic rejected the API key');
          if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) throw new LlmError('bad_request', (e as Error).message.slice(0, 200));
          throw new LlmError('transient', (e as Error).message.slice(0, 200));
        }
      }
      try {
        const tools = req.webSearch ? [{ type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: req.webSearch.maxUses, ...(req.webSearch.allowedDomains?.length ? { allowed_domains: req.webSearch.allowedDomains } : req.webSearch.blockedDomains?.length ? { blocked_domains: req.webSearch.blockedDomains } : {}), ...(req.webSearch.timezone ? { user_location: { type: 'approximate' as const, timezone: req.webSearch.timezone } } : {}) }] : undefined;
        // A search turn can pause on the server side; we hand the paused turn straight back (unchanged) a few times, never more.
        let messages: Anthropic.MessageParam[] = req.messages, text = '', inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0, searches = 0, last: Anthropic.Message | null = null; const sources: { url: string; title: string }[] = [], claims: { text: string; cites: { url: string; title: string; citedText: string }[] }[] = [], pageAges: Record<string, string> = {};
        for (let i = 0; i < (tools ? 4 : 1); i++) {
          const r = await c.messages.create({
            model: req.model, max_tokens: req.maxTokens, system: req.system, messages,
            ...(tools ? { tools } : {}),
            ...(req.cache && !tools ? { cache_control: { type: 'ephemeral' as const } } : {}),   // the API places the breakpoint on the last block and moves it forward as a long loop grows
            ...((req.effort || req.schema) ? { output_config: { ...(req.effort ? { effort: req.effort } : {}), ...(req.schema ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}) } } : {}),
          });
          last = r;
          if (r.stop_reason === 'refusal') throw new LlmError('refusal', `The model declined this request${r.stop_details?.category ? ` (${r.stop_details.category})` : ''}.`);
          inTok += r.usage.input_tokens; outTok += r.usage.output_tokens; cacheRead += r.usage.cache_read_input_tokens ?? 0; cacheWrite += r.usage.cache_creation_input_tokens ?? 0; searches += (r.usage as any).server_tool_use?.web_search_requests ?? 0;
          for (const b of r.content) {
            if (b.type === 'text') {
              text += b.text; const cites: { url: string; title: string; citedText: string }[] = [];
              for (const ct of (b as any).citations ?? []) if (ct?.type === 'web_search_result_location' && typeof ct.url === 'string') { sources.push({ url: ct.url, title: String(ct.title ?? '') }); cites.push({ url: ct.url, title: String(ct.title ?? ''), citedText: String(ct.cited_text ?? '') }); }
              if (cites.length) claims.push({ text: b.text, cites });
            } else if ((b as any).type === 'web_search_tool_result' && Array.isArray((b as any).content)) {
              for (const w of (b as any).content) if (w?.type === 'web_search_result' && typeof w.url === 'string' && w.page_age) pageAges[w.url] = String(w.page_age);
            }
          }
          if (r.stop_reason !== 'pause_turn') break;
          messages = [...messages, { role: 'assistant', content: r.content as Anthropic.ContentBlockParam[] }];
        }
        return { text, model: last!.model, stopReason: last!.stop_reason ?? 'unknown', searches, sources, claims, pageAges,
          usage: { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } };
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
