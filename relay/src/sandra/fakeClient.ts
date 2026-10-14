import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CONTRACT } from './contract.js';

export type Transport = (req: { method: string; path: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, unknown>; text: string }>;
export const fetchTransport = (base: string): Transport => async (req) => {
  const res = await fetch(new URL(req.path, base), { method: req.method, headers: req.headers, body: req.body });
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text: await res.text() };
};

export class ApiFailure extends Error { constructor(public status: number, public body: any) { super(`${status} ${body?.error ?? ''}`); } }

/** Thin typed client for /api/v1: what a real assistant integration needs to implement. Validates every response against the published contract. */
export class RelayAssistantClient {
  correlationId = randomUUID();
  constructor(private transport: Transport, private apiKey: string) {}
  async call<T>(method: string, path: string, opts: { body?: unknown; schema?: z.ZodType<T>; idempotencyKey?: string; okStatuses?: number[] } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, 'x-correlation-id': this.correlationId };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (method === 'POST') headers['idempotency-key'] = opts.idempotencyKey ?? randomUUID();
    const res = await this.transport({ method, path, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const json = res.text ? JSON.parse(res.text) : null;
    if (res.status >= 400 && !(opts.okStatuses ?? []).includes(res.status)) throw new ApiFailure(res.status, json);
    return (opts.schema ? opts.schema.parse(json) : json) as T;
  }
  me() { return this.call('GET', '/api/v1/me', { schema: CONTRACT.Me }); }
  events(after?: number) { return this.call('GET', `/api/v1/events${after ? `?after=${after}` : ''}`, { schema: CONTRACT.EventsPage }); }
  ack(seq: number) { return this.call<{ cursor: number }>('POST', '/api/v1/events/ack', { body: { seq } }); }
  conversation(id: string) { return this.call('GET', `/api/v1/conversations/${id}`, { schema: CONTRACT.ConversationDetail }); }
  business() { return this.call('GET', '/api/v1/business', { schema: CONTRACT.Business }); }
  inventory() { return this.call('GET', '/api/v1/inventory', { schema: CONTRACT.Inventory }); }
  async send(id: string, body: string, expectedRevision: number, key?: string) {
    const raw = await this.call<any>('POST', `/api/v1/conversations/${id}/messages`, { body: { body, expectedRevision }, idempotencyKey: key, okStatuses: [409, 422] });
    if (raw.error === 'stale_revision') return { kind: 'stale' as const, ...CONTRACT.StaleRevision.parse(raw) };
    if (raw.error === 'authority_required') return { kind: 'authority' as const, ...CONTRACT.AuthorityRequired.parse(raw) };
    if (raw.error) return { kind: 'rejected' as const, error: String(raw.error) };
    return { kind: 'accepted' as const, ...CONTRACT.SendAccepted.parse(raw) };
  }
  draft(id: string, body: string) { return this.call('POST', `/api/v1/conversations/${id}/drafts`, { body: { body }, schema: CONTRACT.DraftCreated }); }
  handoff(id: string, reason: string, createTask = false) { return this.call<{ ok: boolean; revision: number }>('POST', `/api/v1/conversations/${id}/handoff`, { body: { reason, createTask } }); }
  pause(id: string) { return this.call<{ ok: boolean; revision: number }>('POST', `/api/v1/conversations/${id}/pause`, { body: {} }); }
}

/**
 * A deliberately simple, RULE-BASED stand-in for Sandra (no AI). It exists to prove the integration contract end to end:
 * poll events → re-read the conversation → decide → send with the revision it observed → handle every rejection safely.
 * It treats customer text as data: its only use of it is keyword matching to choose among canned replies; it never executes or follows it.
 */
export class FakeSandra {
  log: string[] = [];
  constructor(private client: RelayAssistantClient, private opts: { beforeSend?: (conversationId: string) => Promise<void> } = {}) {}
  async tick(): Promise<{ handled: number }> {
    let handled = 0;
    const page = await this.client.events();
    for (const ev of page.events) {
      if (ev.type === 'message.received' && ev.conversationId) { await this.onInbound(ev.conversationId); handled++; }
      else if ((ev.type === 'contact.opted_out' || ev.type === 'conversation.takeover') && ev.conversationId) this.log.push(`${ev.type}: standing down on ${ev.conversationId}`);
    }
    if (page.events.length) await this.client.ack(page.events[page.events.length - 1].seq);
    return { handled };
  }
  private async onInbound(conversationId: string) {
    const d = await this.client.conversation(conversationId);
    if (d.conversation.handlingMode !== 'sandra') { this.log.push(`skip ${conversationId}: handling mode is ${d.conversation.handlingMode}`); return; }
    if (!d.sms.canSend) { this.log.push(`skip ${conversationId}: cannot text (${d.sms.reason})`); return; }
    const last = [...(d.messages ?? [])].reverse().find((m) => m.direction === 'inbound');
    const text = (last?.body ?? '').toLowerCase();
    if (d.humanRequiredTopics.length || /refund|lawyer|complain|manager/.test(text)) { await this.client.handoff(conversationId, `customer raised ${d.humanRequiredTopics.join(', ') || 'a sensitive matter'}`, true); this.log.push(`handoff ${conversationId}`); return; }
    let reply = 'Thanks for reaching out to Sun Sport Marine. A team member will follow up shortly.';
    if (/hours|open/.test(text)) { const b = await this.client.business(); reply = b.hours.configured ? 'Here are our hours; call us with any questions.' : 'I do not have our hours handy; a team member will confirm them for you.'; }
    await this.opts.beforeSend?.(conversationId);   // test seam: lets a test change the world between "decide" and "send"
    const r = await this.client.send(conversationId, reply, d.conversation.revision);
    this.log.push(`${r.kind} ${conversationId}`);
    if (r.kind === 'stale') this.log.push(`stale: conversation moved ${r.yourRevision}→${r.currentRevision}; re-reading instead of retrying`);
    if (r.kind === 'authority') this.log.push(`authority: ${r.topic}; saved as draft ${r.draftId}`);
  }
}
