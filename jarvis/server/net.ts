import dns from 'node:dns/promises';
import net from 'node:net';

/** True for loopback, private, link-local, CGNAT, multicast, and unspecified addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('ff');
  }
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;
export const systemResolver: Resolver = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Resolve and verify every address is public. Returns the first safe IP to connect to (prevents DNS rebinding between check and use). */
export async function resolvePublic(host: string, resolver: Resolver = systemResolver): Promise<string> {
  if (net.isIP(host)) { if (isPrivateAddress(host)) throw new Error('private address blocked'); return host; }
  const addrs = await resolver(host);
  if (!addrs.length) throw new Error('no address');
  if (addrs.some(isPrivateAddress)) throw new Error('host resolves to a private address');
  return addrs[0];
}
