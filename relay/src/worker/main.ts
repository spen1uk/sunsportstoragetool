import { runOne, type Handler } from '../domain/queue.js';
import { handleSendMessageJob } from '../domain/messaging.js';
import { migrate } from '../db/migrate.js';

const handlers: Record<string, Handler> = {
  send_message: async (j) => handleSendMessageJob(j.payload.messageId),
};

/** Poll loop. Safe to run multiple workers (SKIP LOCKED); crashed workers' jobs are reclaimed after the lease expires. */
await migrate();
console.log('relay worker started');
let running = true;
process.on('SIGTERM', () => { running = false; }); process.on('SIGINT', () => { running = false; });
while (running) {
  try { if (!(await runOne(handlers))) await new Promise((r) => setTimeout(r, 1000)); }
  catch (e) { console.error('worker loop error', e); await new Promise((r) => setTimeout(r, 2000)); }
}
process.exit(0);
