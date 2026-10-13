# Data shared with AI providers

**Today: nothing.** The only summary extractor shipped is the rule-based `heuristic` provider (regex rules in `src/providers/summarizer.ts`); voice cleanup is rule-based (`cleanTranscript`); no transcription provider is configured. No customer data leaves the Relay server for AI purposes.

When an LLM provider (OpenAI / Anthropic) is added after the owner supplies an API key and approves it:

| Feature | Data that WOULD be sent | Never sent |
|---|---|---|
| Summaries | One chunk (≤40) of customer-visible messages at a time: direction, timestamp, text | Internal notes, team chat, consent evidence, payment data, staff-only fields |
| Voice transcription | The single recording being transcribed, to exactly ONE configured provider | Recordings are never sent to multiple providers; no automatic send of results |
| Drafts / matching assistance | The relevant conversation text and verified inventory rows | Anything outside the viewer's permission scope |

Controls already in place: provider adapter interface with citation validation (evidence must cite messages inside the chunk); per-call usage rows in `ai_usage` (cost is NULL when unknown, never invented); provider failure never blocks messaging (tested). Still TODO before enabling: per-workspace provider/model selection UI, spend limits, provider data-retention terms review (verify against the provider's current policy at that time).
