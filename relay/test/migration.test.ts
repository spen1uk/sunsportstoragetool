import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { actor, drain, inbound, resetDb, type Seeded } from './helpers.js';
import { buildApp } from '../src/server/app.js';
import { parseCsv, toCsv } from '../src/migration/csv.js';
import { convertTokens, parseDirection, parseTimestamp, suggestMapping } from '../src/migration/mapping.js';
import * as imp from '../src/migration/imports.js';
import * as plan from '../src/migration/plan.js';
import { createContact } from '../src/domain/contacts.js';
import { changeConsent } from '../src/domain/contacts.js';
import { getThread, listConversations, addNote } from '../src/domain/conversations.js';
import { getSummary } from '../src/domain/summary.js';
import { queueOutbound } from '../src/domain/messaging.js';
import { buildAnalytics } from '../src/domain/analytics.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/kenect-synthetic/${n}`, import.meta.url));
let s: Seeded; let owner: ReturnType<typeof actor>; let admin: ReturnType<typeof actor>; let sam: ReturnType<typeof actor>;
beforeEach(async () => { s = await resetDb(); owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; admin = { ...owner, role: 'admin' }; sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; });
afterAll(() => pool.end());

const upload = (kind: string, data: Buffer | string, a = owner, filename = `${kind}.csv`) => imp.uploadBatch(a, { kind, filename, data: Buffer.from(data) });
const stage = async (kind: string, data: Buffer | string, opts: { mapping?: Record<string, string>; options?: object } = {}) => { const u = await upload(kind, data); const b = await imp.stageBatch(owner, u.id, { mapping: opts.mapping ?? u.suggestedMapping, options: opts.options }); return { id: u.id, b, u }; };
const commit = (id: string) => imp.commitBatch(owner, id, 'COMMIT');
const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);

describe('CSV, mapping and parsing units', () => {
  it('parses quotes, embedded newlines, CRLF, BOM, semicolons; rejects truncated quotes', () => {
    const c = parseCsv('﻿Name,Note\r\n"Smith, J","said ""hi""\nbye"\r\nLee,ok\r\n'); expect(c.headers).toEqual(['Name', 'Note']); expect(c.rows).toEqual([['Smith, J', 'said "hi"\nbye'], ['Lee', 'ok']]);
    expect(parseCsv('a;b\n1;2').rows).toEqual([['1', '2']]); expect(parseCsv('a\tb\n1\t2').delimiter).toBe('\t');
    expect(() => parseCsv('a,b\n"unterminated,1')).toThrow(/unterminated/); expect(() => parseCsv('')).toThrow(/empty/);
  });
  it('report CSV neutralises spreadsheet formulas', () => { expect(toCsv([['=1+1', '+cmd', '-x', '@y', 'ok,comma']])).toBe(`'=1+1,'+cmd,'-x,'@y,"ok,comma"\r\n`); });
  it('timestamps: offsets, epoch, local formats in a zone, DST gap, impossible dates', () => {
    expect(parseTimestamp('2026-03-01T09:15:00-06:00', 'UTC')!.toISOString()).toBe('2026-03-01T15:15:00.000Z');
    expect(parseTimestamp('2026-03-01 09:15:00', 'America/Chicago')!.toISOString()).toBe('2026-03-01T15:15:00.000Z');
    expect(parseTimestamp('2026-03-01 09:15:00', 'UTC')!.toISOString()).toBe('2026-03-01T09:15:00.000Z');
    expect(parseTimestamp('3/2/2026 4:15 PM', 'America/Chicago')!.toISOString()).toBe('2026-03-02T22:15:00.000Z');
    expect(parseTimestamp('12/31/2025 12:05 AM', 'UTC')!.toISOString()).toBe('2025-12-31T00:05:00.000Z');
    expect(parseTimestamp('1772300000', 'UTC')!.toISOString()).toBe('2026-02-28T17:33:20.000Z');
    expect(parseTimestamp('2026-03-08 02:30', 'America/Chicago')!.toISOString()).toBe('2026-03-08T08:30:00.000Z');   // spring-forward gap → first valid instant
    for (const bad of ['', 'not a date', '2026-02-30 10:00', '13/40/2026', '2026-03-01 25:00', '3/1/2026 13:00 PM']) expect(parseTimestamp(bad, 'UTC'), bad).toBeNull();
  });
  it('directions, token conversion and mapping suggestions never guess silently', () => {
    expect(parseDirection('Received')).toBe('inbound'); expect(parseDirection('SENT')).toBe('outbound'); expect(parseDirection('agent→customer')).toBeNull(); expect(parseDirection('agent→customer', { 'agent→customer': 'outbound' })).toBe('outbound');
    expect(convertTokens('Hi [First Name], {{business_name}} / {last_name} / %FIRST_NAME%').text).toBe('Hi {{first_name}}, {{business_name}} / {{last_name}} / {{first_name}}');
    expect(convertTokens('Hi <<Nickname>> [Reply STOP] {{first_name}}').unmapped).toEqual(['<<Nickname>>', '[Reply STOP]']);
    expect(suggestMapping('contacts', ['Name', 'Mobile', 'E-mail', 'Opted Out']).phone).toBe('Mobile');
    expect(suggestMapping('messages', ['Contact Number', 'Direction', 'Message', 'Date Sent'])).toMatchObject({ phone: 'Contact Number', direction: 'Direction', body: 'Message', timestamp: 'Date Sent' });
  });
});

