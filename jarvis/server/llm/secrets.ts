import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/**
 * Server-side secret lookup. Order: environment variable, then data/secrets.json (mode 0600).
 * Nothing here is ever returned by an API route; the UI only learns "configured" or "not configured".
 */
const ENV: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY' };
const file = () => path.join(config.dataDir, 'secrets.json');

export function getSecret(name: string): string | undefined {
  const e = ENV[name] && process.env[ENV[name]];
  if (e) return e;
  try { return (JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, string>)[name] || undefined; } catch { return undefined; }
}
export const hasSecret = (name: string) => !!getSecret(name);

export function setSecret(name: string, value: string) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let cur: Record<string, string> = {};
  try { cur = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* new file */ }
  cur[name] = value;
  fs.writeFileSync(file(), JSON.stringify(cur), { mode: 0o600 });
  fs.chmodSync(file(), 0o600);
}
export function clearSecret(name: string) {
  try { const cur = JSON.parse(fs.readFileSync(file(), 'utf8')); delete cur[name]; fs.writeFileSync(file(), JSON.stringify(cur), { mode: 0o600 }); } catch { /* none */ }
}
