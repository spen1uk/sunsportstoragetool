import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../config.ts';

/**
 * Server-side secret lookup. Order: environment variable, then data/secrets.json (mode 0600).
 * Nothing here is ever returned by an API route; the UI only learns "configured" or "not configured".
 */
const ENV: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', sandra: 'SANDRA_DIGEST_TOKEN' };
const file = () => path.join(config.dataDir, 'secrets.json');

/**
 * Optional macOS Keychain backend. It is OFF until `npm run secret:migrate` creates the marker file, so nothing changes (and no Keychain prompt
 * appears) for anyone who hasn't opted in. The key is passed to Apple's own `security` tool on its standard input (never on the command line,
 * where other programs could read it). Order: environment variable, Keychain (if enabled), then the 0600 file.
 */
export type Exec = (args: string[], input?: string) => string;
const defaultExec: Exec = (args, input) => execFileSync('/usr/bin/security', args, { input, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] });
let exec: Exec = defaultExec, platform: string = process.platform;
export const _testHooks = { setExec: (e: Exec | null) => { exec = e ?? defaultExec; kc.clear(); }, setPlatform: (p: string | null) => { platform = p ?? process.platform; kc.clear(); } };
const marker = () => path.join(config.dataDir, 'keychain.enabled');
const kc = new Map<string, { v: string | undefined; at: number }>();
const SERVICE = (name: string) => `jarvis-${name}`;
export const keychainEnabled = () => platform === 'darwin' && fs.existsSync(marker());
export function keychainGet(name: string): string | undefined {
  const hit = kc.get(name); if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v: string | undefined; try { v = exec(['find-generic-password', '-a', 'jarvis', '-s', SERVICE(name), '-w']).trim() || undefined; } catch { v = undefined; }   // a denied or dismissed prompt reads as "not there"
  kc.set(name, { v, at: Date.now() }); return v;
}
export function keychainSet(name: string, value: string) {
  if (!/^[\x21-\x7e]{8,300}$/.test(value) || /["'\\]/.test(value)) throw new Error('That value has characters the Keychain helper will not accept.');
  exec(['-i'], `add-generic-password -a jarvis -s ${SERVICE(name)} -U -w "${value}"\n`); kc.delete(name);
  if (keychainGet(name) !== value) throw new Error('The Keychain did not return what was saved, so nothing was changed.');   // verify the round trip before trusting it
}
export const keychainDelete = (name: string) => { try { exec(['delete-generic-password', '-a', 'jarvis', '-s', SERVICE(name)]); } catch { /* none */ } kc.delete(name); };
/** Move every secret from the 0600 file into the Keychain, verify each, then switch the Keychain on. The file is kept unless `removeFile`. */
export function migrateToKeychain(removeFile = false): { moved: string[]; removedFile: boolean } {
  if (platform !== 'darwin') throw new Error('The Keychain is only available on a Mac.');
  let cur: Record<string, string> = {}; try { cur = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* nothing to move */ }
  const moved: string[] = []; for (const [k, v] of Object.entries(cur)) if (v) { keychainSet(k, v); moved.push(k); }
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(marker(), 'on\n', { mode: 0o600 });
  let removedFile = false; if (removeFile && moved.length) { fs.rmSync(file(), { force: true }); removedFile = true; }
  return { moved, removedFile };
}

export function getSecret(name: string): string | undefined {
  const e = ENV[name] && process.env[ENV[name]];
  if (e) return e;
  if (keychainEnabled()) { const k = keychainGet(name); if (k) return k; }
  try { return (JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, string>)[name] || undefined; } catch { return undefined; }
}
export const hasSecret = (name: string) => !!getSecret(name);

export function setSecret(name: string, value: string) {
  if (keychainEnabled()) { keychainSet(name, value); return; }
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let cur: Record<string, string> = {};
  if (fs.existsSync(file())) { try { cur = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { throw new Error('data/secrets.json is damaged; fix or delete it before saving a new key (not overwriting it silently).'); } }
  cur[name] = value;
  const tmp = file() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cur), { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file());   // atomic: a crash mid-write cannot corrupt the file
}
export function clearSecret(name: string) {
  if (keychainEnabled()) keychainDelete(name);
  try { const cur = JSON.parse(fs.readFileSync(file(), 'utf8')); delete cur[name]; fs.writeFileSync(file(), JSON.stringify(cur), { mode: 0o600 }); } catch { /* none */ }
}
