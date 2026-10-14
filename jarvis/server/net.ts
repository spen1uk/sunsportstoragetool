import dns from 'node:dns/promises';
import net from 'node:net';

const V4_BLOCK = new net.BlockList();
for (const [base, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) V4_BLOCK.addSubnet(base, bits, 'ipv4');

/** IPv6 text → 16 bytes (handles "::" compression, a dotted IPv4 tail, and zone ids). null if it is not valid IPv6. */
export function ipv6Bytes(ipIn: string): Uint8Array | null {
  const ip = ipIn.split('%')[0].toLowerCase(); if (!net.isIPv6(ip)) return null;
  let head = ip, tail = '', dbl = ip.indexOf('::'); if (dbl >= 0) { head = ip.slice(0, dbl); tail = ip.slice(dbl + 2); }
  const toGroups = (part: string): number[] | null => {
    if (!part) return [];
    const g: number[] = [];
    for (const piece of part.split(':')) {
      if (piece.includes('.')) { const q = piece.split('.').map(Number); if (q.length !== 4 || q.some((x) => !(x >= 0 && x <= 255))) return null; g.push((q[0] << 8) | q[1], (q[2] << 8) | q[3]); }
      else g.push(parseInt(piece, 16));
    }
    return g;
  };
  const h = toGroups(head), t = toGroups(tail); if (!h || !t) return null;
  const groups = dbl >= 0 ? [...h, ...Array(8 - h.length - t.length).fill(0), ...t] : h; if (groups.length !== 8) return null;
  const out = new Uint8Array(16); groups.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 255; }); return out;
}

/** True for loopback, private, link-local, CGNAT, benchmarking, documentation, multicast and unspecified addresses, and for every IPv6 form that tunnels to IPv4. Unknown formats count as private (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return V4_BLOCK.check(ip, 'ipv4');
  const b = ipv6Bytes(ip); if (!b) return true;
  const first12Zero = b.slice(0, 12).every((x) => x === 0), v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  if (first12Zero) return true;                                                                         // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return V4_BLOCK.check(v4, 'ipv4');   // IPv4-mapped, dotted OR hex form
  const w0 = (b[0] << 8) | b[1], w1 = (b[2] << 8) | b[3];
  if (w0 === 0x64 && w1 === 0xff9b) return true;                                                        // NAT64 64:ff9b::/32 (embeds any IPv4)
  if (w0 === 0x2002) return true;                                                                       // 6to4
  if (w0 === 0x2001 && (w1 === 0 || w1 === 0x0db8)) return true;                                       // Teredo, documentation
  if (w0 === 0x0100 && b.slice(2, 8).every((x) => x === 0)) return true;                                // discard-only 100::/64
  if ((w0 & 0xfe00) === 0xfc00) return true;                                                            // unique local fc00::/7
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true;                               // link-local and site-local
  if ((w0 & 0xff00) === 0xff00) return true;                                                            // multicast
  return false;
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
