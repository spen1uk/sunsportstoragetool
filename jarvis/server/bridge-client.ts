import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { MacError } from './mac.ts';
import { listCalendarNames, readCalendar, WINDOW } from './calendar.ts';
import { listFolderNames, readNotes } from './notes.ts';

/**
 * The Mac helper's logic (the part that runs on Luke's Mac when Jarvis itself lives on a server).
 * It only READS Calendar/Notes, only the calendars/folders the server says Luke ticked, and only talks to the one address he gave it,
 * over HTTPS (plain http is accepted for localhost only), never following redirects, using a credential that can do nothing else.
 */
export type BridgeCfg = { url: string; token: string; backupDir?: string };
export const defaultBackupDir = () => path.join(os.homedir(), 'Documents', 'Jarvis-Backups');
export const configPath = () => process.env.JARVIS_BRIDGE_CONFIG ?? path.join(os.homedir(), '.jarvis-bridge.json');

export function validateUrl(raw: string): string {
  let u: URL; try { u = new URL(raw.trim()); } catch { throw new Error('That is not a valid address.'); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('The server address must start with https:// (plain http is only allowed for localhost).');
  if (u.username || u.password) throw new Error('Do not put a username or password in the address.');
  return u.origin;
}
export function saveConfig(cfg: BridgeCfg, file = configPath()) {
  if (!/^jvb_[A-Za-z0-9_-]{20,100}$/.test(cfg.token)) throw new Error('That does not look like a bridge credential (it starts with jvb_).');
  fs.writeFileSync(file, JSON.stringify({ url: validateUrl(cfg.url), token: cfg.token, backupDir: cfg.backupDir }), { mode: 0o600 }); fs.chmodSync(file, 0o600);
}
export function loadConfig(file = configPath()): BridgeCfg {
  let raw: any; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Not set up yet. Run:  npm run bridge:setup`); }
  return { url: validateUrl(raw.url), token: String(raw.token), backupDir: typeof raw.backupDir === 'string' && raw.backupDir ? raw.backupDir : undefined };
}

type Fetch = typeof fetch;
async function call(cfg: BridgeCfg, f: Fetch, method: string, p: string, body?: unknown): Promise<any> {
  const r = await f(cfg.url + p, { method, redirect: 'error', signal: AbortSignal.timeout(120_000), headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`Server said ${r.status}${r.status === 401 ? ' (the credential was refused or revoked)' : ''}`);
  return r.json();
}
const msg = (e: unknown) => (e instanceof MacError ? e.message : (e as Error).message ?? 'failed');

/** One round: report what exists, read what the server allows, push it. Returns plain counts (never content). */
export async function cycle(cfg: BridgeCfg, o: { fetch?: Fetch; now?: number; log?: (s: string) => void } = {}) {
  const f = o.fetch ?? fetch, now = o.now ?? Date.now(), log = o.log ?? console.log;
  const out = { calendar: null as number | null, notes: null as number | null, errors: [] as string[] };
  const fail = async (kind: 'calendar' | 'notes', e: unknown) => { const m = msg(e); out.errors.push(`${kind}: ${m}`); log(`${kind}: ${m}`); await call(cfg, f, 'POST', '/api/bridge/failure', { kind, message: m }).catch(() => {}); };
  let conf = await call(cfg, f, 'GET', '/api/bridge/config');
  try { conf = await call(cfg, f, 'POST', '/api/bridge/names', { kind: 'calendar', names: await listCalendarNames() }); } catch (e) { await fail('calendar', e); }
  try { conf = await call(cfg, f, 'POST', '/api/bridge/names', { kind: 'notes', names: await listFolderNames() }); } catch (e) { await fail('notes', e); }
  if (conf.calendars?.length) {
    try { const r = await readCalendar(conf.calendars, now - WINDOW.past, now + WINDOW.ahead); await call(cfg, f, 'POST', '/api/bridge/calendar', { events: r.events, detail: r.detail }); out.calendar = r.events.length; log(`calendar: sent ${r.events.length} events`); } catch (e) { await fail('calendar', e); }
  }
  if (cfg.backupDir) { try { const b = await pullBackups(cfg, { fetch: f, log }); if (b.pulled) log(`backups: ${b.pulled} new copy saved (${b.have} kept)`); } catch (e) { out.errors.push(`backups: ${msg(e)}`); log(`backups: ${msg(e)}`); } }
  if (conf.folders?.length) {
    try { const n = await readNotes(conf.folders); await call(cfg, f, 'POST', '/api/bridge/notes', { notes: n }); out.notes = n.length; log(`notes: sent ${n.length} notes`); } catch (e) { await fail('notes', e); }
  }
  return out;
}

// ---------- off-server backup copies ----------
const NAME_RE = /^jarvis-\d{8}-\d{6}\.jvbk$/, KEEP_LOCAL = 30, MAGIC = 'JVBK1\n';
/**
 * Pull the server's ENCRYPTED backups into a folder on this Mac (so a copy lives somewhere other than the server).
 * Each file is checked against the hash the server reports and must start with the Jarvis backup marker; it is written under a temporary name and
 * only renamed into place when complete; nothing is ever deleted except the oldest local copies beyond the newest 30. The files cannot be
 * opened without your recovery key, so this folder is safe to keep in iCloud Drive, a backup disk, etc.
 */
export async function pullBackups(cfg: BridgeCfg, o: { fetch?: Fetch; log?: (s: string) => void } = {}) {
  const f = o.fetch ?? fetch, log = o.log ?? console.log, dir = cfg.backupDir ?? defaultBackupDir();
  const listing = await call(cfg, f, 'GET', '/api/bridge/backups'); const items: { name: string; size: number; sha256: string }[] = listing.items ?? [];
  if (!items.length) return { pulled: 0, have: 0 };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); let pulled = 0;
  for (const it of items) {
    if (!NAME_RE.test(it.name) || !/^[0-9a-f]{64}$/.test(it.sha256)) continue;
    const dest = path.join(dir, it.name);
    if (!fs.existsSync(dest)) {
      const r = await f(cfg.url + '/api/bridge/backups/' + it.name, { redirect: 'error', signal: AbortSignal.timeout(10 * 60_000), headers: { authorization: `Bearer ${cfg.token}` } });
      if (!r.ok) throw new Error(`Server said ${r.status} for ${it.name}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (crypto.createHash('sha256').update(buf).digest('hex') !== it.sha256 || buf.length !== it.size || buf.subarray(0, MAGIC.length).toString() !== MAGIC) throw new Error(`${it.name} arrived damaged; not saved. It will be tried again.`);
      const tmp = dest + '.part'; fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, dest); pulled++; log(`backup copy saved: ${it.name}`);
    }
    await call(cfg, f, 'POST', '/api/bridge/backups/ack', { name: it.name }).catch(() => {});   // tell the server this one is safely off the server
  }
  const mine = fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_LOCAL))) fs.rmSync(path.join(dir, old), { force: true });
  return { pulled, have: Math.min(mine.length, KEEP_LOCAL) };
}

// ---------- local alerts on the Mac ----------
/** A macOS notification (no shell: the text is passed as a script argument). */
export function macNotify(title: string, body: string) {
  if (process.platform !== 'darwin') return;
  execFile('osascript', ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', title.slice(0, 80), body.slice(0, 200)], () => {});
}
/** Keeps count of consecutive failed rounds; notifies after 2 (about 30 minutes) and then at most once every 3 hours. Tells you when it recovers. */
export function makeWatcher(notify: (t: string, b: string) => void = macNotify) {
  let fails = 0, lastNotified = 0, down = false;
  return {
    ok(now = Date.now()) { if (down) { notify('Jarvis is back', 'Your Jarvis server is answering again.'); } fails = 0; down = false; lastNotified = 0; void now; },
    failed(why: string, now = Date.now()) { fails++; if (fails >= 2 && now - lastNotified > 3 * 3_600_000) { down = true; lastNotified = now; notify('Jarvis server not answering', why.slice(0, 120)); } },
    get fails() { return fails; },
  };
}
