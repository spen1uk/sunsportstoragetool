import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MacError } from './mac.ts';
import { listCalendarNames, readCalendar, WINDOW } from './calendar.ts';
import { listFolderNames, readNotes } from './notes.ts';

/**
 * The Mac helper's logic (the part that runs on Luke's Mac when Jarvis itself lives on a server).
 * It only READS Calendar/Notes, only the calendars/folders the server says Luke ticked, and only talks to the one address he gave it,
 * over HTTPS (plain http is accepted for localhost only), never following redirects, using a credential that can do nothing else.
 */
export type BridgeCfg = { url: string; token: string };
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
  fs.writeFileSync(file, JSON.stringify({ url: validateUrl(cfg.url), token: cfg.token }), { mode: 0o600 }); fs.chmodSync(file, 0o600);
}
export function loadConfig(file = configPath()): BridgeCfg {
  let raw: any; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Not set up yet. Run:  npm run bridge:setup`); }
  return { url: validateUrl(raw.url), token: String(raw.token) };
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
  if (conf.folders?.length) {
    try { const n = await readNotes(conf.folders); await call(cfg, f, 'POST', '/api/bridge/notes', { notes: n }); out.notes = n.length; log(`notes: sent ${n.length} notes`); } catch (e) { await fail('notes', e); }
  }
  return out;
}
