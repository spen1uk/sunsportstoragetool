import { BlockList, isIP } from 'node:net';
import dns from 'node:dns';
import https from 'node:https';

/**
 * SSRF defence for any URL a user can configure (webhook destinations). Layers:
 *  1. https only, no credentials in the URL, standard port only, no unusual hostnames
 *  2. every resolved address must be public (private, loopback, link-local, CGNAT, metadata, multicast, reserved, IPv4-mapped IPv6 are all refused)
 *  3. the socket connects to the address that was VALIDATED (custom lookup), so DNS rebinding between check and connect is impossible
 *  4. no redirects followed, short timeout, capped response size
 */
export class UnsafeUrlError extends Error {}

const v4 = new BlockList(); const v6 = new BlockList();
for (const [n, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) v4.addSubnet(n, p, 'ipv4');
for (const [n, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['2001::', 32], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64]] as const) v6.addSubnet(n, p, 'ipv6');

function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]; const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const o = m[1].split('.').map(Number); if (o.some((x) => x > 255)) return null; s = s.slice(0, -m[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const [head, tail] = s.split('::'); const h = head ? head.split(':') : []; const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
  const groups = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]; if (groups.length !== 8) return null;
  const nums = groups.map((g) => parseInt(g, 16)); return nums.some((n) => isNaN(n) || n < 0 || n > 0xffff) ? null : nums;
}
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip); if (!kind) return true;                                   // not an IP literal → refuse
  if (kind === 4) return v4.check(ip, 'ipv4');
  const g = expandV6(ip); if (!g) return true;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4.check(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, 'ipv4');   // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0) && !(g[6] === 0 && g[7] <= 1)) return true;                                                          // deprecated IPv4-compatible
  return v6.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

export type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

/** Static URL checks (no DNS). Returns the parsed URL or throws UnsafeUrlError. */
export function parseSafeUrl(raw: string): URL {
  let u: URL; try { u = new URL(raw); } catch { throw new UnsafeUrlError('not a valid URL'); }
  if (u.protocol !== 'https:') throw new UnsafeUrlError('only https:// destinations are allowed');
  if (u.username || u.password) throw new UnsafeUrlError('credentials in the URL are not allowed');
  if (u.port && u.port !== '443') throw new UnsafeUrlError('only the standard https port (443) is allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) throw new UnsafeUrlError('missing host');
  if (isIP(host)) { if (isBlockedIp(host)) throw new UnsafeUrlError('destination address is not public'); }
  else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') || !host.includes('.')) throw new UnsafeUrlError('internal hostnames are not allowed');
  return u;
}
/** Full check including DNS: every address the name resolves to must be public. Returns the validated addresses. */
export async function assertSafeUrl(raw: string, resolve: Resolver = defaultResolver): Promise<{ url: URL; addresses: string[] }> {
  const url = parseSafeUrl(raw); const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => { throw new UnsafeUrlError('hostname did not resolve'); });
  if (!addresses.length) throw new UnsafeUrlError('hostname did not resolve');
  const bad = addresses.find(isBlockedIp); if (bad) throw new UnsafeUrlError('destination resolves to a non-public address');
  return { url, addresses };
}

export interface SafeResponse { status: number; body: string; headers: Record<string, string | string[] | undefined> }
export interface SafeRequestOptions { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; resolve?: Resolver; transport?: (u: URL, addr: string, o: Required<Pick<SafeRequestOptions, 'method' | 'timeoutMs' | 'maxBytes'>> & { headers: Record<string, string>; body?: string }) => Promise<SafeResponse> }

export async function safeRequest(raw: string, o: SafeRequestOptions = {}): Promise<SafeResponse> {
  const { url, addresses } = await assertSafeUrl(raw, o.resolve);
  const opts = { method: o.method ?? 'POST', headers: o.headers ?? {}, body: o.body, timeoutMs: o.timeoutMs ?? 5000, maxBytes: o.maxBytes ?? 64 * 1024 };
  return (o.transport ?? httpsTransport)(url, addresses[0], opts);
}
const httpsTransport: NonNullable<SafeRequestOptions['transport']> = (url, addr, o) => new Promise((resolve, reject) => {
  const req = https.request({
    protocol: 'https:', host: url.hostname.replace(/^\[|\]$/g, ''), port: 443, path: url.pathname + url.search, method: o.method, headers: { ...o.headers, host: url.host }, timeout: o.timeoutMs, servername: url.hostname,
    // Connect ONLY to the address we validated: closes the DNS-rebinding window between check and use.
    lookup: ((_h: string, _opts: unknown, cb: (e: Error | null, address: string, family: number) => void) => cb(null, addr, isIP(addr))) as never,
  }, (res) => {
    const chunks: Buffer[] = []; let size = 0;
    res.on('data', (c: Buffer) => { size += c.length; if (size > o.maxBytes) { req.destroy(new Error('response too large')); return; } chunks.push(c); });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('request timed out'))); req.on('error', reject);
  if (o.body) req.write(o.body); req.end();
});
