import { type DB, getMeta, setMeta } from './db.ts';
import { getSecret } from './llm/secrets.ts';
import { audit } from './audit.ts';

/**
 * Jarvis's side of the Sandra digest: ONE read-only GET of a counts-only summary.
 * Sandra owns Sun Sport Marine; Jarvis only reads what her digest route chooses to show.
 *  - Localhost only (the address is checked when saved AND before every call); no redirects are followed.
 *  - The bearer token lives in the secret store (Keychain or 0600 file) under "sandra"; it is never shown, logged or sent to the browser.
 *  - The reply is untrusted: only numbers, true/false and short plain text survive; anything else is dropped. It is never given to a model
 *    as instructions and never stored: nothing about the digest is saved except "last checked, and whether it worked".
 *  - Calls are capped (30 an hour) and every call is audited (without the token or the numbers).
 */
const PATH = '/api/integrations/digest', TIMEOUT_MS = 8000, MAX_BYTES = 64 * 1024, CACHE_MS = 60_000, PER_HOUR = 30, WARN_DAYS = 14;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type Leaf = number | boolean | string;
export type Digest = { [key: string]: Leaf | Digest };
export type Status = 'not_configured' | 'no_token' | 'unreachable' | 'unauthorized' | 'bad_reply' | 'limited' | 'ok';
export type Result = { status: Status; digest?: Digest; expiresAt?: number; daysLeft?: number; message: string; at: number };