describe('upload & staging never touch customer data', () => {
  it('preserves the original bytes byte-for-byte with a checksum; admin only; malformed files are refused', async () => {
    const data = fx('contacts.csv'); const u = await upload('contacts', data);
    const row = (await pool.query('SELECT file_sha256, file_key, status FROM import_batches WHERE id=$1', [u.id])).rows[0];
    expect(row.file_sha256).toBe(createHash('sha256').update(data).digest('hex')); expect(row.status).toBe('uploaded');
    expect(Buffer.compare(await readFile(path.join(config.mediaDir, row.file_key)), data)).toBe(0);
    await expect(upload('contacts', data, sam)).rejects.toThrow(/owner or admin/); await expect(upload('widgets', data)).rejects.toThrow(/kind must be/);
    await expect(upload('contacts', 'a,b\n"x')).rejects.toThrow(/not a readable CSV/); await expect(upload('contacts', 'a,a\n1,2')).rejects.toThrow(/duplicate column/); await expect(upload('contacts', '')).rejects.toThrow(/empty/);
  });
  it('mapping problems are reported, not guessed', async () => {
    const u = await upload('contacts', fx('contacts.csv'));
    await expect(imp.stageBatch(owner, u.id, { mapping: {} })).rejects.toMatchObject({ extra: { problems: [expect.stringMatching(/Phone/)] } });
    await expect(imp.stageBatch(owner, u.id, { mapping: { phone: 'Nope' } })).rejects.toMatchObject({ extra: { problems: [expect.stringMatching(/not in the file/)] } });
    await expect(imp.stageBatch(owner, u.id, { mapping: { phone: 'Mobile', email: 'Mobile' } })).rejects.toMatchObject({ extra: { problems: [expect.stringMatching(/two fields/)] } });
  });
  it('contacts preview: classifies every row, counts match the file, and writes nothing to contacts', async () => {
    await createContact(owner, { firstName: 'Existing', lastName: 'Match', phone: '(262) 555-0140' });
    const before = await n('SELECT count(*) AS n FROM contacts');
    const { b } = await stage('contacts', fx('contacts.csv'));
    expect(b.counts).toMatchObject({ total: 10, valid: 6, error: 2, duplicate: 1, review: 1, contactsToCreate: 6, contactsMatched: 1, optOuts: 1 });
    expect(b.counts.byReason).toMatchObject({ missing_phone: 1, invalid_phone: 1, duplicate_in_file: 1, shared_number_different_name: 1 }); expect(b.counts.warnings).toMatchObject({ invalid_email_ignored: 1 });
    expect(await n('SELECT count(*) AS n FROM contacts')).toBe(before); expect(await n('SELECT count(*) AS n FROM consent_events')).toBe(0);
    const reasons = (await imp.listRows(owner, b.id, { status: 'error' })).map((r: { reason: string }) => r.reason); expect(reasons.join('|')).toMatch(/missing_phone.*invalid_phone|invalid_phone.*missing_phone/);
  });
  it('warns loudly when a column that looks like an opt-out flag is not mapped (so opt-outs are not silently dropped)', async () => {
    const u = await upload('contacts', 'Name,Phone,SMS Status\nA B,(414) 555-0290,unsubscribed\n'); const b = await imp.stageBatch(owner, u.id, { mapping: { phone: 'Phone', fullName: 'Name' } });
    expect(Object.keys(b.counts.warnings)).toEqual([expect.stringMatching(/possible_optout_column_not_mapped: SMS Status/)]);
  });
  it('re-staging with another mapping replaces the preview; committed imports cannot be re-staged', async () => {
    const { id } = await stage('contacts', fx('contacts.csv')); const again = await imp.stageBatch(owner, id, { mapping: { phone: 'Mobile', fullName: 'Name' } }); expect(again.counts.total).toBe(10);
    expect(await n('SELECT count(*) AS n FROM import_rows WHERE batch_id=$1', [id])).toBe(10);
    await commit(id); await expect(imp.stageBatch(owner, id, { mapping: { phone: 'Mobile' } })).rejects.toThrow(/committed/);
  });
});

