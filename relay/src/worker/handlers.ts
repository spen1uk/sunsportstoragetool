import type { Handler } from '../domain/queue.js';
import { handleSendMessageJob } from '../domain/messaging.js';
import { executeScheduled } from '../domain/scheduling.js';
import { recomputeAll, recomputeForContact } from '../domain/inventory.js';
import { handleAutoResponse } from '../domain/autoresponse.js';
import { advanceRun, handleWorkflowEvent, scanNoResponse, scheduleWorkflowScan } from '../domain/workflows.js';
import { runBroadcastTick } from '../domain/broadcasts.js';
import { buildSummary } from '../domain/summary.js';
import { purgeExpiredMedia, scheduleMaintenance } from '../domain/voice.js';

/** All background job handlers. Shared by the worker process and tests. */
export const handlers: Record<string, Handler> = {
  send_message: async (j) => handleSendMessageJob(j.payload.messageId),
  summarize_contact: async (j) => { await buildSummary(j.payload.contactId, { force: !!j.payload.force }); },
  maintenance: async () => { try { await purgeExpiredMedia(); } finally { await scheduleMaintenance(); } },
  recompute_matches: async (j) => { if (j.payload.contactId) await recomputeForContact(j.payload.contactId); else if (j.payload.all && j.workspace_id) await recomputeAll(j.workspace_id); },
  auto_respond: async (j) => { await handleAutoResponse(j.payload.conversationId, j.payload.messageId); },
  workflow_event: async (j) => { await handleWorkflowEvent(j.payload); },
  workflow_step: async (j) => { await advanceRun(j.payload.runId); },
  workflow_scan: async () => { try { await scanNoResponse(); } finally { await scheduleWorkflowScan(); } },
  broadcast_tick: async (j) => { await runBroadcastTick(j.payload.broadcastId); },
  scheduled_send: async (j) => executeScheduled(j.payload.id),
};
