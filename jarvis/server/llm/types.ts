export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type Effort = 'low' | 'medium' | 'high';

export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
export type CompletionRequest = { tools?: ToolDef[]; blocks?: unknown[]; model: string; system: string; messages: ChatMessage[]; maxTokens: number; effort?: Effort; cache?: boolean; schema?: Record<string, unknown>; webSearch?: { maxUses: number; timezone?: string; allowedDomains?: string[]; blockedDomains?: string[] } };
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number };
export type Source = { url: string; title: string };
export type Claim = { text: string; cites: { url: string; title: string; citedText: string }[] };
export type Completion = { toolCalls?: ToolCall[]; content?: unknown[]; text: string; usage: Usage; model: string; stopReason: string; searches?: number; sources?: Source[]; claims?: Claim[]; pageAges?: Record<string, string> };

/** Errors are classified so the router knows whether trying another candidate can help. */
export class LlmError extends Error {
  kind: 'transient' | 'auth' | 'refusal' | 'bad_request' | 'unavailable';
  constructor(kind: LlmError['kind'], message: string) { super(message); this.kind = kind; }
}

export interface Provider {
  id: string;
  /** True when credentials exist. Never exposes them. */
  available(): boolean;
  /** What this provider can do beyond plain text. Absent means text only. */
  capabilities?: { webSearch?: boolean };
  complete(req: CompletionRequest): Promise<Completion>;
}
