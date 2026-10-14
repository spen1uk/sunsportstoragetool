// Environment-driven config. Dev/test/prod are isolated by DATABASE_URL + RELAY_ENV; never commit real secrets.
export const config = {
  env: process.env.RELAY_ENV ?? 'development',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://relay:relay_dev_only@localhost:5432/relay_dev',
  port: Number(process.env.PORT ?? 4000),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 24 * 7),
  // Shared secret for the built-in SMS simulator's signed webhooks. Real providers get their own secrets.
  simulatorWebhookSecret: process.env.SIM_WEBHOOK_SECRET ?? 'dev-simulator-secret',
  webhookToleranceSeconds: 300,
  secureCookies: process.env.RELAY_ENV === 'production',
  // Our own safety valve per broadcast (NOT a carrier rule; carrier/provider limits are verified separately per provider).
  broadcastMaxRecipients: Number(process.env.BROADCAST_MAX_RECIPIENTS ?? 10000),
  // Sandbox adapters keep state in-process. Set SANDBOX_WORKER_SYNC=0 when running a separate worker for demos so it doesn't compete with the server process.
  sandboxWorkerSync: process.env.SANDBOX_WORKER_SYNC !== '0',
  allowSandboxInProduction: process.env.ALLOW_SANDBOX === '1',
  mediaDir: process.env.MEDIA_DIR ?? './data/media',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  mediaSigningKey: process.env.MEDIA_SIGNING_KEY ?? 'dev-media-signing-key',
  // Master key for encrypting stored integration credentials (32-byte hex). Required in production.
  credentialKeyHex: process.env.CREDENTIAL_KEY_HEX ?? '',
  // Versioned keys for rotation: CREDENTIAL_KEYS='{"1":"<64 hex>","2":"<64 hex>"}', CREDENTIAL_KEY_ACTIVE=2. Dev/test fall back to a fixed NON-SECRET key.
  credentialKeysJson: process.env.CREDENTIAL_KEYS ?? '',
  credentialKeyActive: Number(process.env.CREDENTIAL_KEY_ACTIVE ?? 1),
  // Reverse-proxy trust: 'false' (default; use the socket address), 'true', a hop count (e.g. 1) or a comma-separated list of proxy IPs/CIDRs. Wrong values let clients spoof X-Forwarded-For and dodge rate limits.
  trustProxy: ((v: string | undefined): boolean | number | string[] => { if (!v || v === 'false') return false; if (v === 'true') return true; if (/^\d+$/.test(v)) return Number(v); return v.split(',').map((x) => x.trim()).filter(Boolean); })(process.env.TRUST_PROXY),
  // How long a worker may hold a job before another worker may reclaim it (a crashed worker's jobs are re-run after this).
  jobLeaseSeconds: Number(process.env.JOB_LEASE_SECONDS ?? 60),
  // /metrics is disabled (404) unless a token is configured; requests must send it as a Bearer token.
  metricsToken: process.env.METRICS_TOKEN ?? '',
  backupDir: process.env.BACKUP_DIR ?? '',
  // Enables jobs that exist only for crash-recovery drills. Never set in production (assertProductionConfig refuses).
  testJobs: process.env.RELAY_TEST_JOBS === '1',
};
