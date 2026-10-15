import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NAME_RE } from './backup-run.ts';

/** The server's folder of ENCRYPTED backups, as the Mac helper sees it. Only files named exactly like our backups are ever listed or served. */
const cache = new Map<string, { size: number; mtime: number; sha256: string }>();
export async function listBackups(dir: string, limit = 30): Promise<{ name: string; size: number; sha256: string }[]> {
  if (!dir || !fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).sort().slice(-limit), out: { name: string; size: number; sha256: string }[] = [];
  for (const name of names) {
    const st = fs.statSync(path.join(dir, name)); if (!st.isFile()) continue;
    let c = cache.get(name); if (!c || c.size !== st.size || c.mtime !== st.mtimeMs) { c = { size: st.size, mtime: st.mtimeMs, sha256: await hashFile(path.join(dir, name)) }; cache.set(name, c); }
    out.push({ name, size: st.size, sha256: c.sha256 });
  }
  return out;
}
const hashFile = (f: string) => new Promise<string>((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej); });
/** Resolve a requested name to a real file, or null. The name must match the strict pattern, so no path can escape the folder. */
export function backupPath(dir: string, name: string): string | null { if (!dir || !NAME_RE.test(name)) return null; const f = path.join(dir, name); return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null; }
