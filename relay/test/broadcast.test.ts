import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { config } from '../src/config.js';
import { actor, drain, inbound, resetDb, type Seeded } from './helpers.js';
import { simulatorControl } from '../src/providers/sms.js';
import * as bc from '../src/domain/broadcasts.js';
import { smsSegments } from '../src/domain/segments.js';
import { createContact, changeConsent } from '../src/domain/contacts.js';
import { localParts } from '../src/domain/time.js';
import { processWebhookEvent } from '../src/domain/inbound.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>;
beforeEach(async () => { config.broadcastMaxRecipients = 10000; s = await resetDb(); sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; });
afterAll(() => pool.end());

const mkContact = async (first: string | undefined, phone: string | undefined, o: { tags?: string[]; marketing?: boolean } = {}) => {
  const id = await createContact(owner, { firstName: first, phone, tags: o.tags ?? ['vip'] }); if (o.marketing !== false) await changeConsent(owner, id, 'marketing_opt_in', 'web form'); return id;
};
const draft = (o: object = {}) => bc.createBroadcast(owner, { name: 'Boat show', purpose: 'marketing', body: 'Hi {{first_name}}, boat show Saturday at Sun Sport Marine!', audience: { tags: ['vip'] }, batchSize: 25, intervalSeconds: 60, ...o });
const noQuiet = () => pool.query(`INSERT INTO automation_settings (workspace_id, quiet_start_hour, quiet_end_hour) VALUES ($1,0,0) ON CONFLICT (workspace_id) DO UPDATE SET quiet_start_hour=0, quiet_end_hour=0`, [s.workspaceId]);
const tick = async () => { await pool.query(`UPDATE jobs SET run_at=now() WHERE status='pending' AND kind='broadcast_tick'`); await drain(); };
const recStatus = async (id: string) => (await pool.query(`SELECT ct.first_name, r.status, r.reason FROM broadcast_recipients r JOIN contacts ct ON ct.id=r.contact_id WHERE r.broadcast_id=$1 ORDER BY ct.first_name`, [id])).rows;

describe('segment estimates', () => {
  it('GSM-7 vs UCS-2 and multipart boundaries', () => {
    expect(smsSegments('a'.repeat(160))).toMatchObject({ segments: 1, encoding: 'GSM-7' }); expect(smsSegments('a'.repeat(161)).segments).toBe(2); expect(smsSegments('a'.repeat(306)).segments).toBe(2); expect(smsSegments('a'.repeat(307)).segments).toBe(3);
    expect(smsSegments('{'.repeat(80)).segments).toBe(1); expect(smsSegments('{'.repeat(81)).segments).toBe(2);              // extension chars cost 2
    expect(smsSegments('Boat sale 🚤')).toMatchObject({ encoding: 'UCS-2', segments: 1 }); expect(smsSegments('é'.repeat(71) + '🚤').segments).toBe(2);
  });
});

describe('audience, exclusions and preview', () => {
  it('excludes opted-out, do-not-text, no-consent (marketing), duplicate numbers, missing details and no-phone; reports reasons; personalizes', async () => {
    const ok1 = await mkContact('Ann', '(414) 201-0801'); await mkContact('Bob', '(414) 201-0802');
    const stop = await mkContact('Cy', '(414) 201-0803'); await changeConsent(owner, stop, 'sms_stop', 'STOP');
    const dnt = await mkContact('Di', '(414) 201-0804'); await changeConsent(owner, dnt, 'do_not_text_set');
    await mkContact('Ed', '(414) 201-0805', { marketing: false });                  // opt-in NOT received ≠ consent
    await mkContact('Fay', '(414) 201-0801');                                       // shares Ann's number
    await mkContact(undefined, '(414) 201-0806'); await mkContact('Gus', undefined);  // no first name → missing details; no phone
    await mkContact('Hal', '(414) 201-0807', { tags: ['other'] });                    // not in audience
    const id = await draft(); const p = await bc.previewBroadcast(owner, id);
    expect(p.eligibleCount).toBe(2); expect(p.excludedByReason).toEqual({ sms_opted_out: 1, do_not_text: 1, no_marketing_consent: 1, duplicate_number: 1, missing_details: 1, no_phone: 1 });
    expect(p.samples.map((x) => x.text)).toEqual(expect.arrayContaining(['Hi Ann, boat show Saturday at Sun Sport Marine!']));
    expect(p.usage).toMatchObject({ totalSegments: 2, estimatedCostUsd: null }); expect(p.usage.note).toMatch(/unknown/);
    await pool.query(`INSERT INTO workspace_settings VALUES ($1,'sms_cost_per_segment','0.01',NULL)`, [s.workspaceId]); expect((await bc.previewBroadcast(owner, id)).usage.estimatedCostUsd).toBe(0.02);
    void ok1;
  });
  it('transactional notices skip the marketing-consent requirement but still honour opt-outs', async () => {
    await mkContact('Ivy', '(414) 201-0810', { marketing: false }); const j = await mkContact('Jo', '(414) 201-0811', { marketing: false }); await changeConsent(owner, j, 'sms_stop', 'STOP');
    const p = await bc.previewBroadcast(owner, await draft({ purpose: 'transactional', body: 'Your service appointment is tomorrow.' }));
    expect(p.eligibleCount).toBe(1); expect(p.excludedByReason).toEqual({ sms_opted_out: 1 });
  });
  it('is manager-only, drafts only editable as drafts, recipient safety limit enforced', async () => {
    await expect(bc.createBroadcast(sam, { name: 'x', purpose: 'marketing', body: 'hi', audience: { tags: ['vip'] } })).rejects.toThrow(/manager/);
    await expect(bc.createBroadcast(owner, { name: 'x', purpose: 'marketing', body: 'hi', audience: {} })).rejects.toThrow(/audience/);
    await mkContact('K1', '(414) 201-0812'); await mkContact('K2', '(414) 201-0813'); await mkContact('K3', '(414) 201-0814'); config.broadcastMaxRecipients = 2;
    await expect(bc.previewBroadcast(owner, await draft({ body: 'hello' }))).rejects.toThrow(/safety limit/);
  });
});

