import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, inbound, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import { zonedToUtc } from '../src/domain/time.js';
import * as tpl from '../src/domain/templates.js';
import * as sched from '../src/domain/scheduling.js';
import * as media from '../src/domain/media.js';
import { queueOutbound } from '../src/domain/messaging.js';
import { simulatorControl } from '../src/providers/sms.js';
import { changeConsent } from '../src/domain/contacts.js';
import { listNotifications } from '../src/domain/notifications.js';
import { setStore, type BlobStore } from '../src/domain/media.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>;
const mem = new Map<string, Buffer>();
const memStore: BlobStore = { put: async (k, d) => { mem.set(k, d); }, get: async (k) => mem.get(k)!, del: async (k) => { mem.delete(k); } };
beforeEach(async () => { setStore(memStore); mem.clear(); s = await resetDb(); sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam Sales' }; owner = { ...actor(s, 'owner', 'owner'), name: 'Demo Owner' }; });
afterAll(() => pool.end());

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const future = () => { const d = new Date(Date.now() + 2 * 86400_000); return d.toISOString().slice(0, 11) + '10:00'; };
const msg = async (id: string) => (await pool.query('SELECT * FROM messages WHERE id=$1', [id])).rows[0];
const makeDue = () => pool.query(`UPDATE jobs SET run_at=now() WHERE kind='scheduled_send'`);

describe('timezone / DST', () => {
  it('normal time converts with the correct offset (CDT vs CST)', () => {
    expect(zonedToUtc('2026-07-01T09:00', 'America/Chicago').utc.toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(zonedToUtc('2026-01-15T09:00', 'America/Chicago').utc.toISOString()).toBe('2026-01-15T15:00:00.000Z');
  });
  it('spring-forward gap (2:30 on 2026-03-08) is shifted forward, not dropped', () => {
    const z = zonedToUtc('2026-03-08T02:30', 'America/Chicago');
    expect(z.dst).toBe('gap_shifted_forward'); expect(z.utc.toISOString()).toBe('2026-03-08T08:30:00.000Z');   // = 03:30 CDT
  });
  it('fall-back overlap (1:30 on 2026-11-01) uses first occurrence', () => {
    const z = zonedToUtc('2026-11-01T01:30', 'America/Chicago');
    expect(z.dst).toBe('ambiguous_first_occurrence'); expect(z.utc.toISOString()).toBe('2026-11-01T06:30:00.000Z');   // CDT, before the shift
  });
  it('rejects unknown timezones and malformed times', () => {
    expect(() => zonedToUtc('2026-01-01T00:00', 'Mars/Base')).toThrow(); expect(() => zonedToUtc('tomorrow', 'America/Chicago')).toThrow();
  });
});

describe('templates', () => {
  it('renders from business-entered data only and reports missing fields', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0201', 'Casey');
    const t = (await tpl.listTemplates(sam, {})).find((x) => x.name === 'Visit confirmation')!;
    const r1 = await tpl.renderTemplate(sam, t.id, conversationId);
    expect(r1.missing).toEqual(['directions_link']); expect(r1.text).toContain('Hi Casey,'); expect(r1.text).toContain('{{directions_link}}');
    await pool.query(`INSERT INTO workspace_settings VALUES ($1,'directions_link','https://example.test/dir',NULL)`, [s.workspaceId]);
    expect((await tpl.renderTemplate(sam, t.id, conversationId)).missing).toEqual([]);
  });
  it('auto-created leads (phone number as name) do not render the number as a first name', async () => {
    await inbound('+14142010202', 'hi');
    const cid = (await pool.query('SELECT id FROM conversations')).rows[0].id;
    const t = (await tpl.listTemplates(sam, {})).find((x) => x.name === 'First reply')!;
    expect((await tpl.renderTemplate(sam, t.id, cid)).missing).toContain('first_name');
  });
  it('versions: update creates a new version, revert creates another, history is preserved; staff cannot edit', async () => {
    const t = (await tpl.listTemplates(sam, {}))[0];
    await expect(tpl.updateTemplate(sam, t.id, 'x')).rejects.toThrow(/manager/);
    expect(await tpl.updateTemplate(owner, t.id, 'v2 body')).toBe(2);
    expect(await tpl.revertTemplate(owner, t.id, 1)).toBe(3);
    const vs = await tpl.templateVersions(owner, t.id); expect(vs.map((v) => v.version)).toEqual([3, 2, 1]); expect(vs[0].body).toBe(vs[2].body);
  });
  it('search, favorites and department scoping', async () => {
    const fin = await tpl.createTemplate(owner, { category: 'general', name: 'Fin only', body: 'financing text', departmentId: s.departments.financing });
    expect((await tpl.listTemplates(sam, {})).map((t) => t.id)).not.toContain(fin);
    expect((await tpl.listTemplates(owner, {})).map((t) => t.id)).toContain(fin);
    const t = (await tpl.listTemplates(sam, { search: 'hours' }))[0]; expect(t.name).toBe('Business hours');
    await tpl.toggleFavorite(sam, t.id, true); expect((await tpl.listTemplates(sam, { favoritesOnly: true })).map((x) => x.id)).toEqual([t.id]);
    expect((await tpl.listTemplates(owner, { favoritesOnly: true }))).toHaveLength(0);
  });
});

describe('scheduled sends', () => {
  it('sends at the due time through the normal pipeline; history is recorded; responsibility reflects schedule', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0210');
    const r = await sched.createScheduled(sam, conversationId, { body: 'Reminder: see you tomorrow', localTime: future() });
    expect((await pool.query('SELECT responsibility FROM conversations WHERE id=$1', [conversationId])).rows[0].responsibility).toBe('scheduled');
    await drain(); expect(simulatorControl.sent).toHaveLength(0);     // not due yet
    await makeDue(); await drain();
    expect(simulatorControl.sent).toHaveLength(1);
    const row = (await pool.query('SELECT status, message_id FROM scheduled_sends WHERE id=$1', [r.id])).rows[0]; expect(row.status).toBe('sent');
    expect((await msg(row.message_id)).status).toBe('provider_accepted');
    expect((await sched.scheduledHistory(sam, r.id)).map((e) => e.event)).toEqual(['created', 'sent']);
    expect((await pool.query('SELECT responsibility FROM conversations WHERE id=$1', [conversationId])).rows[0].responsibility).toBe('waiting_on_customer');
  });
  it('cancel prevents sending and restores responsibility; cancel after send is refused', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0211');
    const r = await sched.createScheduled(sam, conversationId, { body: 'x', localTime: future() });
    await sched.cancelScheduled(sam, r.id); await makeDue(); await drain();
    expect(simulatorControl.sent).toHaveLength(0);
    expect((await pool.query('SELECT responsibility FROM conversations WHERE id=$1', [conversationId])).rows[0].responsibility).toBe('waiting_on_staff');
    const r2 = await sched.createScheduled(sam, conversationId, { body: 'y', localTime: future() }); await makeDue(); await drain();
    await expect(sched.cancelScheduled(sam, r2.id)).rejects.toThrow(/already sent/);
  });
  it('opt-out before execution suppresses the send and notifies the creator', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0212');
    const r = await sched.createScheduled(sam, conversationId, { body: 'promo-ish', localTime: future() });
    await changeConsent(sam, contactId, 'do_not_text_set');
    await makeDue(); await drain();
    const row = (await pool.query('SELECT status, status_detail FROM scheduled_sends WHERE id=$1', [r.id])).rows[0];
    expect(row).toMatchObject({ status: 'suppressed', status_detail: 'do_not_text' }); expect(simulatorControl.sent).toHaveLength(0);
    expect((await listNotifications(sam)).items.some((n) => n.type === 'scheduled_review')).toBe(true);
  });
  it('customer reply after scheduling → needs_review instead of sending a stale message', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0213');
    const r = await sched.createScheduled(sam, conversationId, { body: 'see you at 3', localTime: future() });
    await inbound('+14142010213', 'actually can we do 5?');
    await makeDue(); await drain();
    expect((await pool.query('SELECT status, status_detail FROM scheduled_sends WHERE id=$1', [r.id])).rows[0]).toMatchObject({ status: 'needs_review', status_detail: 'customer_replied_since_scheduling' });
    expect(simulatorControl.sent).toHaveLength(0);
  });
  it('closed conversation suppresses; past times and bad timezones are rejected; invisible conversation is 404', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0214');
    await expect(sched.createScheduled(sam, conversationId, { body: 'x', localTime: '2020-01-01T10:00' })).rejects.toThrow(/future/);
    await expect(sched.createScheduled(sam, conversationId, { body: 'x', localTime: future(), timezone: 'Nope/Zone' })).rejects.toThrow(/timezone/);
    const finCv = (await pool.query(`UPDATE conversations SET department_id=$2 WHERE id=$1 RETURNING id`, [conversationId, s.departments.financing])).rows[0].id;
    await expect(sched.createScheduled(sam, finCv, { body: 'x', localTime: future() })).rejects.toThrow(/not found/);
  });
  it('survives worker restart: a due job is picked up by a fresh runner and sent exactly once even if run twice', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0215');
    const r = await sched.createScheduled(sam, conversationId, { body: 'once', localTime: future() });
    await makeDue(); await Promise.all([sched.executeScheduled(r.id), sched.executeScheduled(r.id)]); await drain();
    expect(simulatorControl.sent).toHaveLength(1);
  });
});

