import { z } from 'zod';

export const KINDS = ['contacts', 'messages', 'consents', 'templates'] as const;
export type Kind = (typeof KINDS)[number];

/** Which logical fields each kind understands. `req` fields must be mapped to a column before staging. */
export const FIELDS: Record<Kind, { key: string; label: string; req?: boolean; hints: RegExp }[]> = {
  contacts: [
    { key: 'phone', label: 'Phone', req: true, hints: /^(mobile|cell|phone|number|msisdn|phone ?number|mobile ?phone|contact ?number)$/i },
    { key: 'firstName', label: 'First name', hints: /^(first ?name|first|given ?name)$/i },
    { key: 'lastName', label: 'Last name', hints: /^(last ?name|last|surname|family ?name)$/i },
    { key: 'fullName', label: 'Full name (split on first space)', hints: /^(name|full ?name|contact ?name|customer)$/i },
    { key: 'email', label: 'Email', hints: /^(e-?mail|email ?address)$/i },
    { key: 'company', label: 'Company', hints: /^(company|organization|organisation|business)$/i },
    { key: 'tags', label: 'Tags (; or , separated)', hints: /^(tags?|labels?|groups?)$/i },
    { key: 'optOut', label: 'Opted out of texts? (yes/true/1/stop)', hints: /^(opt(ed)?.?out|unsubscribed|stop(ped)?|do ?not ?text|dnc)$/i },
    { key: 'optOutDate', label: 'Opt-out date', hints: /^(opt(ed)?.?out ?(date|time)|unsubscribed ?(at|date)|stop(ped)? ?(date|time))$/i },
    { key: 'note', label: 'Note (imported as an internal note)', hints: /^(notes?|comments?)$/i },
  ],
  messages: [
    { key: 'phone', label: 'Customer phone', req: true, hints: /^(contact|customer|mobile|cell|phone|number|contact ?number|customer ?phone)$/i },
    { key: 'direction', label: 'Direction', req: true, hints: /^(direction|type|dir|sent ?or ?received)$/i },
    { key: 'body', label: 'Message text', req: true, hints: /^(body|message|text|content|message ?body)$/i },
    { key: 'timestamp', label: 'Timestamp', req: true, hints: /^(time(stamp)?|date(time)?|when|sent ?at|created(_| ?)at|date ?sent)$/i },
    { key: 'externalId', label: 'Original message ID (optional)', hints: /^(id|message ?id|external ?id|sid)$/i },
    { key: 'name', label: 'Customer name (used only for new contacts)', hints: /^(name|customer ?name|contact ?name)$/i },
    { key: 'media', label: 'Attachment reference (counted, not fetched)', hints: /^(media|attachments?|image|mms)$/i },
  ],
  consents: [
    { key: 'phone', label: 'Phone', req: true, hints: /^(mobile|cell|phone|number|contact ?number)$/i },
    { key: 'action', label: 'Action (stop/start/marketing_opt_in/marketing_opt_out)', req: true, hints: /^(action|status|type|event|consent)$/i },
    { key: 'timestamp', label: 'Date of the event', hints: /^(time(stamp)?|date(time)?|when|occurred ?at|opt.?out ?date)$/i },
    { key: 'evidence', label: 'Evidence / source (required for marketing opt-in)', hints: /^(evidence|source|proof|keyword|reason)$/i },
  ],
  templates: [
    { key: 'name', label: 'Template name', req: true, hints: /^(name|title|template ?name)$/i },
    { key: 'body', label: 'Template text', req: true, hints: /^(body|message|text|content)$/i },
    { key: 'category', label: 'Category', hints: /^(category|type|group|folder)$/i },
  ],
};

export const mappingSchema = z.record(z.string(), z.string().min(1)).default({});
export const optionsSchema = z.object({
  /** Wall-clock timestamps without an offset are read in this zone (default: the workspace timezone). */
  timezone: z.string().optional(),
  /** Extra direction words, e.g. {"customer":"inbound","agent":"outbound"}. */
  directionMap: z.record(z.string(), z.enum(['inbound', 'outbound'])).optional(),
}).default({});

/** Guess a header→field mapping from column names; the owner confirms or edits it. Never assumes a vendor format. */
export function suggestMapping(kind: Kind, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {}; const used = new Set<string>();
  for (const f of FIELDS[kind]) { const h = headers.find((x) => !used.has(x) && f.hints.test(x.trim())); if (h) { out[f.key] = h; used.add(h); } }
  return out;
}
export function validateMapping(kind: Kind, headers: string[], mapping: Record<string, string>): string[] {
  const errs: string[] = []; const allowed = new Set(FIELDS[kind].map((f) => f.key));
  for (const [k, col] of Object.entries(mapping)) { if (!allowed.has(k)) errs.push(`unknown field “${k}”`); else if (!headers.includes(col)) errs.push(`column “${col}” (for ${k}) is not in the file`); }
  for (const f of FIELDS[kind]) if (f.req && !mapping[f.key]) errs.push(`required field “${f.label}” is not mapped`);
  const cols = Object.values(mapping); if (new Set(cols).size !== cols.length) errs.push('the same column is mapped to two fields');
  return errs;
}