describe('contacts import', () => {
  it('commit needs the typed confirmation and a staged batch; creates, matches (fill blanks only), flags shared numbers, keeps opt-outs', async () => {
    const existing = await createContact(owner, { firstName: 'Existing', lastName: 'Match', phone: '(262) 555-0140' });
    const { id } = await stage('contacts', fx('contacts.csv'));
    await expect(imp.commitBatch(owner, id, 'yes')).rejects.toThrow(/confirmation/);
    const up = await upload('contacts', fx('contacts.csv')); await expect(commit(up.id)).rejects.toThrow(/staged/);
    const r = await commit(id); expect(r.result).toMatchObject({ contactsCreated: 6, contactsMatched: 1, consentEvents: 1 });
    await expect(commit(id)).rejects.toThrow(/committed/);
    const ex = (await pool.query('SELECT first_name, last_name, email, tags FROM contacts WHERE id=$1', [existing])).rows[0]; expect(ex).toMatchObject({ first_name: 'Existing', last_name: 'Match', email: 'existing@example.test' }); expect(ex.tags).toContain('imported-list');
    const casey = (await pool.query(`SELECT c.*, (SELECT body FROM notes WHERE contact_id=c.id) AS note FROM contacts c WHERE first_name='Casey'`)).rows[0]; expect(casey.tags).toEqual(expect.arrayContaining(['imported', 'boat-show', 'hot'])); expect(casey.note).toContain('call after 5'); expect(casey.marketing_status).toBe('opt_in_not_received');   // import never grants marketing consent
    expect((await pool.query(`SELECT tags FROM contacts WHERE first_name='Alex'`)).rows[0].tags).toEqual(expect.arrayContaining(['needs-review']));
    expect(await n(`SELECT count(*) AS n FROM contact_identities WHERE normalized='+14145550103'`)).toBe(2);   // shared number: two separate people, not merged
    expect((await pool.query(`SELECT email FROM contacts WHERE first_name='Bad'`)).rows[0].email).toBeNull();
    expect((await pool.query(`SELECT last_name FROM contacts WHERE first_name='Zoë'`)).rows[0].last_name).toBe('Müller');
    const pat = (await pool.query(`SELECT id, sms_opted_out FROM contacts WHERE first_name='Pat'`)).rows[0]; expect(pat.sms_opted_out).toBe(true);
    const ce = (await pool.query(`SELECT source, occurred_at, import_batch_id FROM consent_events WHERE contact_id=$1`, [pat.id])).rows[0]; expect(ce.source).toBe('import'); expect(new Date(ce.occurred_at).toISOString()).toBe('2026-03-02T22:15:00.000Z'); expect(ce.import_batch_id).toBe(id);
  });
  it('an imported opt-out is enforced by the normal send pipeline; imports start no jobs and notify nobody', async () => {
    const { id } = await stage('contacts', fx('contacts.csv')); await commit(id);
    const pat = (await pool.query(`SELECT c.id, (SELECT id FROM conversations WHERE contact_id=c.id) AS conv FROM contacts c WHERE first_name='Pat'`)).rows[0];
    const { openConversationFor } = await import('../src/domain/contacts.js'); const conv = await openConversationFor(owner, pat.id);
    const r = await queueOutbound({ workspaceId: s.workspaceId, conversationId: conv, body: 'hello', senderType: 'staff', senderUserId: owner.userId, idempotencyKey: 'mig-pat-1' }); expect(r).toMatchObject({ ok: false, reason: 'sms_opted_out' });
    expect(await n(`SELECT count(*) AS n FROM jobs WHERE kind IN ('send_message','auto_respond','workflow_event','scheduled_send')`)).toBe(0); expect(await n('SELECT count(*) AS n FROM notifications')).toBe(0);
  });
  it('an opt-out on a duplicate row is never lost to de-duplication', async () => {
    const { id, b } = await stage('contacts', 'Name,Phone,Stop\nPat Lee,414-555-0102,\nPat Lee,(414) 555-0102,yes\n'); expect(b.counts).toMatchObject({ valid: 1, duplicate: 1, optOuts: 1 });
    await commit(id); expect((await pool.query(`SELECT sms_opted_out FROM contacts WHERE first_name='Pat'`)).rows[0].sms_opted_out).toBe(true);
  });
  it('re-importing the same file creates no duplicates', async () => {
    const a1 = await stage('contacts', fx('contacts.csv')); await commit(a1.id); const total = await n('SELECT count(*) AS n FROM contacts');
    const a2 = await stage('contacts', fx('contacts.csv')); expect(a2.b.counts.contactsToCreate).toBe(0); await commit(a2.id);   // everything now matches (the shared number is ambiguous and skipped: nothing guessed)
    expect(await n('SELECT count(*) AS n FROM contacts')).toBe(total);
  });
  it('rollback removes what the batch created, reverts blanks it filled, deletes its tags/notes — but keeps opted-out contacts and anything staff touched', async () => {
    const existing = await createContact(owner, { firstName: 'Existing', lastName: 'Match', phone: '(262) 555-0140' });
    const { id } = await stage('contacts', fx('contacts.csv')); await commit(id);
    const jordan = (await pool.query(`SELECT id FROM contacts WHERE first_name='Jordan'`)).rows[0].id; await pool.query(`INSERT INTO notes (workspace_id, contact_id, body) VALUES ($1,$2,'staff wrote this')`, [s.workspaceId, jordan]);
    await expect(imp.rollbackBatch(owner, id, 'nope')).rejects.toThrow(/confirmation/);
    const r = (await imp.rollbackBatch(owner, id, 'ROLLBACK')).result; expect(r).toMatchObject({ keptForOptOut: 1, keptBecauseUsed: 1, fieldsReverted: 1 }); expect(r.contactsRemoved).toBe(4);
    expect((await pool.query('SELECT email, tags FROM contacts WHERE id=$1', [existing])).rows[0]).toMatchObject({ email: null, tags: [] });
    expect(await n(`SELECT count(*) AS n FROM contacts WHERE first_name='Pat'`)).toBe(1); expect(await n(`SELECT count(*) AS n FROM contacts WHERE first_name='Casey'`)).toBe(0); expect(await n(`SELECT count(*) AS n FROM contacts WHERE id=$1`, [jordan])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM consent_events WHERE import_batch_id=$1`, [id])).toBe(1);   // the opt-out evidence stays
    expect((await imp.getBatch(owner, id)).status).toBe('rolled_back'); await expect(imp.rollbackBatch(owner, id, 'ROLLBACK')).rejects.toThrow(/committed/);
  });
  it('the not-imported report lists every skipped row with its reason and neutralises formulas', async () => {
    const { id } = await stage('contacts', 'Name,Phone\n=HYPERLINK("http://evil"),12\nOk Person,(414) 555-0150\n'); const rep = await imp.errorReport(owner, id);
    expect(rep.csv).toContain(`'=HYPERLINK`); expect(rep.csv).toContain('invalid_phone'); expect(rep.csv).not.toContain('Ok Person'); expect(rep.csv.split('\r\n')[0]).toBe('row,outcome,reason,Name,Phone');
  });
});

describe('message history import', () => {
  it('preview and commit: original timestamps and order kept; closed, unassigned, no unread, no follow-ups, no notifications, excluded from analytics', async () => {
    const { id, b } = await stage('messages', fx('messages.csv'), { options: { timezone: 'America/Chicago' } });
    expect(b.counts).toMatchObject({ total: 16, valid: 11, error: 4, duplicate: 1, inbound: 7, outbound: 4, });
    expect(b.counts.outOfOrder).toBeGreaterThan(0); expect(b.counts.dateRange[0]).toBe('2026-01-09T14:00:00.000Z');
    expect(Object.keys(b.counts.byReason)).toEqual(expect.arrayContaining(['unknown_direction', 'bad_timestamp', 'empty_message', 'timestamp_in_future', 'duplicate_in_file']));
    expect(await n('SELECT count(*) AS n FROM messages')).toBe(0);
    const r = (await commit(id)).result; expect(r).toMatchObject({ messagesImported: 11, messagesAlreadyPresent: 0 });
    const convs = (await pool.query(`SELECT c.status, c.responsibility, c.handling_mode, c.assignee_user_id, c.import_batch_id FROM conversations c`)).rows; expect(convs.length).toBe(5);
    for (const c of convs) expect(c).toMatchObject({ status: 'closed', responsibility: 'closed', handling_mode: 'human', assignee_user_id: null, import_batch_id: id });
    const casey = (await pool.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.first_name='Casey'`)).rows[0].id;
    const t = await getThread(owner, casey); expect(t.messages.map((m) => m.body)).toEqual(['Hi, is the 21 ft pontoon still available?', 'Yes! Want to see it Saturday?', 'Sounds good 👍 budget is about $28k', 'Great. See you at 10.']);
    expect(new Date(t.messages[0].created_at).toISOString()).toBe('2026-03-01T15:15:00.000Z'); expect(t.messages[0].imported_batch_id).toBe(id); expect(t.messages[1]).toMatchObject({ direction: 'outbound', status: 'delivered', sender_type: 'staff' });
    const old = (await pool.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE ct.first_name='Old'`)).rows[0].id;
    expect((await getThread(owner, old)).messages.map((m) => m.body)).toEqual(['Earlier message listed last', 'Earlier message listed last', 'Hi, this is Sun Sport Marine.']);   // listed out of order, shown in time order
    expect((await listConversations(owner, { status: 'open' })).length).toBe(0); expect((await listConversations(owner, {})).every((c: { unread: number }) => c.unread === 0)).toBe(true);
    expect(await n(`SELECT count(*) AS n FROM jobs WHERE kind NOT IN ('maintenance','workflow_scan','connection_scan','payment_reconcile','summarize_contact')`)).toBe(0); expect(await n('SELECT count(*) AS n FROM notifications')).toBe(0);
    const an = await buildAnalytics(owner, { from: new Date('2026-01-01'), to: new Date(), tz: 'America/Chicago' }); expect(an.volume.totals).toMatchObject({ inbound: 0, outbound: 0 });
    expect(await n(`SELECT count(*) AS n FROM contacts WHERE import_batch_id=$1`, [id])).toBe(5);
  });
  it('history is idempotent: importing the same file again adds nothing', async () => {
    const a1 = await stage('messages', fx('messages.csv'), { options: { timezone: 'America/Chicago' } }); await commit(a1.id);
    const a2 = await stage('messages', fx('messages.csv'), { options: { timezone: 'America/Chicago' } }); expect(a2.b.counts).toMatchObject({ valid: 0, duplicate: 12 });   // 11 already imported + the 1 in-file duplicate
  });
  it('the timezone for offset-less timestamps is explicit and changes the stored instant', async () => {
    const csv = 'Phone,Dir,Text,When\n(414) 555-0160,in,hello,2026-03-01 09:00\n';
    const a = await stage('messages', csv, { options: { timezone: 'UTC' } }); await commit(a.id);
    const t = (await pool.query(`SELECT created_at FROM messages`)).rows[0].created_at; expect(new Date(t).toISOString()).toBe('2026-03-01T09:00:00.000Z');
    const b = await stage('messages', csv, { options: { timezone: 'America/Chicago' } }); expect(b.b.counts.valid).toBe(1); expect(b.b.counts.timezoneAssumed).toBe('America/Chicago');   // a different instant → a different message, not a duplicate
  });
  it('a STOP in the imported history keeps that customer opted out; a later START clears it; "yes" never counts as START', async () => {
    const csv = 'Phone,Dir,Text,When\n(414) 555-0170,in,STOP,2026-01-01 10:00\n(414) 555-0171,in,STOP,2026-01-01 10:00\n(414) 555-0171,in,START,2026-02-01 10:00\n(414) 555-0172,in,STOP,2026-01-01 10:00\n(414) 555-0172,in,yes,2026-02-01 10:00\n';
    const { id, b } = await stage('messages', csv, { options: { timezone: 'UTC' } }); expect(b.counts.optOuts).toBe(3); const r = (await commit(id)).result; expect(r.historyOptOutsDetected).toBe(2);
    const st = async (p: string) => (await pool.query(`SELECT c.sms_opted_out FROM contacts c JOIN contact_identities i ON i.contact_id=c.id WHERE i.normalized=$1`, [p])).rows[0].sms_opted_out;
    expect(await st('+14145550170')).toBe(true); expect(await st('+14145550171')).toBe(false); expect(await st('+14145550172')).toBe(true);
    const ev = (await pool.query(`SELECT evidence FROM consent_events WHERE type='sms_stop' LIMIT 1`)).rows[0].evidence; expect(ev).toMatch(/Kenect history message/);
  });
  it('numbers shared by several existing contacts are not guessed: skipped and reported', async () => {
    await createContact(owner, { firstName: 'A', phone: '(414) 555-0180' }); await createContact(owner, { firstName: 'B', phone: '(414) 555-0180' });
    const { id, b } = await stage('messages', 'Phone,Dir,Text,When\n(414) 555-0180,in,who am I,2026-01-01 10:00\n', { options: { timezone: 'UTC' } }); expect(b.counts).toMatchObject({ review: 1, valid: 0 });
    await commit(id); expect(await n('SELECT count(*) AS n FROM messages')).toBe(0);
  });
  it('imported history merges with live traffic: ordered by time, new inbound reopens the thread normally, and summaries disclose coverage', async () => {
    const live = await createContact(owner, { firstName: 'Live', phone: '(414) 555-0190' }); const { openConversationFor } = await import('../src/domain/contacts.js'); const conv = await openConversationFor(owner, live);
    await inbound('(414) 555-0190', 'live message today'); await drain();
    const { id } = await stage('messages', 'Phone,Dir,Text,When\n(414) 555-0190,in,old kenect message,2026-01-02 10:00\n(414) 555-0190,out,old reply,2026-01-02 10:05\n', { options: { timezone: 'UTC' } }); await commit(id);
    const t = await getThread(owner, conv); expect(t.messages.map((m) => m.body)).toEqual(['old kenect message', 'old reply', 'live message today']);
    expect((await pool.query('SELECT status, responsibility FROM conversations WHERE id=$1', [conv])).rows[0]).toMatchObject({ status: 'open', responsibility: 'needs_our_reply' });   // live state untouched by the import
    expect((await getSummary(owner, live)).importCoverage).toMatch(/Includes 2 imported messages dated 2026-01-02 to 2026-01-02/);
    // a closed imported thread reopens on a new inbound
    const csv2 = 'Phone,Dir,Text,When\n(414) 555-0191,in,old one,2026-01-02 10:00\n'; const s2 = await stage('messages', csv2, { options: { timezone: 'UTC' } }); await commit(s2.id);
    await inbound('(414) 555-0191', 'back again'); const c2 = (await pool.query(`SELECT c.status, c.responsibility FROM conversations c JOIN contact_identities i ON i.contact_id=c.contact_id WHERE i.normalized='+14145550191'`)).rows[0]; expect(c2).toMatchObject({ status: 'open', responsibility: 'needs_our_reply' });
  });
  it('contacts from a contact-list import with no history say so in their summary', async () => {
    const { id } = await stage('contacts', 'Name,Phone\nList Only,(414) 555-0195\n'); await commit(id);
    const cid = (await pool.query(`SELECT id FROM contacts WHERE first_name='List'`)).rows[0].id; expect((await getSummary(owner, cid)).importCoverage).toMatch(/earlier text history was not imported/);
    const plain = await createContact(owner, { firstName: 'Plain', phone: '(414) 555-0196' }); expect((await getSummary(owner, plain)).importCoverage).toBeNull();
  });
  it('rollback removes imported messages, empty imported conversations and contacts it created — but retains an opt-out found in history', async () => {
    const csv = 'Phone,Dir,Text,When\n(414) 555-0200,in,hello,2026-01-01 10:00\n(414) 555-0201,in,STOP,2026-01-01 10:00\n';
    const { id } = await stage('messages', csv, { options: { timezone: 'UTC' } }); await commit(id);
    const r = (await imp.rollbackBatch(owner, id, 'ROLLBACK')).result; expect(r).toMatchObject({ messagesRemoved: 2, conversationsRemoved: 2, contactsRemoved: 1, keptForOptOut: 1 });
    expect(await n('SELECT count(*) AS n FROM messages')).toBe(0); expect(await n(`SELECT count(*) AS n FROM contacts WHERE sms_opted_out`)).toBe(1);
  });
  it('rollback keeps a conversation staff have used since the import', async () => {
    const { id } = await stage('messages', 'Phone,Dir,Text,When\n(414) 555-0210,in,hello,2026-01-01 10:00\n', { options: { timezone: 'UTC' } }); await commit(id);
    const conv = (await pool.query('SELECT id FROM conversations')).rows[0].id; await addNote(owner, conv, 'called them'); await pool.query(`INSERT INTO tasks (workspace_id, title, assignee_user_id, created_by, conversation_id) VALUES ($1,'t',$2,$2,$3)`, [s.workspaceId, s.users.owner, conv]);
    const r = (await imp.rollbackBatch(owner, id, 'ROLLBACK')).result; expect(r.keptBecauseUsed).toBeGreaterThanOrEqual(1); expect(await n('SELECT count(*) AS n FROM conversations')).toBe(1);
  });
  it('needs an SMS channel to attach history to', async () => {
    const { id } = await stage('messages', 'Phone,Dir,Text,When\n(414) 555-0220,in,hello,2026-01-01 10:00\n', { options: { timezone: 'UTC' } }); await pool.query('DELETE FROM channels'); await expect(commit(id)).rejects.toThrow(/no SMS channel/);
    expect((await imp.getBatch(owner, id)).status).toBe('staged');   // failed commit leaves nothing behind
  });
});