describe('media + MMS', () => {
  it('rejects spoofed types, executables, empty and oversize files; accepts real PNG; sanitizes filenames', async () => {
    const w = { workspaceId: s.workspaceId, uploaderUserId: s.users.sam };
    await expect(media.saveMedia(w, { filename: 'evil.png', data: Buffer.from('MZ\x90\x00 not an image') })).rejects.toThrow(/unsupported/);
    await expect(media.saveMedia(w, { filename: 'a.png', data: Buffer.alloc(0) })).rejects.toThrow();
    await expect(media.saveMedia(w, { filename: 'a.html', data: Buffer.from('<script>alert(1)</script>') })).rejects.toThrow(/unsupported/);
    const ok = await media.saveMedia(w, { filename: '../../etc/pa ss<wd>.png', data: PNG });
    expect(ok.contentType).toBe('image/png');
    expect((await pool.query('SELECT filename, scan_status FROM media_assets WHERE id=$1', [ok.id])).rows[0]).toEqual({ filename: 'pa ss_wd_.png', scan_status: 'unscanned' });
  });
  it('MMS: attachment reaches provider with signed URL; oversize/unknown attachment blocked; deleted media is revoked', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0220');
    const w = { workspaceId: s.workspaceId, uploaderUserId: s.users.sam };
    const a = await media.saveMedia(w, { filename: 'boat.png', data: PNG });
    const r = await queueOutbound({ workspaceId: s.workspaceId, conversationId, body: 'Photo', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: 'mms-0001-aaaa', mediaIds: [a.id] });
    expect(r.ok).toBe(true); await drain();
    expect(simulatorControl.sent[0].media).toHaveLength(1); expect(simulatorControl.sent[0].media![0].url).toMatch(/\/media\/file\/.+sig=/);
    const big = await media.saveMedia(w, { filename: 'big.png', data: Buffer.concat([PNG, Buffer.alloc(media.MAX_MMS_BYTES)]) });
    expect(await queueOutbound({ workspaceId: s.workspaceId, conversationId, body: 'x', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: 'mms-0002-aaaa', mediaIds: [big.id] })).toMatchObject({ ok: false, reason: 'attachment_too_large_for_mms' });
    expect(await queueOutbound({ workspaceId: s.workspaceId, conversationId, body: 'x', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: 'mms-0003-aaaa', mediaIds: ['00000000-0000-0000-0000-000000000000'] })).toMatchObject({ ok: false, reason: 'attachment_not_found' });
    const link = media.signedPath(a.id); const [, q] = link.split('?'); const p = new URLSearchParams(q);
    expect(media.verifySigned(a.id, p.get('exp')!, p.get('sig')!)).toBe(true);
    expect(media.verifySigned(a.id, p.get('exp')!, p.get('sig')! + 'x')).toBe(false);
    expect(media.verifySigned('00000000-0000-0000-0000-000000000001', p.get('exp')!, p.get('sig')!)).toBe(false);
    expect(media.verifySigned(a.id, String(Math.floor(Date.now() / 1000) - 5), p.get('sig')!)).toBe(false);
    await media.deleteMedia(sam, a.id); expect(await media.readForServing(a.id)).toBeNull();
  });
  it('inbound MMS with inline image is stored and attached; bad inline file is rejected without losing the text', async () => {
    const mk = (eventId: string, data: Buffer) => import('../src/domain/inbound.js').then((m) => m.processWebhookEvent('simulator', { type: 'inbound', eventId, providerMessageId: eventId, from: '+14142010221', to: '+12625550100', body: 'look', occurredAt: new Date(), media: [{ contentType: 'image/png', dataBase64: data.toString('base64') }] }));
    await mk('mms1', PNG); await mk('mms2', Buffer.from('not an image'));
    expect((await pool.query('SELECT count(*)::int n FROM message_attachments')).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE direction='inbound'`)).rows[0].n).toBe(2);
    expect((await pool.query(`SELECT count(*)::int n FROM timeline_events WHERE summary LIKE 'Inbound attachment rejected%'`)).rows[0].n).toBe(1);
  });
  it('voice recordings are only accessible to their owner (and admins)', async () => {
    const m = await media.saveMedia({ workspaceId: s.workspaceId, uploaderUserId: s.users.sam }, { filename: 'v.webm', data: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(32)]), origin: 'voice' });
    await expect(media.getMediaForActor(actor(s, 'sue', 'staff', ['service']), m.id)).rejects.toThrow(/not found/);
    expect((await media.getMediaForActor(sam, m.id)).id).toBe(m.id); expect((await media.getMediaForActor(owner, m.id)).id).toBe(m.id);
  });
});

describe('send guards', () => {
  it('refuses to send text with unresolved template variables', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0240');
    expect(await queueOutbound({ workspaceId: s.workspaceId, conversationId, body: 'Hi {{first_name}}', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: 'guard-0001-a' })).toMatchObject({ ok: false, reason: 'unresolved_template_variables' });
    expect(simulatorControl.sent).toHaveLength(0);
  });
});

describe('notifications', () => {
  it('inbound text notifies the assignee, else department members, else admins', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0230');
    await inbound('+14142010230', 'hello');
    expect((await listNotifications(owner)).unread).toBe(1);               // unassigned, no department → admins
    await pool.query('UPDATE conversations SET assignee_user_id=$2 WHERE id=$1', [conversationId, s.users.sam]);
    await inbound('+14142010230', 'again');
    expect((await listNotifications(sam)).unread).toBe(1); expect((await listNotifications(owner)).unread).toBe(1);
  });
});