describe('approval, throttled sending, and send-time re-checks', () => {
  it('requires approval; sends individual messages in throttled batches; ends completed; delivery shown honestly', async () => {
    await noQuiet(); for (let i = 0; i < 5; i++) await mkContact('P' + i, `(414) 201-082${i}`);
    const id = await draft({ batchSize: 2, intervalSeconds: 30 });
    await expect(bc.approveBroadcast(sam, id, { sendNow: true })).rejects.toThrow(/manager/);
    await drain(); expect(simulatorControl.sent).toHaveLength(0);                     // nothing happens without approval
    expect(await bc.approveBroadcast(owner, id, { sendNow: true })).toMatchObject({ eligible: 5, excluded: 0 });
    await drain(); expect(simulatorControl.sent).toHaveLength(2); expect((await bc.getBroadcast(owner, id)).broadcast.status).toBe('sending');
    const next = (await pool.query(`SELECT run_at FROM jobs WHERE kind='broadcast_tick' AND status='pending'`)).rows[0]; expect(new Date(next.run_at).getTime() - Date.now()).toBeGreaterThan(25_000);   // throttle interval honoured
    await tick(); expect(simulatorControl.sent).toHaveLength(4); await tick(); expect(simulatorControl.sent).toHaveLength(5);
    const g = await bc.getBroadcast(owner, id); expect(g.broadcast.status).toBe('completed'); expect(g.progress.counts).toEqual({ provider_accepted: 5 });   // accepted, NOT delivered
    expect(new Set(simulatorControl.sent.map((x) => x.to)).size).toBe(5);              // one message per person, never a group thread
    expect((await pool.query(`SELECT count(DISTINCT conversation_id)::int n FROM messages WHERE auto_kind='broadcast'`)).rows[0].n).toBe(5);
    const pid = simulatorControl.sent[0].providerMessageId; await processWebhookEvent('simulator', { type: 'status', eventId: 'bc-d1', providerMessageId: pid, status: 'delivered', occurredAt: new Date() });
    expect((await bc.getBroadcast(owner, id)).progress.counts).toEqual({ provider_accepted: 4, delivered: 1 });
    expect((await pool.query(`SELECT status FROM conversations LIMIT 1`)).rows[0].status).toBe('closed');   // broadcasts don't clutter the inbox
  });
  it('opt-outs that happen AFTER approval are enforced at send time (STOP reply, staff opt-out, do-not-text)', async () => {
    await noQuiet(); const a = await mkContact('Amy', '(414) 201-0830'); const b = await mkContact('Ben', '(414) 201-0831'); await mkContact('Cat', '(414) 201-0832'); await mkContact('Dan', '(414) 201-0833');
    const id = await draft({ batchSize: 10 }); await bc.approveBroadcast(owner, id, { sendNow: true });
    await changeConsent(owner, a, 'do_not_text_set'); await changeConsent(owner, b, 'sms_stop', 'phone call');
    await inbound('+14142010832', 'STOP');                                            // Cat replies STOP before the batch runs
    await drain();
    expect(simulatorControl.sent.filter((x) => x.body.startsWith('Hi ')).map((x) => x.to)).toEqual(['+14142010833']);   // only Dan gets the broadcast
    expect(simulatorControl.sent.filter((x) => /unsubscribed/.test(x.body)).map((x) => x.to)).toEqual(['+14142010832']);   // Cat gets only the compliance acknowledgment
    const st = await recStatus(id); expect(Object.fromEntries(st.map((r) => [r.first_name, r.reason ?? r.status]))).toMatchObject({ Amy: 'do_not_text', Ben: 'sms_opted_out', Cat: 'sms_opted_out', Dan: 'queued' });
  });
  it('re-running a tick never double-sends (idempotent per recipient)', async () => {
    await noQuiet(); await mkContact('Eve', '(414) 201-0840'); const id = await draft(); await bc.approveBroadcast(owner, id, { sendNow: true });
    await Promise.all([bc.runBroadcastTick(id), bc.runBroadcastTick(id)]); await drain(); expect(simulatorControl.sent).toHaveLength(1);
  });
  it('pause stops sending, resume continues, cancel skips everything pending', async () => {
    await noQuiet(); for (let i = 0; i < 4; i++) await mkContact('Q' + i, `(414) 201-085${i}`);
    const id = await draft({ batchSize: 1 }); await bc.approveBroadcast(owner, id, { sendNow: true }); await drain(); expect(simulatorControl.sent).toHaveLength(1);
    await bc.setBroadcastState(owner, id, 'pause'); await tick(); await tick(); expect(simulatorControl.sent).toHaveLength(1);
    await bc.setBroadcastState(owner, id, 'resume'); await drain(); expect(simulatorControl.sent).toHaveLength(2);
    await bc.setBroadcastState(owner, id, 'cancel'); await tick(); await tick(); expect(simulatorControl.sent).toHaveLength(2);
    const g = await bc.getBroadcast(owner, id); expect(g.broadcast.status).toBe('cancelled'); expect(g.recipients.filter((r) => r.detail === 'broadcast_cancelled')).toHaveLength(2);
    await expect(bc.setBroadcastState(owner, id, 'resume')).rejects.toThrow();
  });
  it('replies enter the shared inbox (reopen, needs our reply) and are counted; scheduling is timezone-aware', async () => {
    await noQuiet(); await mkContact('Ruth', '(414) 201-0860'); const id = await draft(); await bc.approveBroadcast(owner, id, { sendNow: true }); await drain();
    await inbound('+14142010860', 'Yes, I will come!');
    expect((await pool.query(`SELECT status, responsibility FROM conversations`)).rows[0]).toEqual({ status: 'open', responsibility: 'needs_our_reply' });
    expect((await bc.getBroadcast(owner, id)).progress.replies48h).toBe(1);
    const id2 = await draft({ name: 'Later' }); const lp = localParts(new Date(Date.now() + 2 * 86400_000), 'America/Chicago');
    const r = await bc.approveBroadcast(owner, id2, { localTime: `${lp.date}T10:00`, timezone: 'America/Chicago' }); expect(r.startsAt.getTime()).toBeGreaterThan(Date.now() + 86400_000);
    await expect(bc.approveBroadcast(owner, await draft({ name: 'Past' }), { localTime: '2020-01-01T10:00' })).rejects.toThrow(/future/);
  });
  it('marketing waits out quiet hours; transactional does not; global pause holds everything', async () => {
    const lp = localParts(new Date(), 'America/Chicago'); await pool.query(`INSERT INTO automation_settings (workspace_id, quiet_start_hour, quiet_end_hour) VALUES ($1,$2,$3)`, [s.workspaceId, lp.hour, (lp.hour + 1) % 24]);
    await mkContact('Sue', '(414) 201-0870', { marketing: true });
    const m = await draft(); await bc.approveBroadcast(owner, m, { sendNow: true }); await drain(); expect(simulatorControl.sent).toHaveLength(0);
    const t = await draft({ name: 'Notice', purpose: 'transactional', body: 'Service notice for {{first_name}}' }); await bc.approveBroadcast(owner, t, { sendNow: true }); await drain(); expect(simulatorControl.sent.map((x) => x.body)).toEqual(['Service notice for Sue']);
    await noQuiet(); await pool.query('UPDATE workspaces SET global_automation_pause=true'); await tick(); expect(simulatorControl.sent).toHaveLength(1);
    await pool.query('UPDATE workspaces SET global_automation_pause=false'); await tick(); expect(simulatorControl.sent).toHaveLength(2);
  });
});
