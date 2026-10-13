import { runOne } from '../domain/queue.js';
import { handlers } from './handlers.js';
import { migrate } from '../db/migrate.js';
import { scheduleMaintenance } from '../domain/voice.js';
import { scheduleWorkflowScan } from '../domain/workflows.js';

/** Poll loop. Safe to run multiple workers (SKIP LOCKED); crashed workers' jobs are reclaimed after the lease expires. */
await migrate();
await scheduleMaintenance();   // idempotent (dedupe key)
await scheduleWorkflowScan();
console.log('relay worker started');
let running = true;
process.on('SIGTERM', () => { running = false; }); process.on('SIGINT', () => { running = false; });
while (running) {
  try { if (!(await runOne(handlers))) await new Promise((r) => setTimeout(r, 1000)); }
  catch (e) { console.error('worker loop error', e); await new Promise((r) => setTimeout(r, 2000)); }
}
process.exit(0);
