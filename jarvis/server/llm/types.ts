export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type Effort = 'low' | 'medium' | 'high';

export type CompletionRequest = { model: string; system: string; messages: ChatMessage[]; maxTokens: number; effort?: Effort; webSearch?: { maxUses: number; timezone?: string } };
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };
export type Source = { url: string; title: string };
export type Completion = { text: string; usage: Usage; model: string; stopReason: string; searches?: number; sources?: Source[] };

/** Errors are classified so the router knows whether trying another candidate can help. */
export class LlmError extends Error {
  kind: 'transient' | 'auth' | 'refusal' | 'bad_request' | 'unavailable';
  constructor(kind: LlmError['kind'], message: string) { super(message); this.kind = kind; }
}

export interface Provider {
  id: string;
  /** True when credentials exist. Never exposes them. */
  available(): boolean;
  complete(req: CompletionRequest): Promise<Completion>;
}
