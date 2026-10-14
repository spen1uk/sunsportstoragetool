import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool, tx } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from '../domain/authz.js';
import { classifyKeyword } from '../domain/consent.js';
import { audit, publish } from '../domain/events.js';
import { normalizePhone } from '../domain/phone.js';
import { touchSummary } from '../domain/summary.js';
import { assertTimezone } from '../domain/time.js';
import { parseCsv, toCsv } from './csv.js';
import { FIELDS, KINDS, convertTokens, isTruthy, mappingSchema, optionsSchema, parseAction, parseDirection, parseTimestamp, suggestMapping, validateMapping, type Kind } from './mapping.js';

/**
 * Staged imports. The flow is deliberately three-step so nothing reaches customer data by accident:
 *   upload (original bytes preserved, nothing parsed into rows)  →  stage (map + validate every row into import_rows; still NO customer data touched; preview counts)
 *   →  commit (one transaction, owner/admin typed confirmation)  →  rollback (removes what the batch created; opt-outs are NEVER rolled back).
 * Imports never send anything, never notify staff, never start automations/follow-ups, never reopen or flag conversations, and never record marketing consent.
 */
const admin = (a: Actor) => { if (!isAdmin(a)) throw new HttpError(403, 'owner or admin required for imports'); };
export const MAX_BYTES = 25 * 1024 * 1024; export const MAX_ROWS = 200_000;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const nameKey = (f?: string | null, l?: string | null) => `${f ?? ''} ${l ?? ''}`.trim().toLowerCase().replace(/\s+/g, ' ');
const compatibleNames = (a: string, b: string) => !a || !b || a === b;

async function loadBatch(db: Pick<PoolClient, 'query'>, a: Actor, id: string, lock = false) {
  const b = (await db.query(`SELECT * FROM import_batches WHERE id=$1 AND workspace_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, a.workspaceId])).rows[0];
  if (!b) throw new HttpError(404, 'import not found'); return b;
}
const fileText = async (b: { file_key: string }) => (await readFile(path.join(config.mediaDir, b.file_key))).toString('utf8');

export async function uploadBatch(a: Actor, i: { kind: string; filename: string; data: Buffer; source?: string }) {
  admin(a);
  if (!KINDS.includes(i.kind as Kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  if (!i.data.length) throw new HttpError(400, 'file is empty'); if (i.data.length > MAX_BYTES) throw new HttpError(413, 'file too large (25 MB limit)');
  let csv; try { csv = parseCsv(i.data.toString('utf8')); } catch (e) { throw new HttpError(400, `not a readable CSV: ${(e as Error).message}`); }
  if (csv.rows.length > MAX_ROWS) throw new HttpError(413, `too many rows (${csv.rows.length}; limit ${MAX_ROWS}) — split the file`);
  if (new Set(csv.headers).size !== csv.headers.length) throw new HttpError(400, 'duplicate column names in header row');
  const id = (await pool.query('SELECT gen_random_uuid() AS id')).rows[0].id as string; const key = `imports/${id}.csv`;
  await mkdir(path.dirname(path.join(config.mediaDir, key)), { recursive: true }); await writeFile(path.join(config.mediaDir, key), i.data, { mode: 0o600, flag: 'wx' });   // never overwritten
  const kind = i.kind as Kind;
  await pool.query(`INSERT INTO import_batches (id, workspace_id, kind, source, filename, file_sha256, file_key, file_bytes, headers, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, a.workspaceId, kind, i.source ?? 'csv', i.filename.slice(0, 200), sha(i.data), key, i.data.length, csv.headers, a.userId]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'import.upload', targetType: 'import_batch', targetId: id, meta: { kind, rows: csv.rows.length, sha256: sha(i.data) } });
  return { id, kind, headers: csv.headers, rowCount: csv.rows.length, delimiter: csv.delimiter, suggestedMapping: suggestMapping(kind, csv.headers), fields: FIELDS[kind].map((f) => ({ key: f.key, label: f.label, required: !!f.req })), sample: csv.rows.slice(0, 5) };
}

interface Parsed { [k: string]: unknown }
type RowOut = { status: 'valid' | 'error' | 'duplicate' | 'review'; reason?: string; parsed?: Parsed };

