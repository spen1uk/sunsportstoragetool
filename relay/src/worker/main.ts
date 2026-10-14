import { runOne } from '../domain/queue.js';
import { handlers } from './handlers.js';
import { migrate } from '../db/migrate.js';
import { scheduleMaintenance } from '../domain/voice.js';
import { scheduleWorkflowScan } from '../domain/workflows.js';
import { scheduleConnectionScan } from '../integrations/connections.js';
import { schedulePaymentReconcile } from '../domain/payments.js';
import { assertProductionConfig, beat } from '../domain/ops.js';
import { pool } from '../db/pool.js';

/** Poll loop. Safe to run multiple workers (SKIP LOCKED); crashed workers' jobs are reclaimed after the lease expires. */
process.env.RELAY_PROCESS = 'worker';
assertProductionConfig();
await migrate();
await scheduleMaintenance();   // idempotent (dedupe key)
await scheduleWorkflowScan();
await scheduleConnectionScan();
await schedulePaymentReconcile();
console.log('relay worker started');
let running = true; let done = 0;
// Heartbeat on a timer (not in the job loop) so a long job doesn't look like a dead worker; /api/admin/status and /metrics read it.
await beat(done).catch(() => {});
const hb = setInterval(() => { beat(done).catch(() => {}); }, 10_000);
process.on('SIGTERM', () => { running = false; }); process.on('SIGINT', () => { running = false; });
while (running) {
  try { if (await runOne(handlers)) done++; else await new Promise((r) => setTimeout(r, 1000)); }
  catch (e) { console.error('worker loop error', e); await new Promise((r) => setTimeout(r, 2000)); }
}
clearInterval(hb); await pool.query('DELETE FROM worker_heartbeats WHERE pid=$1', [process.pid]).catch(() => {});   // clean shutdown: not reported as a dead worker
await pool.end();
process.exit(0);