describe('opt-out / consent import', () => {
  it('stages with reasons; applies stop; opt-in style events need evidence; never grants marketing consent from a bare number', async () => {
    const { id, b } = await stage('consents', fx('consents.csv')); expect(b.counts).toMatchObject({ total: 5, valid: 3, error: 2 }); expect(Object.keys(b.counts.byReason)).toEqual(expect.arrayContaining(['unknown_action', 'marketing_opt_in_requires_evidence']));
    await commit(id); const row = async (p: string) => (await pool.query(`SELECT c.sms_opted_out, c.marketing_status, c.tags FROM contacts c JOIN contact_identities i ON i.contact_id=c.id WHERE i.normalized=$1`, [p])).rows[0];
    expect(await row('+14145550120')).toMatchObject({ sms_opted_out: true }); expect(await row('+14145550121')).toMatchObject({ sms_opted_out: false }); expect(await row('+14145550123')).toMatchObject({ marketing_status: 'opt_in' });
    expect((await pool.query(`SELECT evidence FROM consent_events WHERE type='marketing_opt_in'`)).rows[0].evidence).toBe('Website form 2026-02-01');
    expect((await row('+14145550120')).tags).toContain('imported');   // an opt-out for an unknown number is still retained
  });
  it('an imported START can never override a newer STOP; a genuinely newer START can', async () => {
    const c = await createContact(owner, { firstName: 'Stopper', phone: '(414) 555-0230' }); await changeConsent(owner, c, 'sms_stop', 'texted STOP');
    const old = await stage('consents', 'Phone,Action,Date\n(414) 555-0230,start,2020-01-01\n'); await commit(old.id);
    expect((await pool.query('SELECT sms_opted_out FROM contacts WHERE id=$1', [c])).rows[0].sms_opted_out).toBe(true);
    const future = await upload('consents', 'Phone,Action,Date\n(414) 555-0230,start,2999-01-01\n'); expect((await imp.stageBatch(owner, future.id, { mapping: future.suggestedMapping })).counts.byReason).toMatchObject({ timestamp_in_future: 1 });
    expect((await pool.query('SELECT sms_opted_out FROM contacts WHERE id=$1', [c])).rows[0].sms_opted_out).toBe(true);
  });
  it('a STOP applies to every contact sharing the number', async () => {
    await createContact(owner, { firstName: 'A', phone: '(414) 555-0240' }); await createContact(owner, { firstName: 'B', phone: '(414) 555-0240' });
    const { id } = await stage('consents', 'Phone,Action\n(414) 555-0240,stop\n'); await commit(id); expect(await n(`SELECT count(*) AS n FROM contacts WHERE sms_opted_out`)).toBe(2);
  });
  it('opt-outs are never rolled back: rolling back a consent batch keeps the contact and its opt-out', async () => {
    const { id } = await stage('consents', 'Phone,Action\n(414) 555-0250,stop\n'); await commit(id); const r = (await imp.rollbackBatch(owner, id, 'ROLLBACK')).result;
    expect(r.keptForOptOut).toBe(1); expect(await n(`SELECT count(*) AS n FROM contacts WHERE sms_opted_out`)).toBe(1);
  });
});