type Fetch = (url: string, init: { headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;
let doFetch: Fetch = (u, i) => fetch(u, i) as unknown as ReturnType<Fetch>;
export const _hooks = { setFetch: (f: Fetch | null) => { doFetch = f ?? ((u, i) => fetch(u, i) as unknown as ReturnType<Fetch>); cache = null; calls.length = 0; } };
let cache: { at: number; r: Result } | null = null; const calls: number[] = [];

/** Accepts only an http(s) address on this computer. Returns the clean origin, or null. */
export function cleanUrl(raw: string): string | null {
  let u: URL; try { u = new URL(raw.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !LOCAL.has(u.hostname) || u.username || u.password) return null;
  return u.origin;
}
export const getUrl = (db: DB) => cleanUrl(getMeta(db, 'sandra:url') ?? '');
export function setUrl(db: DB, raw: string): boolean {
  if (!raw.trim()) { setMeta(db, 'sandra:url', ''); cache = null; audit(db, 'luke', 'sandra.url', '', { cleared: true }); return true; }
  const o = cleanUrl(raw); if (!o) return false;
  setMeta(db, 'sandra:url', o); cache = null; audit(db, 'luke', 'sandra.url', o); return true;
}

const clip = (s: string) => s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
/** Keep numbers, booleans and short plain text; at most 3 levels and 60 keys. Everything else (arrays of records, long text, odd keys) is dropped. */
export function sanitize(v: unknown, depth = 0): Digest {
  const out: Digest = {}; if (!v || typeof v !== 'object' || Array.isArray(v) || depth > 2) return out; let n = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (n >= 60) break; if (!/^[A-Za-z][A-Za-z0-9_ .-]{0,40}$/.test(k)) continue;
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x; else if (typeof x === 'boolean') out[k] = x;
    else if (typeof x === 'string') { const s = clip(x); if (s) out[k] = s; }
    else if (x && typeof x === 'object' && !Array.isArray(x)) { const sub = sanitize(x, depth + 1); if (Object.keys(sub).length) out[k] = sub; }
    else continue; n++;
  }
  return out;
}

function parseExpiry(h: string | null): number | undefined {
  if (!h) return undefined; const t = /^\d{10,13}$/.test(h.trim()) ? (h.trim().length <= 10 ? Number(h) * 1000 : Number(h)) : Date.parse(h);
  return Number.isFinite(t) && t > 1_500_000_000_000 ? t : undefined;
}

const fail = (status: Status, message: string, at: number): Result => ({ status, message, at });
export async function fetchDigest(db: DB, o: { fresh?: boolean; at?: number } = {}): Promise<Result> {
  const at = o.at ?? Date.now(), base = getUrl(db);
  if (!base) return fail('not_configured', 'Sandra isn\'t connected yet, sir. Her address hasn\'t been set in Jarvis.', at);
  const token = getSecret('sandra'); if (!token) return fail('no_token', 'Sandra\'s address is set, but I don\'t have a token for her. Run "npm run secret:set -- sandra" in your terminal to save one.', at);
  if (!o.fresh && cache && at - cache.at < CACHE_MS && cache.r.status === 'ok') return cache.r;
  while (calls.length && at - calls[0] > 3_600_000) calls.shift();
  if (calls.length >= PER_HOUR) return fail('limited', 'I\'ve asked Sandra for her digest 30 times this hour, sir, so I\'m pausing. Try again later.', at);
  calls.push(at);
  let r: Result;
  try {
    const res = await doFetch(base + PATH, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 || res.status === 403) r = fail('unauthorized', 'Sandra refused the token. It may have expired, been revoked or rotated, so you\'ll need to save a fresh one.', at);
    else if (res.status === 429) r = fail('limited', 'Sandra is rate-limiting me, sir. I\'ll leave it a while.', at);
    else if (res.status !== 200) r = fail('unreachable', `Sandra answered with an unexpected status (${res.status}), so I'm not using it.`, at);
    else {
      const raw = await res.text(); let j: unknown; try { j = raw.length > MAX_BYTES ? null : JSON.parse(raw); } catch { j = null; }
      const digest = sanitize(j);
      if (!Object.keys(digest).length) r = fail('bad_reply', 'Sandra\'s reply wasn\'t in a shape I recognise, so I\'m ignoring it.', at);
      else { const expiresAt = parseExpiry(res.headers.get('x-token-expires')), daysLeft = expiresAt ? Math.floor((expiresAt - at) / 86_400_000) : undefined; r = { status: 'ok', digest, expiresAt, daysLeft, message: 'ok', at }; }
    }
  } catch { r = fail('unreachable', 'I couldn\'t reach Sandra, sir. She may be switched off, or the address may be wrong.', at); }
  setMeta(db, 'sandra:last', JSON.stringify({ at, status: r.status, expiresAt: r.expiresAt ?? null }));
  audit(db, 'jarvis', 'sandra.digest', '', { status: r.status });
  db.prepare("UPDATE connections SET status=?, last_sync=? WHERE id='sandra'").run(r.status === 'ok' ? 'connected' : 'planned', r.status === 'ok' ? new Date(at).toISOString() : null);
  if (r.status === 'ok') cache = { at, r };
  return r;
}

export function state(db: DB) {
  let last: any = null; try { last = JSON.parse(getMeta(db, 'sandra:last') ?? 'null'); } catch { /* none */ }
  const expiresAt: number | null = last?.expiresAt ?? null;
  return { url: getUrl(db), tokenSaved: !!getSecret('sandra'), lastChecked: last?.at ?? null, lastStatus: (last?.status ?? null) as Status | null, expiresAt, daysLeft: expiresAt ? Math.floor((expiresAt - Date.now()) / 86_400_000) : null };
}

const human = (k: string) => k.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/^./, (c) => c.toUpperCase());
const val = (v: Leaf) => typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'number' ? v.toLocaleString('en-US') : v;
function lines(d: Digest, indent = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(d)) { if (typeof v === 'object') { out.push(`${indent}${human(k)}:`, ...lines(v, indent + '  ')); } else out.push(`${indent}${human(k)}: ${val(v)}`); }
  return out;
}
export function render(r: Result): string {
  if (r.status !== 'ok' || !r.digest) return r.message;
  const warn = r.daysLeft !== undefined && r.daysLeft <= WARN_DAYS ? `\n\nHeads up, sir: my access token for Sandra expires ${r.daysLeft <= 0 ? 'today' : `in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`}. Ask her to rotate it, then save the new one with "npm run secret:set -- sandra".` : '';
  return `Here's Sandra's latest summary for Sun Sport Marine, sir (counts only, read straight from her):\n\n${lines(r.digest).join('\n')}${warn}`;
}

/** Questions that are about Sandra or Sun Sport Marine's live numbers. Asking her something free-form is not built yet. */
export const asksDigest = (t: string) => /\bsandra\b.*\b(digest|summary|status|numbers|report|update|connected)\b|\b(digest|summary|status|numbers|report|update)\b.*\bsandra\b|^(?:how(?:'s| is) (?:sun sport(?: marine)?|the (?:business|storage business|facility)) (?:doing|going))\??$|^(?:sun sport(?: marine)?|storage) (?:status|numbers|digest|summary|update)\??$|^(?:is )?sandra connected\??$/i.test(t.trim());
export const asksSandraFreeForm = (t: string) => /^(?:ask|tell|check with|talk to|message) sandra\b/i.test(t.trim());
export const FREEFORM_REPLY = 'I can\'t ask Sandra free-form questions yet, sir. That\'s the next step, and she\'ll need to approve it on her side first. For now I can read her summary: just say "Sandra\'s digest".';
