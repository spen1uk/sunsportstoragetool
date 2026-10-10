import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { resolvePublic, type Resolver, systemResolver } from './net.ts';

export type Fetched = { url: string; finalUrl: string; status: number; contentType: string; body: string; sha256: string; retrievedAt: string };
export type FetchOpts = {
  isHostAllowed: (host: string) => boolean;
  resolver?: Resolver;
  /** TEST ONLY: permit loopback targets. Never wired to config or request input. */
  allowPrivateForTests?: boolean;
  maxBytes?: number; timeoutMs?: number; maxRedirects?: number;
};

/** Fetch one document with SSRF protection: allow-list on every redirect hop, public-IP pinning, size/time limits, text types only. */
export async function fetchSource(url: string, o: FetchOpts): Promise<Fetched> {
  const maxBytes = o.maxBytes ?? 1_000_000, timeout = o.timeoutMs ?? 10_000, maxRedirects = o.maxRedirects ?? 3;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (!o.isHostAllowed(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
    if (u.protocol !== 'https:' && !(o.allowPrivateForTests && u.protocol === 'http:')) throw new Error('https required');
    const ip = o.allowPrivateForTests ? (u.hostname === 'localhost' ? '127.0.0.1' : u.hostname) : await resolvePublic(u.hostname, o.resolver ?? systemResolver);
    const res = await request(u, ip, maxBytes, timeout);
    if (res.status >= 300 && res.status < 400 && res.location) { current = new URL(res.location, u).toString(); continue; }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    if (!/^(text\/|application\/(xhtml\+xml|json))/i.test(res.contentType)) throw new Error(`unsupported content type: ${res.contentType}`);
    const body = res.buf.toString('utf8');
    return { url, finalUrl: current, status: res.status, contentType: res.contentType, body, sha256: crypto.createHash('sha256').update(res.buf).digest('hex'), retrievedAt: new Date().toISOString() };
  }
  throw new Error('too many redirects');
}

function request(u: URL, ip: string, maxBytes: number, timeout: number) {
  return new Promise<{ status: number; location?: string; contentType: string; buf: Buffer }>((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', timeout, servername: u.hostname,
      headers: { 'user-agent': 'JarvisResearch/0.1 (+personal assistant)', accept: 'text/html,text/plain,application/json;q=0.8' },
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
