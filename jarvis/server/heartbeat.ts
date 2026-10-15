import https from 'node:https';
import type { DB } from './db.ts';
import { setMeta } from './db.ts';
import { healthIssues, heartbeatHost } from './health.ts';
import { resolvePublic } from './net.ts';

/**
 * Dead-man's-switch heartbeat. A server cannot reliably tell you that it has died, so while it is healthy it checks in with an external
 * watcher (any "healthchecks"-style service you choose: you give it a ping address and an email/phone for alerts). If the check-ins STOP,
 * or Jarvis reports a problem, the watcher alerts you. Nothing about you is sent: just an empty request, with no data in it.
 * Off unless JARVIS_HEARTBEAT_URL is set (https only; treat the address like a password because anyone holding it can send fake "I'm fine" pings).
 */
export function validateHeartbeatUrl(raw: string): URL {
  let u: URL; try { u = new URL(raw); } catch { throw new Error('JARVIS_HEARTBEAT_URL is not a valid address.'); }
  if (u.protocol !== 'https:') throw new Error('JARVIS_HEARTBEAT_URL must start with https://.');
  if (u.username || u.password) throw new Error('JARVIS_HEARTBEAT_URL must not contain a username or password.');
  return u;
}

/** One empty GET, no redirects followed, public address only, short deadline. Resolves true on a 2xx. */
export async function ping(url: URL, o: { fail?: boolean; timeoutMs?: number; resolver?: (h: string) => Promise<string[]> } = {}): Promise<boolean> {
  const ip = await resolvePublic(url.hostname, o.resolver);
  const path = (o.fail ? url.pathname.replace(/\/+$/, '') + '/fail' : url.pathname) + url.search;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => req.destroy(), o.timeoutMs ?? 10_000);
    const req = https.request({ host: url.hostname, port: url.port || undefined, path, method: 'GET', servername: url.hostname, headers: { 'user-agent': 'Jarvis-heartbeat' },
      lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, ip, ip.includes(':') ? 6 : 4) } as any, (res) => { res.resume(); clearTimeout(timer); resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300); });
    req.on('error', () => { clearTimeout(timer); resolve(false); }); req.end();
  });
}

export function startHeartbeat(db: DB, every = 5 * 60_000, send: typeof ping = ping) {
  const raw = process.env.JARVIS_HEARTBEAT_URL; if (!raw) return null;
  const url = validateHeartbeatUrl(raw);
  const beat = async () => {
    const bad = healthIssues(db).some((i) => i.level === 'urgent');   // report trouble instead of "all fine"
    const ok = await send(url, { fail: bad }).catch(() => false);
    setMeta(db, 'heartbeat_last', JSON.stringify({ at: Date.now(), ok, reported: bad ? 'problem' : 'ok' }));
  };
  void beat(); const iv = setInterval(() => void beat(), every); iv.unref?.();
  console.log(`Heartbeat on: checking in with ${heartbeatHost()} every ${Math.round(every / 60_000)} min.`);
  return () => clearInterval(iv);
}