describe('template import', () => {
  it('converts known merge tokens, flags unknown ones for review (inactive), skips duplicates, rolls back', async () => {
    const { id, b } = await stage('templates', fx('templates.csv')); expect(b.counts).toMatchObject({ total: 4, valid: 1, review: 2, duplicate: 1 });
    const r = (await commit(id)).result; expect(r.templatesCreated).toBe(3);
    const t = (await pool.query(`SELECT t.name, t.is_active, v.body FROM templates t JOIN template_versions v ON v.template_id=t.id WHERE t.import_batch_id=$1 ORDER BY t.name`, [id])).rows;
    expect(t.find((x) => x.name === 'Welcome')).toMatchObject({ is_active: true, body: 'Hi {{first_name}}, thanks for contacting {{business_name}}!' }); expect(t.find((x) => x.name === 'Weird')).toMatchObject({ is_active: false }); expect(t.find((x) => x.name === 'Directions').body).toContain('%BUSINESS%');
    const again = await stage('templates', fx('templates.csv')); expect(again.b.counts.duplicate).toBeGreaterThanOrEqual(1); await commit(again.id);
    expect(await n(`SELECT count(*) AS n FROM templates WHERE lower(name)='welcome'`)).toBe(1);
    expect((await imp.rollbackBatch(owner, id, 'ROLLBACK')).result.templatesRemoved).toBe(3);
  });
});

