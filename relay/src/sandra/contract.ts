import { z } from 'zod';

/**
 * The published response shapes of /api/v1 (version 1). Tests validate real responses against these, and docs/sandra/examples.json against these,
 * so the contract cannot drift from the server without a failing test. Unknown extra fields are allowed (additive changes are non-breaking).
 */
export const Message = z.object({ id: z.string().uuid(), seq: z.number(), direction: z.enum(['inbound', 'outbound']), origin: z.string(), body: z.string(), status: z.string(), createdAt: z.string(), untrusted: z.boolean() });
export const Conversation = z.object({
  id: z.string().uuid(), contactId: z.string().uuid(), revision: z.number().int(), status: z.enum(['open', 'closed']), responsibility: z.string(),
  handlingMode: z.enum(['human', 'sandra', 'draft_only', 'paused']), assigneeUserId: z.string().uuid().nullable(), departmentId: z.string().uuid().nullable(), tags: z.array(z.string()),
  lastInboundAt: z.string().nullable(), lastOutboundAt: z.string().nullable(), lastTakeoverAt: z.string().nullable(),
});
export const ConversationDetail = z.object({
  conversation: Conversation, sms: z.union([z.object({ canSend: z.literal(true) }), z.object({ canSend: z.literal(false), reason: z.string() })]),
  humanRequiredTopics: z.array(z.string()), messages: z.array(Message).optional(),
});
export const ConversationList = z.object({ conversations: z.array(Conversation) });
export const ServiceEvent = z.object({ seq: z.number().int(), id: z.string().uuid(), type: z.string(), createdAt: z.string(), conversationId: z.string().uuid().nullable(), contactId: z.string().uuid().nullable(), revision: z.number().nullable(), data: z.record(z.string(), z.unknown()) });
export const EventsPage = z.object({ events: z.array(ServiceEvent), cursor: z.number(), head: z.number(), hasMore: z.boolean() });
export const SendAccepted = z.object({ messageId: z.string().uuid(), status: z.string(), revision: z.number().int() });
export const StaleRevision = z.object({ error: z.literal('stale_revision'), currentRevision: z.number().int(), handlingMode: z.string(), yourRevision: z.number().int(), note: z.string() });
export const AuthorityRequired = z.object({ error: z.literal('authority_required'), topic: z.string(), detail: z.string(), draftId: z.string().uuid(), note: z.string() });
export const ApiError = z.object({ error: z.string() }).passthrough();
export const DraftCreated = z.object({ draftId: z.string().uuid() });
export const Me = z.object({ identity: z.object({ id: z.string().uuid(), name: z.string() }), scopes: z.array(z.string()), autonomy: z.enum(['read_only', 'drafts', 'send']), departmentIds: z.array(z.string()), rateLimitPerMin: z.number(), apiVersion: z.literal(1) });
export const Inventory = z.object({ boats: z.array(z.object({ id: z.string().uuid(), title: z.string(), price: z.number().nullable(), availability: z.enum(['available', 'unverified_stale', 'pending', 'sold', 'unknown']) }).passthrough()) });
export const Business = z.object({ name: z.string(), timezone: z.string(), hours: z.object({ configured: z.boolean() }).passthrough(), automationPaused: z.boolean(), texting: z.object({ live: z.boolean() }) });

export const CONTRACT = { Message, Conversation, ConversationDetail, ConversationList, ServiceEvent, EventsPage, SendAccepted, StaleRevision, AuthorityRequired, ApiError, DraftCreated, Me, Inventory, Business };
