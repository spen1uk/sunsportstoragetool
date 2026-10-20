import { type DB, getMeta, setMeta } from './db.ts';
import { audit } from './audit.ts';
import { getRunner, MacError, classify } from './mac.ts';
import { isPaused } from './pause.ts';
import { looksSecret } from './memory.ts';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';

/**
 * "Pull it up." Jarvis opens things for Luke on his Mac: a web page in his browser, an app, a Jarvis page, or an email / text DRAFT in Mail / Messages.
 * It only opens; it never clicks, types, sends or reads the screen. Everything is validated here, in code, whatever the model said:
 * https pages only (no addresses, no logins in the link), a fixed list of apps, and drafts become a compose window that Luke sends himself.
 * Needs no extra macOS permission (it uses the same call as double-clicking a link).
 */
export const APPS = ['Calendar', 'Notes', 'Mail', 'Messages', 'Maps', 'Safari', 'Reminders', 'Finder', 'Music', 'Photos', 'Contacts', 'Preview', 'TextEdit', 'Calculator', 'System Settings', 'Google Chrome', 'Firefox', 'Numbers', 'Pages', 'Keynote', 'Excel', 'Word'] as const;
/** Jarvis's own pages (same labels as the menu). */
export const PAGES: { label: string; hash: string }[] = [
  { label: 'Command Center', hash: '#/command' }, { label: 'Search', hash: '#/search' }, { label: 'My Life', hash: '#/life' }, { label: 'Workspace', hash: '#/workspace' }, { label: 'Agents', hash: '#/agents' }, { label: 'Agent Foundry', hash: '#/foundry' }, { label: 'Agent Universe', hash: '#/universe' },
  { label: 'Tasks', hash: '#/tasks' }, { label: 'Goals', hash: '#/goals' }, { label: 'Learn', hash: '#/learn' }, { label: 'Calendar', hash: '#/calendar' }, { label: 'Notes', hash: '#/notes' }, { label: 'Briefings', hash: '#/briefings' }, { label: 'Overnight Plan', hash: '#/overnight' },
  { label: 'Prometheus', hash: '#/research' }, { label: 'Missions', hash: '#/missions' }, { label: 'Ready for Review', hash: '#/review' }, { label: 'Approvals', hash: '#/approvals' }, { label: 'Memory', hash: '#/memory' }, { label: 'Knowledge', hash: '#/knowledge' },
  { label: 'Connections', hash: '#/connections' }, { label: 'Skills', hash: '#/skills' }, { label: 'Models', hash: '#/models' }, { label: 'Integrations', hash: '#/integrations' }, { label: 'Improvements', hash: '#/improve' }, { label: 'Permissions', hash: '#/permissions' }, { label: 'Activity', hash: '#/activity' }, { label: 'Settings', hash: '#/settings' },
];
const low = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export function findPage(name: string): { label: string; hash: string } | null { const n = low(name).replace(/\b(page|tab|screen|my|the)\b/g, '').replace(/\s+/g, ' ').trim(); if (!n) return null; return PAGES.find((p) => low(p.label) === n) ?? PAGES.find((p) => low(p.label).includes(n) || (n.length >= 4 && n.includes(low(p.label)))) ?? null; }
/** Apps that give a shell or scripting power, or change the system: Jarvis does not open these for you. */
const NEVER = new Set(['terminal', 'iterm', 'iterm2', 'script editor', 'automator', 'shortcuts', 'keychain access', 'disk utility', 'migration assistant', 'boot camp assistant', 'system information', 'console', 'activity monitor']);
const DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', `${homedir()}/Applications`];
let installed: { at: number; names: string[] } | null = null, injected: string[] | null = null;
/** Tests only. */
export const _setInstalled = (n: string[] | null) => { injected = n; installed = null; };
export function installedApps(now = Date.now()): string[] {
  if (injected) return injected; if (installed && now - installed.at < 60_000) return installed.names;
  const names = new Set<string>(); for (const d of DIRS) { try { for (const f of readdirSync(d)) if (f.endsWith('.app')) names.add(f.slice(0, -4)); } catch { /* folder not there */ } }
  const list = names.size ? [...names].sort() : [...APPS]; installed = { at: now, names: list }; return list;
}
/** Matches what he said to an app that is really installed (exact name first, then names containing all his words). Never one of the blocked apps. */
export function findApp(name: string): string | null {
  const n = low(name).replace(/\b(app|application|the|my|program)\b/g, '').replace(/\s+/g, ' ').trim(); if (!n) return null;
  const alias: Record<string, string> = { chrome: 'Google Chrome', settings: 'System Settings', 'system preferences': 'System Settings', imessage: 'Messages', email: 'Mail', texts: 'Messages' }; const want = alias[n] ?? n;
  const apps = installedApps().filter((a) => !NEVER.has(low(a))); if (NEVER.has(low(want))) return null;
  const words = low(want).split(' ').filter((w) => w.length > 1);
  return apps.find((a) => low(a) === low(want)) ?? apps.find((a) => low(a).replace(/\bthe\b/g, '').replace(/\s+/g, ' ').trim() === low(want)) ?? (words.length ? apps.find((a) => words.every((w) => low(a).includes(w))) ?? null : null);
}