const TRUE = new Set(['1', 'true', 'yes', 'y', 'stop', 'stopped', 'opted out', 'opt out', 'optout', 'unsubscribed', 'dnc', 'x']);
export const isTruthy = (v: string | undefined) => !!v && TRUE.has(v.trim().toLowerCase());

const IN = new Set(['inbound', 'in', 'received', 'receive', 'incoming', 'customer', 'from customer', 'rx', 'mo']);
const OUT = new Set(['outbound', 'out', 'sent', 'send', 'outgoing', 'staff', 'agent', 'user', 'to customer', 'tx', 'mt']);
export function parseDirection(v: string, extra: Record<string, 'inbound' | 'outbound'> = {}): 'inbound' | 'outbound' | null {
  const k = v.trim().toLowerCase(); const x = Object.fromEntries(Object.entries(extra).map(([a, b]) => [a.toLowerCase(), b]));
  if (x[k]) return x[k]; if (IN.has(k)) return 'inbound'; if (OUT.has(k)) return 'outbound'; return null;
}

const ACTIONS: Record<string, string> = {
  stop: 'sms_stop', optout: 'sms_stop', 'opt out': 'sms_stop', 'opt-out': 'sms_stop', opted_out: 'sms_stop', 'opted out': 'sms_stop', unsubscribe: 'sms_stop', unsubscribed: 'sms_stop', sms_stop: 'sms_stop',
  start: 'sms_start', optin: 'sms_start', 'opt in': 'sms_start', 'opt-in': 'sms_start', resubscribe: 'sms_start', resubscribed: 'sms_start', sms_start: 'sms_start',
  marketing_opt_in: 'marketing_opt_in', marketing_opt_out: 'marketing_opt_out', do_not_text: 'do_not_text_set', dnt: 'do_not_text_set',
};
export const parseAction = (v: string) => ACTIONS[v.trim().toLowerCase()] ?? null;

/**
 * Timestamps: ISO-8601 with offset/Z, epoch seconds/milliseconds, 'YYYY-MM-DD HH:mm[:ss]', 'M/D/YYYY h:mm[:ss] AM|PM' / 24h.
 * Anything without an offset is interpreted in `tz` (the zone is reported so the owner can confirm it in the preview). Ambiguous/invalid → null.
 */
import { zonedToUtc } from '../domain/time.js';
export function parseTimestamp(raw: string, tz: string): Date | null {
  const v = raw.trim(); if (!v) return null;
  if (/^\d{10}(\.\d+)?$/.test(v)) return new Date(Number(v) * 1000);
  if (/^\d{13}$/.test(v)) return new Date(Number(v));
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(v)) { const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); return isNaN(+d) ? null : d; }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(v);
  let y: number, mo: number, d: number, h: number, mi: number;
  if (m) { [y, mo, d] = [+m[1], +m[2], +m[3]]; h = +(m[4] ?? 0); mi = +(m[5] ?? 0); }
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?$/.exec(v);
    if (!m) return null;
    [mo, d, y] = [+m[1], +m[2], +m[3]]; h = +(m[4] ?? 0); mi = +(m[5] ?? 0);
    if (m[6]) { const pm = m[6].toLowerCase() === 'pm'; if (h < 1 || h > 12) return null; h = (h % 12) + (pm ? 12 : 0); }
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const probe = new Date(Date.UTC(y, mo - 1, d)); if (probe.getUTCMonth() !== mo - 1) return null;   // e.g. Feb 30
  return zonedToUtc(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`, tz).utc;
}

/** Common merge-token styles from other platforms → Relay's {{variable}}. Anything left that still looks like a token is reported, never guessed. */
export function convertTokens(body: string): { text: string; unmapped: string[] } {
  const known: Record<string, string> = { first_name: 'first_name', firstname: 'first_name', first: 'first_name', last_name: 'last_name', lastname: 'last_name', last: 'last_name', name: 'first_name', business_name: 'business_name', company: 'business_name', staff_name: 'staff_name', agent: 'staff_name', user: 'staff_name' };
  const key = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  let text = body.replace(/\{\{\s*([A-Za-z0-9_ -]+?)\s*\}\}|\{\s*([A-Za-z0-9_ -]+?)\s*\}|\[\s*([A-Za-z0-9_ -]+?)\s*\]|%([A-Za-z0-9_ -]+?)%|<<\s*([A-Za-z0-9_ -]+?)\s*>>/g, (all, a, b, c, d, e) => {
    const k = key(a ?? b ?? c ?? d ?? e); return known[k] ? `{{${known[k]}}}` : all;
  });
  const rest = text.replace(/\{\{[^{}]*\}\}/g, '');
  const unmapped = [...rest.matchAll(/(\{[^{}\n]{1,40}\}|\[[A-Za-z][A-Za-z0-9_ -]{0,30}\]|%[A-Za-z][A-Za-z0-9_ -]{0,30}%|<<[^<>\n]{1,40}>>)/g)].map((x) => x[0]);
  text = text.trim();
  return { text, unmapped: [...new Set(unmapped)] };
}
