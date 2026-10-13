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
  mediaDir: process.env.MEDIA_DIR ?? './data/media',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  mediaSigningKey: process.env.MEDIA_SIGNING_KEY ?? 'dev-media-signing-key',
  // Master key for encrypting stored integration credentials (32-byte hex). Required in production.
  credentialKeyHex: process.env.CREDENTIAL_KEY_HEX ?? '',
};
