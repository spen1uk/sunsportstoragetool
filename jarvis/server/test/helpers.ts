import { openDb, type DB } from '../db.ts';
import { seedStructure } from '../seed.ts';
import { setPassphrase, type Session } from '../auth.ts';
import http from 'node:http';

export function makeDb(): DB { const db = openDb(':memory:'); seedStructure(db); setPassphrase(db, 'test-pass'); return db; }
export const fakeSession = (stepUp = false): Session => ({ csrf: 'c', tokenHash: 'h', stepUpUntil: stepUp ? Date.now() + 60_000 : 0 });

export async function fixtureServer(pages: Record<string, { type?: string; body: string; status?: number; headers?: Record<string, string> }>) {
  const srv = http.createServer((req, res) => {
    const p = pages[req.url ?? '/'];
    if (!p) { res.statusCode = 404; return res.end('nope'); }
    res.statusCode = p.status ?? 200; res.setHeader('content-type', p.type ?? 'text/html');
    for (const [k, v] of Object.entries(p.headers ?? {})) res.setHeader(k, v);
    res.end(p.body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port as number;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
