import type { Handler } from '../domain/queue.js';
import { handleSendMessageJob } from '../domain/messaging.js';
import { executeScheduled } from '../domain/scheduling.js';
import { recomputeAll, recomputeForContact } from '../domain/inventory.js';
import { buildSummary } from '../domain/summary.js';
import { purgeExpiredMedia, scheduleMaintenance } from '../domain/voice.js';

/** All background job handlers. Shared by the worker process and tests. */
export const handlers: Record<string, Handler> = {
  send_message: async (j) => handleSendMessageJob(j.payload.messageId),
  summarize_contact: async (j) => { await buildSummary(j.payload.contactId, { force: !!j.payload.force }); },
  maintenance: async () => { try { await purgeExpiredMedia(); } finally { await scheduleMaintenance(); } },
  recompute_matches: async (j) => { if (j.payload.contactId) await recomputeForContact(j.payload.contactId); else if (j.payload.all && j.workspace_id) await recomputeAll(j.workspace_id); },
  scheduled_send: async (j) => executeScheduled(j.payload.id),
};
