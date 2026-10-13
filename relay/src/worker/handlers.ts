import type { Handler } from '../domain/queue.js';
import { handleSendMessageJob } from '../domain/messaging.js';
import { executeScheduled } from '../domain/scheduling.js';
import { recomputeAll, recomputeForContact } from '../domain/inventory.js';
import { handleAutoResponse } from '../domain/autoresponse.js';
import { advanceRun, handleWorkflowEvent, scanNoResponse, scheduleWorkflowScan } from '../domain/workflows.js';
import { runBroadcastTick } from '../domain/broadcasts.js';
import { runSync, scanConnections, scheduleConnectionScan } from '../integrations/connections.js';
import '../domain/reviews.js';
import { deliverOnce } from '../domain/webhooks.js';
import { reconcileOpen, schedulePaymentReconcile } from '../domain/payments.js';
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
  connection_sync: async (j) => { const r = await runSync(j.payload.connectionId, j.payload.resource); if (r.status === 'retry') { const { enqueue } = await import('../domain/queue.js'); const { pool } = await import('../db/pool.js'); await enqueue(pool, 'connection_sync', j.payload, { runAt: new Date(Date.now() + (r.retryInSeconds ?? 60) * 1000), workspaceId: j.workspace_id ?? undefined, dedupeKey: `${j.payload.connectionId}:${j.payload.resource}:retry:${Date.now()}` }); } },
  connection_scan: async () => { try { await scanConnections(); } finally { await scheduleConnectionScan(); } },
  webhook_delivery: async (j) => { await deliverOnce(j.payload.deliveryId); },
  payment_reconcile: async () => { try { await reconcileOpen(); } finally { await schedulePaymentReconcile(); } },
  scheduled_send: async (j) => executeScheduled(j.payload.id),
};
