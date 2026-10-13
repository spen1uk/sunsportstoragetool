import type { Handler } from '../domain/queue.js';
import { handleSendMessageJob } from '../domain/messaging.js';
import { executeScheduled } from '../domain/scheduling.js';

/** All background job handlers. Shared by the worker process and tests. */
export const handlers: Record<string, Handler> = {
  send_message: async (j) => handleSendMessageJob(j.payload.messageId),
  scheduled_send: async (j) => executeScheduled(j.payload.id),
};