/** A public https page: no addresses, no local names, no sign-in details in the link. */
export function safeUrl(raw: string): URL | null {
  const s = String(raw ?? '').trim().replace(/[\u0000-\u001f\u007f\s]/g, ''); if (s.length < 8 || s.length > 2000) return null;
  let u: URL; try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null; const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || h === 'localhost' || /\.(local|localhost|internal|lan|home|corp)$/.test(h) || h.length > 253) return null;
  return u;
}

// ---- named websites ("the real world" → its address), chosen by Luke ----
export type Shortcut = { name: string; url: string };
const MAX_SHORTCUTS = 30;
export const listShortcuts = (db: DB): Shortcut[] => { try { const v = JSON.parse(getMeta(db, 'shortcuts') || '[]'); return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && typeof x.url === 'string') : []; } catch { return []; } };
const nameKey = (s: string) => low(s).replace(/\b(the|my|website|site|page|app|application|web)\b/g, '').replace(/\s+/g, ' ').trim();
export function saveShortcut(db: DB, name: string, url: string): Shortcut {
  const key = nameKey(name); if (key.length < 2 || key.length > 40) throw new Error('Give it a short name, like “the real world”.'); if (looksSecret(`${name} ${url}`)) throw new Error('That looks like it contains a password or key, so I have not saved it.');
  const u = safeUrl(url); if (!u) throw new Error('That is not a public https web address I can save.'); if (u.search.length > 200) throw new Error('That address has a long tracking part. Give me the plain address of the site.');
  const all = listShortcuts(db).filter((x) => nameKey(x.name) !== key); if (all.length >= MAX_SHORTCUTS) throw new Error('Up to 30 saved websites. Remove one first.');
  const sc = { name: name.trim().slice(0, 40), url: u.origin + u.pathname + u.search }; setMeta(db, 'shortcuts', JSON.stringify([...all, sc])); audit(db, 'luke', 'shortcut.saved', sc.name, { host: u.hostname }); return sc;
}
export const removeShortcut = (db: DB, name: string) => { const key = nameKey(name), all = listShortcuts(db), rest = all.filter((x) => nameKey(x.name) !== key); if (rest.length === all.length) return false; setMeta(db, 'shortcuts', JSON.stringify(rest)); audit(db, 'luke', 'shortcut.removed', name); return true; };
export function findShortcut(db: DB, name: string): Shortcut | null { const key = nameKey(name); if (!key) return null; const all = listShortcuts(db); return all.find((x) => nameKey(x.name) === key) ?? all.find((x) => nameKey(x.name).includes(key) || (key.length >= 4 && key.includes(nameKey(x.name)))) ?? null; }

