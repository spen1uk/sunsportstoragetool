import path from 'node:path';

export const config = {
  host: process.env.JARVIS_HOST ?? '127.0.0.1',
  port: Number(process.env.JARVIS_PORT ?? 8787),
  dataDir: path.resolve(process.env.JARVIS_DATA_DIR ?? './data'),
  capMicroUsd: Math.round(Number(process.env.JARVIS_MONTHLY_CAP_USD ?? 100) * 1_000_000),
  timezone: 'America/Chicago',
  sessionTtlMs: 12 * 3600_000,
  stepUpTtlMs: 5 * 60_000,
  leaseMs: 60_000,
};
export const dbPath = () => path.join(config.dataDir, 'jarvis.db');
