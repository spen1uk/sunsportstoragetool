import path from 'node:path';

export const config = {
  host: process.env.JARVIS_HOST ?? '127.0.0.1',
  port: Number(process.env.JARVIS_PORT ?? 8788),
  dataDir: path.resolve(process.env.JARVIS_DATA_DIR ?? './data'),
  capMicroUsd: Math.round(Number(process.env.JARVIS_MONTHLY_CAP_USD ?? 100) * 1_000_000),
  /** Extra Host names Jarvis answers to (e.g. your private Tailscale name). Comma-separated in JARVIS_ALLOWED_HOSTS. Anything else is refused (DNS-rebinding defence). */
  allowedHosts: (process.env.JARVIS_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => /^[a-z0-9.-]+(:\d{1,5})?$/.test(h)),
  /** Set to 1 when something in front (e.g. `tailscale serve`) provides HTTPS: cookies become Secure and HSTS is sent. */
  publicHttps: process.env.JARVIS_PUBLIC_HTTPS === '1',
  timezone: 'America/Chicago',
  sessionTtlMs: 12 * 3600_000,
  stepUpTtlMs: 2 * 60_000,   // short, and each step-up is spent by ONE protected action (see auth.consumeStepUp)
  leaseMs: 60_000,
};
export const dbPath = () => path.join(config.dataDir, 'jarvis.db');