let recent: number[] = [];
/** Tests only. */
export const _resetLimit = () => { recent = []; };
const OPEN_JS = `function run(argv){ ObjC.import('AppKit'); const a = JSON.parse(argv[0]); const ws = $.NSWorkspace.sharedWorkspace; if (a.url) { return JSON.stringify({ ok: !!ws.openURL($.NSURL.URLWithString(a.url)) }); } if (a.app) { return JSON.stringify({ ok: !!ws.launchApplication(a.app) }); } throw new Error('nothing to open'); }`;
async function run(db: DB, what: { url?: string; app?: string }, kind: string, label: string, now: number): Promise<{ ok: boolean; error?: string }> {
  if (isPaused(db)) return { ok: false, error: 'Jarvis is paused, so I have not opened anything.' };
  recent = recent.filter((t) => now - t < 60_000); if (recent.length >= 10) return { ok: false, error: 'That is a lot of things opening at once. Give it a minute.' };
  recent.push(now);
  try { const out = JSON.parse(await getRunner()(OPEN_JS, [JSON.stringify(what)], 15_000)); audit(db, 'luke', 'mac.open', kind, { target: label.slice(0, 80) }); return out.ok ? { ok: true } : { ok: false, error: "macOS wouldn't open it." }; }
  catch (e) { const m = e instanceof MacError ? e : classify(String((e as Error).message), false); return { ok: false, error: m.kind === 'unavailable' ? 'I can only open things when Jarvis is running on your Mac.' : `macOS wouldn't open it (${m.message}).` }; }
}
export async function openUrl(db: DB, raw: string, now = Date.now()) { const u = safeUrl(raw); if (!u) return { ok: false as const, error: 'That is not a public https web address I can open.' }; const r = await run(db, { url: u.href }, 'url', u.hostname, now); return r.ok ? { ok: true as const, host: u.hostname.replace(/^www\./, ''), url: u.origin + u.pathname } : { ok: false as const, error: r.error! }; }
export async function openApp(db: DB, name: string, now = Date.now()) { const app = findApp(name); if (!app) return { ok: false as const, error: `I don't see an app called “${name.slice(0, 40)}” installed on this Mac (or it's one I don't open). If it's a website, tell me the address and I'll open that.` }; const r = await run(db, { app }, 'app', app, now); return r.ok ? { ok: true as const, app } : { ok: false as const, error: r.error! }; }

// ---- drafts: written by Jarvis, sent by Luke ----
export type Draft = { kind: 'email' | 'text'; to: string; subject: string; body: string };
const TTL = 30 * 60_000;
export function saveDraft(db: DB, d: Draft, now = Date.now()) {
  const to = d.to.trim(), body = d.body.trim().slice(0, 1500), subject = d.subject.trim().slice(0, 150);
  if (body.length < 2) throw new Error('The draft is empty.'); if (looksSecret(`${subject} ${body}`)) throw new Error('That draft contains something that looks like a password or key, so I have not written it out.');
  if (d.kind === 'email' && to && !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to)) throw new Error('That email address does not look right.');
  const phone = d.kind === 'text' ? to.replace(/[^\d+]/g, '') : ''; if (d.kind === 'text' && to && !/^\+?\d{7,15}$/.test(phone)) throw new Error('I need a phone number to start a text to someone, or leave it blank and pick them in Messages.');
  setMeta(db, 'draft:last', JSON.stringify({ kind: d.kind, to: d.kind === 'text' ? phone : to, subject, body, at: now })); audit(db, 'luke', 'draft.saved', d.kind);
}
export function getDraft(db: DB, now = Date.now()): Draft | null { try { const v = JSON.parse(getMeta(db, 'draft:last') || 'null'); return v && now - v.at < TTL ? { kind: v.kind, to: v.to, subject: v.subject, body: v.body } : null; } catch { return null; } }
export const showDraft = (d: Draft) => `${d.kind === 'email' ? 'Email' : 'Text'} draft${d.to ? ` to ${d.to}` : ''}:\n${d.subject ? `Subject: ${d.subject}\n` : ''}\n${d.body}\n\nI can't send it myself. Say “open it” and I'll put it in ${d.kind === 'email' ? 'Mail' : 'Messages'} ready for you to read and press Send, or tell me what to change.`;
export async function openDraft(db: DB, now = Date.now()): Promise<string | null> {
  const d = getDraft(db, now); if (!d) return null;
  const url = d.kind === 'email' ? `mailto:${encodeURIComponent(d.to).replace(/%40/g, '@')}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}` : `sms:${d.to}&body=${encodeURIComponent(d.body)}`;
  const r = await run(db, { url }, d.kind === 'email' ? 'mail-draft' : 'text-draft', d.kind, now); if (!r.ok) return r.error!;
  setMeta(db, 'draft:last', ''); return `Done. It's open in ${d.kind === 'email' ? 'Mail' : 'Messages'}. Read it over and press Send yourself; I haven't sent anything.`;
}
export const wantsDraftOpened = (t: string) => /^(?:ok(?:ay)?[,. ]*|yes[,. ]*|yeah[,. ]*)?(?:please )?(?:open|send|put|pull|show|bring)(?: it| that| this| the draft| the email| the text| the message)(?: up)?(?: (?:in|to|on|with|into) (?:my )?(?:mail|messages|imessage|email|text|texts|phone|the mail app))?[.!\s]*$/i.test(t.trim()) || /^(?:yes|yeah|yep|sure|ok(?:ay)?)[.! ]*open it/i.test(t.trim());