/** Parse + classify every row. Writes only to import_rows. Safe to repeat with a different mapping until commit. */
export async function stageBatch(a: Actor, id: string, input: { mapping?: unknown; options?: unknown }) {
  admin(a);
  const b = await loadBatch(pool, a, id);
  if (b.status === 'committed' || b.status === 'rolled_back') throw new HttpError(409, `import is ${b.status}; upload the file again to stage a new import`);
  const kind = b.kind as Kind; const mapping = mappingSchema.parse(input.mapping ?? b.mapping ?? {}); const options = optionsSchema.parse(input.options ?? b.options ?? {});
  const errs = validateMapping(kind, b.headers, mapping); if (errs.length) throw new HttpError(400, 'mapping problems', { problems: errs });
  const wsTz = (await pool.query('SELECT timezone FROM workspaces WHERE id=$1', [a.workspaceId])).rows[0].timezone as string; const tz = options.timezone ?? wsTz;
  try { assertTimezone(tz); } catch { throw new HttpError(400, `unknown timezone ${tz}`); }
  const csv = parseCsv(await fileText(b)); const col = Object.fromEntries(Object.entries(mapping).map(([k, h]) => [k, b.headers.indexOf(h)]));
  const get = (r: string[], k: string) => (col[k] >= 0 && col[k] !== undefined ? (r[col[k]] ?? '').trim() : '');
  const out: (RowOut & { raw: Record<string, string> })[] = [];
  // A column that looks like an opt-out flag but is not mapped would silently drop opt-outs: say so loudly instead.
  const mappedCols = new Set(Object.values(mapping)); const suspect = (kind === 'contacts' || kind === 'consents') ? b.headers.filter((h: string) => !mappedCols.has(h) && /opt|unsub|stop|dnc|do.?not|sms.?status|consent/i.test(h)) : [];
  const existing = await phoneIndex(pool, a.workspaceId);
  const seen = new Map<string, { idx: number; nk: string }>();
  const counts: Record<string, any> = { total: csv.rows.length, byReason: {} as Record<string, number> };
  const warn = (k: string) => { counts.warnings = counts.warnings ?? {}; counts.warnings[k] = (counts.warnings[k] ?? 0) + 1; };
  let prevTs = 0; let minTs = Infinity; let maxTs = -Infinity; const optOutPhones = new Set<string>(); const contactsNew = new Set<string>(); const contactsMatched = new Set<string>(); const noHistory = new Set<string>();

  csv.rows.forEach((r, ix) => {
    const raw = Object.fromEntries(b.headers.map((h: string, j: number) => [h, r[j] ?? '']));     const push = (o: RowOut) => out.push({ ...o, raw });
    if (r.length !== b.headers.length) return push({ status: 'error', reason: `column_count (${r.length} fields, header has ${b.headers.length})` });
    if (kind === 'templates') {
      const name = get(r, 'name'); const body = get(r, 'body');
      if (!name || name.length > 80) return push({ status: 'error', reason: 'bad_template_name' }); if (!body || body.length > 1600) return push({ status: 'error', reason: 'bad_template_body' });
      const conv = convertTokens(body); const key = name.toLowerCase();
      if (seen.has(key)) return push({ status: 'duplicate', reason: `duplicate_in_file (row ${seen.get(key)!.idx + 1})` });
      seen.set(key, { idx: ix, nk: '' });
      return push({ status: conv.unmapped.length ? 'review' : 'valid', reason: conv.unmapped.length ? `unmapped_tokens: ${conv.unmapped.join(' ')}` : undefined, parsed: { name, body: conv.text, category: get(r, 'category') || 'imported', unmapped: conv.unmapped } });
    }
    const phoneRaw = get(r, 'phone'); if (!phoneRaw) return push({ status: 'error', reason: 'missing_phone' });
    const phone = normalizePhone(phoneRaw); if (!phone) return push({ status: 'error', reason: 'invalid_phone' });
    const matches = existing.get(phone) ?? [];

    if (kind === 'contacts') {
      let first = get(r, 'firstName'); let last = get(r, 'lastName'); const full = get(r, 'fullName');
      if (!first && !last && full) { const [f, ...rest] = full.split(/\s+/); first = f; last = rest.join(' '); }
      const email = get(r, 'email'); const emailOk = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); if (!emailOk) warn('invalid_email_ignored');
      const tags = get(r, 'tags').split(/[;,]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean).slice(0, 10);
      const optOut = isTruthy(get(r, 'optOut')); let optOutAt: string | null = null;
      if (optOut && get(r, 'optOutDate')) { const d = parseTimestamp(get(r, 'optOutDate'), tz); if (d) optOutAt = d.toISOString(); else warn('opt_out_date_unreadable_using_import_time'); }
      const parsed: Parsed = { phone, phoneOriginal: phoneRaw, firstName: first || null, lastName: last || null, company: get(r, 'company') || null, email: emailOk && email ? email : null, tags, optOut, optOutAt, note: get(r, 'note') || null };
      const nk = nameKey(first, last);
      const prev = seen.get(phone);
      if (prev) {
        const prevRow = out[prev.idx];
        if (optOut && prevRow.parsed && !prevRow.parsed.optOut) { prevRow.parsed.optOut = true; prevRow.parsed.optOutAt = optOutAt; }   // an opt-out is never lost to de-duplication
        if (optOut) optOutPhones.add(phone);
        if (compatibleNames(prev.nk, nk)) return push({ status: 'duplicate', reason: `duplicate_in_file (row ${prev.idx + 1})`, parsed });
        if (matches.some((m) => nameKey(m.first, m.last) === nk)) { contactsMatched.add(`${phone}|${nk}`); return push({ status: 'valid', parsed: { ...parsed, action: 'match' } }); }   // this person already exists here
        contactsNew.add(`${phone}|${nk}`); parsed.action = 'create_review'; return push({ status: 'review', reason: `shared_number_different_name (row ${prev.idx + 1}); kept as a separate contact flagged needs-review`, parsed });
      }
      seen.set(phone, { idx: ix, nk });
      if (optOut) optOutPhones.add(phone);
      if (matches.length >= 2) return push({ status: 'review', reason: 'ambiguous_existing_match (number belongs to several existing contacts; skipped, nothing guessed)', parsed: { ...parsed, action: 'skip' } });
      if (matches.length === 1) {
        if (compatibleNames(nameKey(matches[0].first, matches[0].last), nk)) { contactsMatched.add(phone); return push({ status: 'valid', parsed: { ...parsed, action: 'match' } }); }
        contactsNew.add(phone); return push({ status: 'review', reason: 'existing_contact_different_name; kept as a separate contact flagged needs-review', parsed: { ...parsed, action: 'create_review' } });
      }
      contactsNew.add(phone); return push({ status: 'valid', parsed: { ...parsed, action: 'create' } });
    }

    if (kind === 'messages') {
      const dir = parseDirection(get(r, 'direction'), options.directionMap); if (!dir) return push({ status: 'error', reason: `unknown_direction “${get(r, 'direction')}” (add it under direction words)` });
      const ts = parseTimestamp(get(r, 'timestamp'), tz); if (!ts) return push({ status: 'error', reason: `bad_timestamp “${get(r, 'timestamp')}”` });
      if (ts.getTime() > Date.now() + 86400_000) return push({ status: 'error', reason: 'timestamp_in_future' });
      const body = get(r, 'body'); const media = get(r, 'media'); if (!body && !media) return push({ status: 'error', reason: 'empty_message' });
      if (body.length > 5000) return push({ status: 'error', reason: 'body_too_long' });
      const ext = get(r, 'externalId'); const key = ext ? `ext:${sha(`${a.workspaceId}|${ext}`)}` : sha(`${a.workspaceId}|${phone}|${ts.toISOString()}|${dir}|${body}`);
      const parsed: Parsed = { phone, phoneOriginal: phoneRaw, direction: dir, body: body || '[attachment not imported]', at: ts.toISOString(), key, name: get(r, 'name') || null, hasMedia: !!media };
      if (+ts < prevTs) counts.outOfOrder = (counts.outOfOrder ?? 0) + 1; prevTs = +ts; minTs = Math.min(minTs, +ts); maxTs = Math.max(maxTs, +ts);
      const prev = seen.get(key); if (prev) return push({ status: 'duplicate', reason: `duplicate_in_file (row ${prev.idx + 1})`, parsed });
      seen.set(key, { idx: ix, nk: '' });
      if (matches.length >= 2) return push({ status: 'review', reason: 'shared_number (several contacts use this number; skipped, nothing guessed)', parsed });
      if (matches.length === 1) contactsMatched.add(phone); else contactsNew.add(phone);
      if (dir === 'inbound' && classifyKeyword(body) === 'stop') optOutPhones.add(phone);
      if (media) counts.withMedia = (counts.withMedia ?? 0) + 1;
      return push({ status: 'valid', parsed });
    }

    // consents
    const type = parseAction(get(r, 'action')); if (!type) return push({ status: 'error', reason: `unknown_action “${get(r, 'action')}”` });
    const evidence = get(r, 'evidence'); if (type === 'marketing_opt_in' && !evidence) return push({ status: 'error', reason: 'marketing_opt_in_requires_evidence (a phone number alone is not consent)' });
    let at: string | null = null; if (get(r, 'timestamp')) { const d = parseTimestamp(get(r, 'timestamp'), tz); if (!d) return push({ status: 'error', reason: `bad_timestamp “${get(r, 'timestamp')}”` }); if (d.getTime() > Date.now() + 86400_000) return push({ status: 'error', reason: 'timestamp_in_future' }); at = d.toISOString(); } else warn('no_date_using_import_time');
    if (matches.length >= 2 && type !== 'sms_stop' && type !== 'do_not_text_set') return push({ status: 'review', reason: 'shared_number (opt-in style events are not applied to several contacts)', parsed: { phone, type, at, evidence } });
    if (type === 'sms_stop') optOutPhones.add(phone);
    if (matches.length) contactsMatched.add(phone); else contactsNew.add(phone);
    return push({ status: 'valid', parsed: { phone, phoneOriginal: phoneRaw, type, at, evidence: evidence || null } });
  });

  // Existing history check for message rows (already imported earlier?)
  if (kind === 'messages') {
    const keys = out.filter((o) => o.status === 'valid').map((o) => o.parsed!.key as string);
    const have = new Set<string>(); for (let i = 0; i < keys.length; i += 5000) for (const r of (await pool.query(`SELECT provider_message_id FROM messages WHERE workspace_id=$1 AND provider='import' AND provider_message_id = ANY($2::text[])`, [a.workspaceId, keys.slice(i, i + 5000)])).rows) have.add(r.provider_message_id);
    for (const o of out) if (o.status === 'valid' && have.has(o.parsed!.key as string)) { o.status = 'duplicate'; o.reason = 'already_imported'; }
    const phonesWithMsgs = new Set(out.filter((o) => o.status === 'valid').map((o) => o.parsed!.phone as string)); for (const p of contactsNew) if (!phonesWithMsgs.has(p)) noHistory.add(p);
  }

  for (const o of out) { const k = o.status; counts[k] = (counts[k] ?? 0) + 1; if (o.reason) { const r = o.reason.split(/[ (:“]/)[0]; counts.byReason[r] = (counts.byReason[r] ?? 0) + 1; } }
  if (suspect.length) { counts.warnings = counts.warnings ?? {}; counts.warnings[`possible_optout_column_not_mapped: ${suspect.join(', ')}`] = 1; }
  counts.valid = counts.valid ?? 0; counts.error = counts.error ?? 0; counts.duplicate = counts.duplicate ?? 0; counts.review = counts.review ?? 0;
  counts.contactsToCreate = contactsNew.size; counts.contactsMatched = contactsMatched.size; counts.optOuts = optOutPhones.size; counts.timezoneAssumed = tz;
  if (kind === 'messages') { counts.inbound = out.filter((o) => o.status === 'valid' && o.parsed!.direction === 'inbound').length; counts.outbound = out.filter((o) => o.status === 'valid' && o.parsed!.direction === 'outbound').length; if (isFinite(minTs)) counts.dateRange = [new Date(minTs).toISOString(), new Date(maxTs).toISOString()]; }

  await tx(async (c) => {
    await loadBatch(c, a, id, true);
    await c.query('DELETE FROM import_rows WHERE batch_id=$1', [id]);
    for (let i = 0; i < out.length; i += 500) {
      const chunk = out.slice(i, i + 500); const vals: unknown[] = []; const ph = chunk.map((o, j) => { vals.push(id, i + j + 1, JSON.stringify(o.raw), o.parsed ? JSON.stringify(o.parsed) : null, o.status, o.reason ?? null); return `($${j * 6 + 1},$${j * 6 + 2},$${j * 6 + 3},$${j * 6 + 4},$${j * 6 + 5},$${j * 6 + 6})`; });
      if (chunk.length) await c.query(`INSERT INTO import_rows (batch_id, row_no, raw, parsed, status, reason) VALUES ${ph.join(',')}`, vals);
    }
    await c.query(`UPDATE import_batches SET status='staged', mapping=$2, options=$3, counts=$4, staged_at=now() WHERE id=$1`, [id, JSON.stringify(mapping), JSON.stringify(options), JSON.stringify({ ...counts, noHistoryContacts: noHistory.size })]);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'import.stage', targetType: 'import_batch', targetId: id, meta: { kind, total: counts.total, valid: counts.valid, error: counts.error } });
  });
  return getBatch(a, id);
}