describe('HTTP', () => {
  it('upload → stage → commit through the API; staff are refused', async () => {
    const app = await buildApp();
    const login = async (email: string) => String((await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email, password: 'test-password-123' } })).headers['set-cookie']).split(';')[0];
    const cookie = await login('owner@demo.relay.test'); const h = { cookie, 'x-relay-csrf': '1' };
    const boundary = '----relaytest'; const body = `--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\ncontacts\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.csv"\r\nContent-Type: text/csv\r\n\r\nName,Phone\r\nHttp Person,(414) 555-0260\r\n--${boundary}--\r\n`;
    const up = await app.inject({ method: 'POST', url: '/api/migration/imports', headers: { ...h, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body }); expect(up.statusCode).toBe(200);
    const u = up.json(); expect(u.suggestedMapping.phone).toBe('Phone');
    const st = await app.inject({ method: 'POST', url: `/api/migration/imports/${u.id}/stage`, headers: h, payload: { mapping: u.suggestedMapping } }); expect(st.json().counts.valid).toBe(1);
    expect((await app.inject({ method: 'POST', url: `/api/migration/imports/${u.id}/commit`, headers: h, payload: { confirm: 'no' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/migration/imports/${u.id}/commit`, headers: h, payload: { confirm: 'COMMIT' } })).json().result.contactsCreated).toBe(1);
    const csvRes = await app.inject({ method: 'GET', url: `/api/migration/imports/${u.id}/not-imported.csv`, headers: h }); expect(csvRes.headers['content-type']).toMatch(/text\/csv/);
    const staff = await login('sam@demo.relay.test'); for (const [m, url] of [['GET', '/api/migration/imports'], ['GET', '/api/migration/checklist'], ['POST', `/api/migration/imports/${u.id}/commit`]] as const) expect((await app.inject({ method: m, url, headers: { cookie: staff, 'x-relay-csrf': '1' }, payload: m === 'POST' ? { confirm: 'COMMIT' } : undefined })).statusCode).toBe(403);
    await app.close();
  });
});

describe('cutover checklist', () => {
  const pass = (a: typeof owner, key: string, evidence = 'verified by test') => plan.setItem(a, key, { status: 'passed', evidence });
  /** Walk the checklist in order as the owner, waiving only where Relay's own check can't be satisfied in a test. */
  async function walk(until?: string) {
    for (const d of plan.ITEMS) {
      if (d.key === until) return;
      try { await pass(owner, d.key); } catch (e) { const x = e as { status?: number; extra?: { waitUntil?: string } }; if (x.extra?.waitUntil) return; if (x.status !== 409) throw e; await plan.setItem(owner, d.key, { status: 'waived', evidence: 'waived in test: no live system' }); }
    }
  }
  it('is a record, not a switch: items need evidence; owner-only items refuse admins; staff are refused entirely', async () => {
    await expect(plan.getChecklist(sam)).rejects.toThrow(/owner or admin/);
    await expect(plan.setItem(admin, 'd_sms_provider', { status: 'passed' })).rejects.toThrow(/evidence/);
    await plan.setItem(admin, 'd_sms_provider', { status: 'passed', evidence: 'Kenect support email 10/12: they text via their own SMS provider' });
    await expect(plan.setItem(admin, 'd_kenect_contract', { status: 'passed', evidence: 'read it' })).rejects.toThrow(/only the owner/); await expect(plan.setItem(admin, 'e_templates', { status: 'waived', evidence: 'skipping this one' })).rejects.toThrow(/only the owner can waive/);
    const cl = await plan.getChecklist(owner); expect(cl.notice).toMatch(/does not change routing/); expect(cl.items.find((i) => i.key === 'd_sms_provider')).toMatchObject({ status: 'passed', evidence: expect.stringContaining('Kenect support') });
    await expect(plan.setItem(owner, 'nope', { status: 'passed', evidence: 'xxxxx' })).rejects.toThrow(/unknown/);
  });
  it('prerequisites are enforced server-side; a waiver cannot skip them', async () => {
    await expect(pass(owner, 'e_contacts')).rejects.toMatchObject({ extra: { blockedBy: ['d_kenect_exports'] } });
    await expect(plan.setItem(owner, 'e_contacts', { status: 'waived', evidence: 'because' })).rejects.toThrow(/cannot skip earlier items/);
    await expect(pass(owner, 'c_go')).rejects.toThrow(/blocked by earlier items/); await expect(pass(owner, 'c_kenect_cancel')).rejects.toThrow(/blocked by earlier items: c_validation/);
  });
  it('automatic checks use Relay’s own data: contacts are not “imported” until a batch is committed', async () => {
    await pass(owner, 'd_kenect_exports'); await expect(pass(owner, 'e_contacts')).rejects.toMatchObject({ extra: { check: { ok: false } } });
    const { id } = await stage('contacts', 'Name,Phone\nA B,(414) 555-0270\n'); await commit(id); await pass(owner, 'e_contacts');
    await expect(plan.setItem(owner, 'e_contacts', { status: 'pending' })).resolves.toEqual({ ok: true });   // nothing depends on it yet, so it can be reopened
    await pass(owner, 'e_contacts'); await pass(owner, 'e_reconcile'); await expect(plan.setItem(owner, 'e_contacts', { status: 'pending' })).rejects.toThrow(/later items depend on this one: e_reconcile/);
  });
  it('reopening an item that later items depend on is refused', async () => {
    await pass(owner, 'd_ringcentral'); await pass(owner, 'v_baseline'); await expect(plan.setItem(owner, 'd_ringcentral', { status: 'pending' })).rejects.toThrow(/later items depend on this one: v_baseline/);
  });
  it('the full path works in order; the 14-day validation window cannot be skipped or waived; cancel-Kenect is last', async () => {
    await walk(); let cl = await plan.getChecklist(owner);
    expect(cl.readiness).toMatchObject({ readyForOwnerGoDecision: true, goRecorded: true, cutoverRecorded: true, kenectCancellationApproved: false });
    const v = cl.items.find((i) => i.key === 'c_validation')!; expect(v.status).toBe('pending'); expect(v.waitUntil).toBeTruthy();
    await expect(pass(owner, 'c_validation')).rejects.toMatchObject({ extra: { waitUntil: expect.any(String) } }); await expect(plan.setItem(owner, 'c_validation', { status: 'waived', evidence: 'no thanks' })).rejects.toThrow(/cannot be waived/);
    await expect(pass(owner, 'c_kenect_cancel')).rejects.toThrow(/c_validation/);
    await pool.query(`UPDATE migration_checklist SET updated_at = now() - interval '15 days' WHERE key='c_done'`);
    await pass(owner, 'c_validation'); await pass(owner, 'c_kenect_cancel', 'Owner decision after validation, 11/1'); cl = await plan.getChecklist(owner); expect(cl.readiness.kenectCancellationApproved).toBe(true);
    // none of it changes anything live
    expect(await n(`SELECT count(*) AS n FROM channels WHERE is_live_enabled`)).toBe(0); expect(await n(`SELECT count(*) AS n FROM messages WHERE status IN ('queued','sending','provider_accepted')`)).toBe(0);
  });
  it('the validation window is owner-configurable (1–90 days) and admins cannot shorten it', async () => {
    await expect(plan.setValidationDays(admin, 3)).rejects.toThrow(/only the owner/); await expect(plan.setValidationDays(owner, 0)).rejects.toThrow(/1–90/); await plan.setValidationDays(owner, 30);
    expect((await plan.getChecklist(owner)).validationDays).toBe(30);
  });
  it('c_go is blocked while any earlier required item is open, including the assistant-not-sending check', async () => {
    await walk('c_go'); await pass(owner, 'c_go').catch(() => undefined);
    await pool.query(`INSERT INTO service_identities (workspace_id, name, autonomy, created_by) VALUES ($1,'Sandra','send',$2)`, [s.workspaceId, s.users.owner]);
    const cl = await plan.getChecklist(owner); expect(cl.items.find((i) => i.key === 't_assistant_off')!.autoCheck).toMatchObject({ ok: false });
    await expect(plan.setItem(owner, 't_assistant_off', { status: 'pending' })).rejects.toThrow(/later items depend/);
  });
});
