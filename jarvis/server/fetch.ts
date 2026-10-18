import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { resolvePublic, type Resolver, systemResolver } from './net.ts';
import { parseRobots, allowedByRobots, type Group } from './robots.ts';

export type Fetched = { url: string; finalUrl: string; status: number; contentType: string; body: string; sha256: string; retrievedAt: string };
export type FetchOpts = {
  isHostAllowed: (host: string) => boolean;
  resolver?: Resolver;
  /** TEST ONLY: permit loopback targets. Never wired to config or request input. */
  allowPrivateForTests?: boolean;
  maxBytes?: number; timeoutMs?: number; maxRedirects?: number;
  /** Overall time limit per hop (the idle timeout alone can be dodged by a slow trickle). */
  totalMs?: number;
  /** Be a polite visitor: honour robots.txt and wait between requests to the same site. Used for all research fetches. */
  polite?: boolean; minIntervalMs?: number;
  /** Internal: set while fetching robots.txt itself. */
  _robots?: boolean;
};

export const UA_PRODUCT = 'JarvisResearch';
const robotsCache = new Map<string, { at: number; groups: Group[] | 'deny' }>(), lastHit = new Map<string, number>();
export const _resetPoliteness = () => { robotsCache.clear(); lastHit.clear(); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function politeWait(host: string, ms: number) { const wait = (lastHit.get(host) ?? 0) + ms - Date.now(); lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) ?? 0) + ms)); if (wait > 0) await sleep(wait); }
async function robotsGroups(u: URL, o: FetchOpts): Promise<Group[] | 'deny'> {
  const key = u.origin, hit = robotsCache.get(key); if (hit && Date.now() - hit.at < 24 * 3_600_000) return hit.groups;
  let groups: Group[] | 'deny';
  try { const f = await fetchSource(new URL('/robots.txt', u.origin).toString(), { ...o, polite: false, _robots: true, maxBytes: 500_000 }); groups = parseRobots(f.body); }
  catch (e) { const m = /^HTTP (\d{3})/.exec((e as Error).message); groups = m && m[1][0] === '4' ? [] : 'deny'; }   // 4xx: no rules; anything else (5xx, network): treat the site as off limits for now
  robotsCache.set(key, { at: Date.now(), groups }); return groups;
}

/** Fetch one document with SSRF protection: allow-list on every redirect hop, public-IP pinning, size/time limits, text types only. */
export async function fetchSource(url: string, o: FetchOpts): Promise<Fetched> {
  const maxBytes = o.maxBytes ?? 1_000_000, timeout = o.timeoutMs ?? 10_000, maxRedirects = o.maxRedirects ?? 3;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (!o.isHostAllowed(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
    if (o.polite && !o._robots) {
      const g = await robotsGroups(u, o);
      if (g === 'deny') throw new Error(`robots.txt for ${u.hostname} could not be read, so I did not fetch it`);
      if (!allowedByRobots(g, UA_PRODUCT, u.pathname + u.search)) throw new Error(`${u.hostname} asks automated visitors not to fetch ${u.pathname} (robots.txt)`);
      if (!o.allowPrivateForTests) await politeWait(u.hostname, o.minIntervalMs ?? 1500);
    }
    if (u.protocol !== 'https:' && !(o.allowPrivateForTests && u.protocol === 'http:')) throw new Error('https required');
    const ip = o.allowPrivateForTests ? (u.hostname === 'localhost' ? '127.0.0.1' : u.hostname) : await resolvePublic(u.hostname, o.resolver ?? systemResolver);
    const res = await request(u, ip, maxBytes, timeout, o.totalMs ?? 20_000);
    if (res.status >= 300 && res.status < 400 && res.location) { current = new URL(res.location, u).toString(); continue; }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    if (!/^(text\/|application\/(xhtml\+xml|json))/i.test(res.contentType)) throw new Error(`unsupported content type: ${res.contentType}`);
    const body = res.buf.toString('utf8');
    return { url, finalUrl: current, status: res.status, contentType: res.contentType, body, sha256: crypto.createHash('sha256').update(res.buf).digest('hex'), retrievedAt: new Date().toISOString() };
  }
  throw new Error('too many redirects');
}

function request(u: URL, ip: string, maxBytes: number, timeout: number, totalMs: number) {
  return new Promise<{ status: number; location?: string; contentType: string; buf: Buffer }>((resolveIn, rejectIn) => {
    // `timeout` is only an idle timer; a server dribbling one byte every few seconds would hold us forever. This is the overall limit for the hop.
    const deadline = setTimeout(() => req.destroy(new Error('overall time limit')), totalMs);
    const resolve = (v: any) => { clearTimeout(deadline); resolveIn(v); }, reject = (e: unknown) => { clearTimeout(deadline); rejectIn(e); };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', timeout, servername: u.hostname,
      headers: { 'user-agent': 'JarvisResearch/0.2 (+personal assistant)', accept: 'text/html,text/plain,application/json;q=0.8' },
      // Pin the connection to the vetted IP so DNS cannot change between check and connect.
      lookup: (_h: string, _o: unknown, cb: (e: Error | null, a: string, f: number) => void) => cb(null, ip, ip.includes(':') ? 6 : 4),
    } as any, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > maxBytes) { req.destroy(new Error('response too large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: String(res.headers['content-type'] ?? ''), buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