async function phoneIndex(db: Pick<PoolClient, 'query'>, workspaceId: string) {
  const rows = (await db.query(`SELECT ci.normalized, ct.id, ct.first_name AS first, ct.last_name AS last FROM contact_identities ci JOIN contacts ct ON ct.id=ci.contact_id WHERE ci.workspace_id=$1 AND ci.kind='phone' AND ct.merged_into IS NULL AND ct.erased_at IS NULL`, [workspaceId])).rows;
  const m = new Map<string, { id: string; first: string | null; last: string | null }[]>();
  for (const r of rows) { const l = m.get(r.normalized) ?? []; if (!l.some((x) => x.id === r.id)) l.push({ id: r.id, first: r.first, last: r.last }); m.set(r.normalized, l); }
  return m;
}

const dto = (b: any) => ({ id: b.id, kind: b.kind, filename: b.filename, status: b.status, sha256: b.file_sha256, bytes: b.file_bytes, headers: b.headers, mapping: b.mapping, options: b.options, counts: b.counts, result: b.result, createdAt: b.created_at, stagedAt: b.staged_at, committedAt: b.committed_at, rolledBackAt: b.rolled_back_at });
export async function getBatch(a: Actor, id: string) { admin(a); return dto(await loadBatch(pool, a, id)); }
export async function listBatches(a: Actor) { admin(a); return (await pool.query('SELECT * FROM import_batches WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100', [a.workspaceId])).rows.map(dto); }
export async function listRows(a: Actor, id: string, q: { status?: string; limit?: number; offset?: number }) {
  admin(a); await loadBatch(pool, a, id);
  const p: unknown[] = [id]; let w = 'batch_id=$1'; if (q.status) { p.push(q.status); w += ` AND status=$${p.length}`; } p.push(Math.min(q.limit ?? 50, 500), q.offset ?? 0);
  return (await pool.query(`SELECT row_no, status, reason, raw FROM import_rows WHERE ${w} ORDER BY row_no LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
}
/** Everything that was NOT imported, with the reason, in the original column layout: the reconciliation worklist. */
export async function errorReport(a: Actor, id: string) {
  admin(a); const b = await loadBatch(pool, a, id);
  const rows = (await pool.query(`SELECT row_no, status, reason, raw FROM import_rows WHERE batch_id=$1 AND status IN ('error','duplicate','review','skipped') ORDER BY row_no`, [id])).rows;
  return { filename: `${b.kind}-import-${id.slice(0, 8)}-not-imported.csv`, csv: toCsv([['row', 'outcome', 'reason', ...b.headers], ...rows.map((r) => [r.row_no, r.status, r.reason, ...b.headers.map((h: string) => r.raw[h])])]) };
}

// ---------------- commit ----------------
async function recomputeSmsConsent(c: PoolClient, workspaceId: string, contactId: string) {
  // Latest event wins by its ORIGINAL time; on a tie STOP wins. An imported "start" can therefore never un-opt-out someone who stopped later.
  const l = (await c.query(`SELECT type FROM consent_events WHERE contact_id=$1 AND type IN ('sms_stop','sms_start') ORDER BY occurred_at DESC, (type='sms_stop') DESC, id DESC LIMIT 1`, [contactId])).rows[0];
  if (!l) return;
  await c.query('UPDATE contacts SET sms_opted_out=$2, updated_at=now() WHERE id=$1', [contactId, l.type === 'sms_stop']);
  if (l.type === 'sms_stop') await c.query(`UPDATE messages SET status='suppressed', status_detail='sms_opted_out' WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id=$1) AND status='queued' AND purpose<>'compliance'`, [contactId]);
  void workspaceId;
}
async function addConsent(c: PoolClient, b: { id: string; filename: string; workspace_id: string }, contactId: string, type: string, at: string | null, evidence: string) {
  await c.query(`INSERT INTO consent_events (workspace_id, contact_id, type, scope, source, evidence, occurred_at, import_batch_id) VALUES ($1,$2,$3,'all','import',$4,COALESCE($5::timestamptz, now()),$6)`, [b.workspace_id, contactId, type, evidence.slice(0, 300), at, b.id]);
  await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, type, summary, origin_table, occurred_at) VALUES ($1,$2,'consent',$3,'consent_events',COALESCE($4::timestamptz, now()))`, [b.workspace_id, contactId, `Consent: ${type} (import)`, at]);
  if (type === 'sms_stop' || type === 'sms_start') await recomputeSmsConsent(c, b.workspace_id, contactId);
  else if (type === 'marketing_opt_out') await c.query(`UPDATE contacts SET marketing_status='opted_out' WHERE id=$1`, [contactId]);
  else if (type === 'marketing_opt_in') await c.query(`UPDATE contacts SET marketing_status='opt_in' WHERE id=$1 AND marketing_status<>'opted_out'`, [contactId]);   // an imported opt-in never overrides an opt-out
  else if (type === 'do_not_text_set') await c.query(`UPDATE contacts SET do_not_text=true WHERE id=$1`, [contactId]);
}

async function resolveContacts(c: PoolClient, b: { id: string; workspace_id: string }, phone: string, original: string, name: string | null, created: { n: number }) {
  const found = (await c.query(`SELECT DISTINCT ct.id FROM contact_identities ci JOIN contacts ct ON ct.id=ci.contact_id WHERE ci.workspace_id=$1 AND ci.kind='phone' AND ci.normalized=$2 AND ct.merged_into IS NULL AND ct.erased_at IS NULL`, [b.workspace_id, phone])).rows.map((r) => r.id as string);
  if (found.length) return found;
  const [f, ...rest] = (name ?? '').split(/\s+/).filter(Boolean);
  const ct = (await c.query(`INSERT INTO contacts (workspace_id, first_name, last_name, tags, import_batch_id) VALUES ($1,$2,$3,'{imported}',$4) RETURNING id`, [b.workspace_id, f ?? null, rest.join(' ') || null, b.id])).rows[0].id as string;
  await c.query(`INSERT INTO contact_identities (workspace_id, contact_id, kind, original_value, normalized, is_primary, import_batch_id) VALUES ($1,$2,'phone',$3,$4,true,$5)`, [b.workspace_id, ct, original, phone, b.id]);
  await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, type, summary) VALUES ($1,$2,'contact','Contact created by import')`, [b.workspace_id, ct]);
  created.n++; return [ct];
}

export async function commitBatch(a: Actor, id: string, confirm: string) {
  admin(a); if (confirm !== 'COMMIT') throw new HttpError(400, 'confirmation required: send {"confirm":"COMMIT"}');
  const res = await tx(async (c) => {
    const b = await loadBatch(c, a, id, true);
    if (b.status !== 'staged') throw new HttpError(409, `import is ${b.status}; only a staged import can be committed`);
    const rows = (await c.query(`SELECT row_no, status, parsed FROM import_rows WHERE batch_id=$1 AND status IN ('valid','review') ORDER BY row_no`, [id])).rows as { row_no: number; status: string; parsed: any }[];
    const r = { contactsCreated: 0, contactsMatched: 0, messagesImported: 0, messagesAlreadyPresent: 0, consentEvents: 0, templatesCreated: 0, skipped: 0, historyOptOutsDetected: 0 };
    const created = { n: 0 };
    if (b.kind === 'contacts') {
      for (const row of rows) {
        const p = row.parsed; if (!p || p.action === 'skip') { r.skipped++; continue; }
        let contactId: string; const applied: Record<string, unknown> = {};
        const found = (await c.query(`SELECT DISTINCT ct.id, ct.first_name, ct.last_name, ct.company, ct.email, ct.tags FROM contact_identities ci JOIN contacts ct ON ct.id=ci.contact_id WHERE ci.workspace_id=$1 AND ci.kind='phone' AND ci.normalized=$2 AND ct.merged_into IS NULL AND ct.erased_at IS NULL`, [b.workspace_id, p.phone])).rows;
        const sameNamed = p.action === 'create_review' ? found.find((f) => nameKey(f.first_name, f.last_name) === nameKey(p.firstName, p.lastName)) : undefined;
        const wantNew = (p.action === 'create_review' && !sameNamed) || found.length === 0;
        if (wantNew) {
          const tags = [...new Set(['imported', ...(p.action === 'create_review' ? ['needs-review'] : []), ...p.tags])];
          contactId = (await c.query(`INSERT INTO contacts (workspace_id, first_name, last_name, company, email, tags, import_batch_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [b.workspace_id, p.firstName, p.lastName, p.company, p.email, tags, id])).rows[0].id;
          await c.query(`INSERT INTO contact_identities (workspace_id, contact_id, kind, original_value, normalized, is_primary, import_batch_id) VALUES ($1,$2,'phone',$3,$4,true,$5)`, [b.workspace_id, contactId, p.phoneOriginal, p.phone, id]);
          await c.query(`INSERT INTO timeline_events (workspace_id, contact_id, type, summary) VALUES ($1,$2,'contact',$3)`, [b.workspace_id, contactId, `Contact created by import (${b.filename})`]);
          r.contactsCreated++;
        } else if (found.length === 1 || sameNamed) {
          const ex = sameNamed ?? found[0]; contactId = ex.id;   // fill blanks only: an import never overwrites what staff or the customer provided
          const fill: Record<string, string> = {}; for (const [k, col, v] of [['first_name', 'first_name', p.firstName], ['last_name', 'last_name', p.lastName], ['company', 'company', p.company], ['email', 'email', p.email]] as const) if (v && !ex[col]) fill[k] = v;
          for (const [k, v] of Object.entries(fill)) await c.query(`UPDATE contacts SET ${k}=$2, updated_at=now() WHERE id=$1`, [contactId, v]);
          const addTags = (p.tags as string[]).filter((t) => !ex.tags.includes(t)); if (addTags.length) await c.query('UPDATE contacts SET tags = tags || $2::text[] WHERE id=$1', [contactId, addTags]);
          applied.filled = fill; applied.tagsAdded = addTags; r.contactsMatched++;
        } else { r.skipped++; continue; }
        if (p.note) { const n = (await c.query(`INSERT INTO notes (workspace_id, contact_id, body) VALUES ($1,$2,$3) RETURNING id`, [b.workspace_id, contactId, `Imported note (${b.filename}): ${p.note}`.slice(0, 5000)])).rows[0].id; applied.noteId = n; }
        if (p.optOut) { await addConsent(c, b, contactId, 'sms_stop', p.optOutAt, `${b.filename} row ${row.row_no}`); r.consentEvents++; }
        await c.query(`UPDATE import_rows SET status='committed', parsed = parsed || $2::jsonb WHERE batch_id=$1 AND row_no=$3`, [id, JSON.stringify({ contactId, applied }), row.row_no]);
      }
    } else if (b.kind === 'consents') {
      for (const row of rows) {
        const p = row.parsed; if (!p) { r.skipped++; continue; }
        const targets = (await resolveContacts(c, b, p.phone, p.phoneOriginal ?? p.phone, null, created));
        if (targets.length > 1 && p.type !== 'sms_stop' && p.type !== 'do_not_text_set') { r.skipped++; continue; }
        for (const t of targets) { await addConsent(c, b, t, p.type, p.at, p.evidence ?? `${b.filename} row ${row.row_no}`); r.consentEvents++; }
        await c.query(`UPDATE import_rows SET status='committed' WHERE batch_id=$1 AND row_no=$2`, [id, row.row_no]);
      }
      r.contactsCreated = created.n;
    } else if (b.kind === 'templates') {
      for (const row of rows) {
        const p = row.parsed; const dupe = (await c.query('SELECT 1 FROM templates WHERE workspace_id=$1 AND lower(name)=lower($2)', [b.workspace_id, p.name])).rowCount; if (dupe) { r.skipped++; continue; }
        const t = (await c.query(`INSERT INTO templates (workspace_id, category, name, created_by, is_active, import_batch_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [b.workspace_id, p.category, p.name, a.userId, row.status === 'valid', id])).rows[0].id;
        await c.query(`INSERT INTO template_versions (template_id, version, body, created_by) VALUES ($1,1,$2,$3)`, [t, p.body, a.userId]); r.templatesCreated++;
        await c.query(`UPDATE import_rows SET status='committed' WHERE batch_id=$1 AND row_no=$2`, [id, row.row_no]);
      }
    } else {
      const ch = (await c.query(`SELECT id FROM channels WHERE workspace_id=$1 AND kind='sms' ORDER BY id LIMIT 1`, [b.workspace_id])).rows[0]; if (!ch) throw new HttpError(409, 'no SMS channel exists to attach imported conversations to');
      const byPhone = new Map<string, typeof rows>(); for (const row of rows) { if (!row.parsed) continue; const l = byPhone.get(row.parsed.phone) ?? []; l.push(row); byPhone.set(row.parsed.phone, l); }
      for (const [phone, list] of byPhone) {
        list.sort((x, y) => x.parsed.at.localeCompare(y.parsed.at) || x.row_no - y.row_no);
        const targets = await resolveContacts(c, b, phone, list[0].parsed.phoneOriginal, list.find((x) => x.parsed.name)?.parsed.name ?? null, created);
        if (targets.length !== 1) { r.skipped += list.length; continue; }
        const contactId = targets[0];
        const ident = (await c.query(`SELECT id FROM contact_identities WHERE contact_id=$1 AND kind='phone' AND normalized=$2 LIMIT 1`, [contactId, phone])).rows[0];
        const pre = (await c.query('SELECT id FROM conversations WHERE workspace_id=$1 AND contact_id=$2 AND channel_id=$3', [b.workspace_id, contactId, ch.id])).rows[0];
        let convId: string; let convNew = false;
        if (pre) convId = pre.id; else {
          // Imported history lands CLOSED and assigned to nobody: it must not appear as work, trigger follow-ups, or notify anyone. A new inbound text reopens it normally.
          convId = (await c.query(`INSERT INTO conversations (workspace_id, contact_id, channel_id, contact_identity_id, status, responsibility, handling_mode, import_batch_id) VALUES ($1,$2,$3,$4,'closed','closed','human',$5) RETURNING id`, [b.workspace_id, contactId, ch.id, ident?.id ?? null, id])).rows[0].id; convNew = true;
        }
        let maxAll = '', maxIn = '', maxOut = '', lastBody = ''; const kw: { type: 'sms_stop' | 'sms_start'; at: string; body: string }[] = [];
        for (const row of list) {
          const p = row.parsed;
          const ins = await c.query(`INSERT INTO messages (workspace_id, conversation_id, direction, sender_type, purpose, body, status, provider, provider_message_id, created_at, source_ts, imported_batch_id)
            VALUES ($1,$2,$3,$4,'conversational',$5,$6,'import',$7,$8,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
            [b.workspace_id, convId, p.direction, p.direction === 'inbound' ? 'customer' : 'staff', p.body, p.direction === 'inbound' ? 'received' : 'delivered', p.key, p.at, id]);
          if (!ins.rowCount) { r.messagesAlreadyPresent++; continue; }
          r.messagesImported++; if (p.at > maxAll) { maxAll = p.at; lastBody = p.body; }
          if (p.direction === 'inbound') { if (p.at > maxIn) maxIn = p.at; const k = classifyKeyword(p.body); if (k === 'stop' || (k === 'start' && p.body.trim().toLowerCase() !== 'yes')) kw.push({ type: k === 'stop' ? 'sms_stop' : 'sms_start', at: p.at, body: p.body }); } else if (p.at > maxOut) maxOut = p.at;
          await c.query(`UPDATE import_rows SET status='committed' WHERE batch_id=$1 AND row_no=$2`, [id, row.row_no]);
        }
        if (maxAll) await c.query(`UPDATE conversations SET last_message_at=GREATEST(COALESCE(last_message_at,$2::timestamptz),$2::timestamptz), last_inbound_at=CASE WHEN $3<>'' THEN GREATEST(COALESCE(last_inbound_at,$3::timestamptz),$3::timestamptz) ELSE last_inbound_at END, last_outbound_at=CASE WHEN $4<>'' THEN GREATEST(COALESCE(last_outbound_at,$4::timestamptz),$4::timestamptz) ELSE last_outbound_at END, last_preview=CASE WHEN $5 THEN $6 ELSE last_preview END WHERE id=$1`, [convId, maxAll, maxIn, maxOut, convNew, lastBody.slice(0, 140)]);
        // Opt-outs in the history are retained: a customer who texted STOP in Kenect stays opted out here (unless a LATER start exists).
        const before = (await c.query('SELECT sms_opted_out FROM contacts WHERE id=$1', [contactId])).rows[0].sms_opted_out;
        for (const k of kw) await addConsent(c, b, contactId, k.type, k.at, `Kenect history message “${k.body.slice(0, 40)}” (${b.filename})`);
        const after = (await c.query('SELECT sms_opted_out FROM contacts WHERE id=$1', [contactId])).rows[0].sms_opted_out; if (after && !before) r.historyOptOutsDetected++;
        await touchSummary(c, b.workspace_id, contactId);
      }
      r.contactsCreated = created.n;
    }
    await c.query(`UPDATE import_batches SET status='committed', committed_at=now(), result=$2 WHERE id=$1`, [id, JSON.stringify(r)]);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'import.commit', targetType: 'import_batch', targetId: id, meta: { kind: b.kind, ...r } });
    await publish(c, a.workspaceId, 'import.committed', { batchId: id });
    return r;
  });
  return { ok: true, result: res };
}

// ---------------- rollback ----------------
/**
 * Undo what a committed batch CREATED. Deliberately conservative:
 *  - opt-outs (consent events and the opted-out flag) are never undone; contacts carrying one are kept (keptForOptOut)
 *  - a contact, conversation or template is kept (and reported) if anyone has used it since the import
 *  - fields filled and tags added on pre-existing contacts are reverted only if still unchanged
 */
export async function rollbackBatch(a: Actor, id: string, confirm: string) {
  admin(a); if (confirm !== 'ROLLBACK') throw new HttpError(400, 'confirmation required: send {"confirm":"ROLLBACK"}');
  return tx(async (c) => {
    const b = await loadBatch(c, a, id, true); if (b.status !== 'committed') throw new HttpError(409, `import is ${b.status}; only a committed import can be rolled back`);
    const res = { messagesRemoved: 0, conversationsRemoved: 0, contactsRemoved: 0, keptForOptOut: 0, keptBecauseUsed: 0, fieldsReverted: 0, templatesRemoved: 0, templatesDeactivated: 0 };
    res.messagesRemoved = (await c.query('DELETE FROM messages WHERE imported_batch_id=$1', [id])).rowCount ?? 0;
    const convs = (await c.query(`SELECT id, contact_id FROM conversations WHERE import_batch_id=$1`, [id])).rows;
    for (const cv of convs) {
      const used = (await c.query(`SELECT 1 FROM messages WHERE conversation_id=$1 LIMIT 1`, [cv.id])).rowCount || (await c.query(`SELECT 1 FROM tasks WHERE conversation_id=$1 UNION ALL SELECT 1 FROM scheduled_sends WHERE conversation_id=$1 LIMIT 1`, [cv.id])).rowCount;
      if (used) { res.keptBecauseUsed++; continue; }
      await c.query('DELETE FROM conversations WHERE id=$1', [cv.id]); res.conversationsRemoved++;
    }
    for (const row of (await c.query(`SELECT parsed FROM import_rows WHERE batch_id=$1 AND status='committed' AND parsed ? 'applied'`, [id])).rows) {
      const ap = row.parsed.applied ?? {}; const cid = row.parsed.contactId as string;
      for (const [k, v] of Object.entries((ap.filled ?? {}) as Record<string, string>)) { const u = await c.query(`UPDATE contacts SET ${k}=NULL WHERE id=$1 AND ${k}=$2`, [cid, v]); res.fieldsReverted += u.rowCount ?? 0; }
      if ((ap.tagsAdded ?? []).length) await c.query(`UPDATE contacts SET tags = ARRAY(SELECT t FROM unnest(tags) t WHERE NOT (t = ANY($2::text[]))) WHERE id=$1`, [cid, ap.tagsAdded]);
      if (ap.noteId) await c.query('DELETE FROM notes WHERE id=$1', [ap.noteId]);
    }
    for (const ct of (await c.query(`SELECT id, sms_opted_out, do_not_text FROM contacts WHERE import_batch_id=$1`, [id])).rows) {
      if (ct.sms_opted_out || ct.do_not_text) { res.keptForOptOut++; continue; }
      const used = (await c.query(`SELECT 1 FROM conversations WHERE contact_id=$1 UNION ALL SELECT 1 FROM tasks WHERE contact_id=$1 UNION ALL SELECT 1 FROM notes WHERE contact_id=$1 UNION ALL SELECT 1 FROM consent_events WHERE contact_id=$1 AND import_batch_id IS DISTINCT FROM $2 UNION ALL SELECT 1 FROM payment_requests WHERE contact_id=$1 LIMIT 1`, [ct.id, id])).rowCount;
      if (used) { res.keptBecauseUsed++; continue; }
      await c.query('DELETE FROM contacts WHERE id=$1', [ct.id]); res.contactsRemoved++;   // identities, timeline, summaries cascade
    }
    for (const t of (await c.query('SELECT id, current_version FROM templates WHERE import_batch_id=$1', [id])).rows) {
      await c.query('SAVEPOINT tpl');
      try { if (t.current_version > 1) throw new Error('edited'); await c.query('DELETE FROM templates WHERE id=$1', [t.id]); res.templatesRemoved++; }
      catch { await c.query('ROLLBACK TO SAVEPOINT tpl'); await c.query('UPDATE templates SET is_active=false WHERE id=$1', [t.id]); res.templatesDeactivated++; }
    }
    await c.query(`UPDATE import_batches SET status='rolled_back', rolled_back_at=now(), result = COALESCE(result,'{}'::jsonb) || jsonb_build_object('rollback', $2::jsonb) WHERE id=$1`, [id, JSON.stringify(res)]);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'import.rollback', targetType: 'import_batch', targetId: id, meta: res });
    return { ok: true, result: res };
  });
}
