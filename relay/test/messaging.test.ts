import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, inbound, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import { queueOutbound } from '../src/domain/messaging.js';
import { simulatorControl } from '../src/providers/sms.js';
import { takeover, setHandlingMode } from '../src/domain/conversations.js';
import { changeConsent } from '../src/domain/contacts.js';
import { processWebhookEvent } from '../src/domain/inbound.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>;
beforeEach(async () => { s = await resetDb(); sam = actor(s, 'sam', 'staff', ['sales']); owner = actor(s, 'owner', 'owner'); });
afterAll(() => pool.end());

const msg = async (id: string) => (await pool.query('SELECT * FROM messages WHERE id=$1', [id])).rows[0];
const send = (conversationId: string, over: object = {}) => queueOutbound({ workspaceId: s.workspaceId, conversationId, body: 'Hello', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: `k-${Math.random()}`, ...over });

describe('outbound pipeline', () => {
  it('delivers through simulator and reports provider_accepted (not delivered)', async () => {
    const { conversationId } = await newCustomerConvo(s, sam);
    const r = await send(conversationId); expect(r.ok).toBe(true);
    await drain();
    const m = await msg((r as any).messageId);
    expect(m.status).toBe('provider_accepted'); expect(m.provider_message_id).toMatch(/^SIM/);
    expect(simulatorControl.sent).toHaveLength(1);
  });

  it('idempotency key prevents duplicate sends', async () => {
    const { conversationId } = await newCustomerConvo(s, sam);
    const a = await send(conversationId, { idempotencyKey: 'same' }); const b = await send(conversationId, { idempotencyKey: 'same' });
    expect((b as any).duplicate).toBe(true); expect((b as any).messageId).toBe((a as any).messageId);
    await drain(); expect(simulatorControl.sent).toHaveLength(1);
  });

  it('ambiguous provider outcome → unknown, never auto-retried', async () => {
    const { conversationId } = await newCustomerConvo(s, sam);
    simulatorControl.nextOutcomes.push({ kind: 'ambiguous', error: 'timeout' });
    const r = await send(conversationId); await drain(); await drain();
    expect((await msg((r as any).messageId)).status).toBe('unknown');
    expect(simulatorControl.sent).toHaveLength(0);
    const jobs = await pool.query(`SELECT status FROM jobs WHERE kind='send_message'`); expect(jobs.rows[0].status).toBe('done');
  });

  it('worker crash mid-send (message stuck in sending) resolves to unknown, not a resend', async () => {
    const { conversationId } = await newCustomerConvo(s, sam);
    const r = await send(conversationId);
    await pool.query(`UPDATE messages SET status='sending' WHERE id=$1`, [(r as any).messageId]);
    await drain();
    expect((await msg((r as any).messageId)).status).toBe('unknown'); expect(simulatorControl.sent).toHaveLength(0);
  });

  it('safe-to-retry failure (not_sent) is retried and then sent once', async () => {
    const { conversationId } = await newCustomerConvo(s, sam);
    simulatorControl.nextOutcomes.push({ kind: 'not_sent', error: 'connection refused' });
    const r = await send(conversationId); await drain();
    expect((await msg((r as any).messageId)).status).toBe('queued');
    await pool.query(`UPDATE jobs SET run_at=now()`); await drain();
    expect((await msg((r as any).messageId)).status).toBe('provider_accepted'); expect(simulatorControl.sent).toHaveLength(1);
  });

  it('definitive provider rejection marks failed', async () => {
    const { conversationId } = await newCustomerConvo(s, sam);
    simulatorControl.nextOutcomes.push({ kind: 'rejected', error: 'invalid number' });
    const r = await send(conversationId); await drain();
    expect((await msg((r as any).messageId)).status).toBe('failed');
  });

  it('live (non-simulated) channel is refused until owner enables it', async () => {
    const { conversationId } = await newCustomerConvo(s, sam);
    await pool.query(`UPDATE channels SET is_simulated=false, provider='simulator'`);
    const r = await send(conversationId); await drain();
    const m = await msg((r as any).messageId); expect(m.status).toBe('failed'); expect(m.status_detail).toMatch(/owner approval/);
    expect(simulatorControl.sent).toHaveLength(0);
  });
});

describe('consent enforcement', () => {
  it('STOP keyword opts out, acks once, blocks later sends, and cancels queued sends', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0102');
    const queued = await send(conversationId);                     // still queued (worker not run)
    await inbound('+14142010102', 'STOP');
    expect((await msg((queued as any).messageId)).status).toBe('suppressed');
    await drain();
    expect(simulatorControl.sent.map((x) => x.body)).toHaveLength(1);   // exactly one compliance ack
    expect(simulatorControl.sent[0].body).toMatch(/unsubscribed/);
    const blocked = await send(conversationId);
    expect(blocked).toMatchObject({ ok: false, reason: 'sms_opted_out' });
    expect((await pool.query('SELECT sms_opted_out FROM contacts WHERE id=$1', [contactId])).rows[0].sms_opted_out).toBe(true);
  });

  it('duplicate STOP webhook does not double-ack', async () => {
    await newCustomerConvo(s, sam, '(414) 201-0103');
    await inbound('+14142010103', 'stop', { eventId: 'dup-1', providerMessageId: 'pm-dup' });
    const again = await inbound('+14142010103', 'stop', { eventId: 'dup-1', providerMessageId: 'pm-dup' });
    expect(again.duplicate).toBe(true); await drain();
    expect(simulatorControl.sent).toHaveLength(1);
  });

  it('provider_auto_replies channel suppresses app-level acknowledgment', async () => {
    await pool.query('UPDATE channels SET provider_auto_replies=true');
    await newCustomerConvo(s, sam, '(414) 201-0104'); await inbound('+14142010104', 'STOP'); await drain();
    expect(simulatorControl.sent).toHaveLength(0);
  });

  it('marketing requires explicit opt-in; opt_in_not_received is not consent', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0105');
    expect(await send(conversationId, { purpose: 'marketing' })).toMatchObject({ ok: false, reason: 'no_marketing_consent' });
    await changeConsent(sam, contactId, 'marketing_opt_in', 'web form 2026-10-01');
    expect(await send(conversationId, { purpose: 'marketing' })).toMatchObject({ ok: true });
  });

  it('scheduled send is suppressed at execution time if contact opts out meanwhile', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0106');
    const r = await send(conversationId, { runAt: new Date(Date.now() + 3600_000) });
    await pool.query(`UPDATE messages SET status='queued' WHERE id=$1`, [(r as any).messageId]);
    await pool.query(`UPDATE contacts SET sms_opted_out=true`);      // opt-out arrives out-of-band
    await pool.query(`UPDATE jobs SET run_at=now()`); await drain();
    expect((await msg((r as any).messageId)).status).toBe('suppressed'); expect(simulatorControl.sent).toHaveLength(0);
  });

  it('suppressed sends are recorded with a reason, not silently dropped', async () => {
    const { contactId, conversationId } = await newCustomerConvo(s, sam, '(414) 201-0107');
    await changeConsent(sam, contactId, 'do_not_text_set');
    const r = await send(conversationId); expect(r.ok).toBe(false);
    expect((await msg((r as any).messageId)).status_detail).toBe('do_not_text');
  });
});

describe('fencing / takeover', () => {
  it('stale Sandra send is rejected after employee takeover', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0108');
    await setHandlingMode(owner, conversationId, 'sandra');
    const rev = (await pool.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
    await takeover(sam, conversationId);
    const r = await send(conversationId, { senderType: 'sandra', senderUserId: null, expectedRevision: rev });
    expect(r).toMatchObject({ ok: false, reason: 'stale_revision' });
  });

  it('a queued Sandra message is suppressed when an employee takes over before the worker runs', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0109');
    await setHandlingMode(owner, conversationId, 'sandra');
    const rev = (await pool.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
    const r = await send(conversationId, { senderType: 'sandra', senderUserId: null, expectedRevision: rev });
    expect(r.ok).toBe(true);
    await takeover(sam, conversationId); await drain();
    expect((await msg((r as any).messageId)).status).toBe('suppressed'); expect(simulatorControl.sent).toHaveLength(0);
  });

  it('new inbound message invalidates in-flight assistant reply (context changed)', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0110');
    await setHandlingMode(owner, conversationId, 'sandra');
    const rev = (await pool.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
    await inbound('+14142010110', 'actually, one more question');
    expect(await send(conversationId, { senderType: 'sandra', senderUserId: null, expectedRevision: rev })).toMatchObject({ ok: false, reason: 'stale_revision' });
  });

  it('worker re-checks the fence: queued Sandra reply is suppressed if a customer message arrives before sending', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0114');
    await setHandlingMode(owner, conversationId, 'sandra');
    const rev = (await pool.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
    const r = await send(conversationId, { senderType: 'sandra', senderUserId: null, expectedRevision: rev });
    await inbound('+14142010114', 'wait, different question');
    await drain();
    const m = await msg((r as any).messageId);
    expect(m.status).toBe('suppressed'); expect(m.status_detail).toBe('stale_revision'); expect(simulatorControl.sent).toHaveLength(0);
  });

  it('Sandra cannot send unless handling mode is sandra; paused/draft_only block automation', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0111');
    const rev = () => pool.query('SELECT revision FROM conversations WHERE id=$1', [conversationId]).then((r) => r.rows[0].revision);
    expect(await send(conversationId, { senderType: 'sandra', senderUserId: null, expectedRevision: await rev() })).toMatchObject({ reason: 'not_sandra_handling' });
    await setHandlingMode(owner, conversationId, 'draft_only');
    expect(await send(conversationId, { senderType: 'automation', senderUserId: null, expectedRevision: await rev() })).toMatchObject({ reason: 'draft_only_mode' });
    await setHandlingMode(owner, conversationId, 'paused');
    expect(await send(conversationId, { senderType: 'automation', senderUserId: null, expectedRevision: await rev() })).toMatchObject({ reason: 'automation_paused' });
  });

  it('human concurrent-reply guard warns when newer inbound exists', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0112');
    await inbound('+14142010112', 'hi');
    expect(await send(conversationId, { ifLastSeq: 0 })).toMatchObject({ ok: false, reason: 'newer_messages' });
    expect(await send(conversationId, { ifLastSeq: 0, force: true })).toMatchObject({ ok: true });
  });

  it('concurrent takeover + Sandra send: exactly one winner, no Sandra text after takeover', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0113');
    await setHandlingMode(owner, conversationId, 'sandra');
    const rev = (await pool.query('SELECT revision FROM conversations WHERE id=$1', [conversationId])).rows[0].revision;
    const [, r] = await Promise.all([takeover(sam, conversationId), send(conversationId, { senderType: 'sandra', senderUserId: null, expectedRevision: rev })]);
    await drain();
    const sandraSent = simulatorControl.sent.length;
    const final = (await pool.query('SELECT handling_mode FROM conversations WHERE id=$1', [conversationId])).rows[0];
    expect(final.handling_mode).toBe('human');
    // either Sandra won the lock first (sent before takeover, then suppressed by takeover) or lost (rejected) — never delivered after takeover
    expect(sandraSent).toBe(0); expect(r.ok === false || (await msg((r as any).messageId)).status === 'suppressed').toBe(true);
  });
});

describe('inbound webhooks', () => {
  it('duplicate / retried events do not duplicate messages; unknown numbers create contacts', async () => {
    await inbound('+14142010120', 'Interested in a pontoon', { eventId: 'e1', providerMessageId: 'p1' });
    const dup = await inbound('+14142010120', 'Interested in a pontoon', { eventId: 'e1', providerMessageId: 'p1' });
    expect(dup.duplicate).toBe(true);
    // same provider message re-delivered under a different event id
    await inbound('+14142010120', 'Interested in a pontoon', { eventId: 'e2', providerMessageId: 'p1' });
    expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE direction='inbound'`)).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT status, responsibility FROM conversations`)).rows[0]).toMatchObject({ status: 'open', responsibility: 'needs_our_reply' });
  });

  it('out-of-order status events never regress a message', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0121');
    const r = await send(conversationId); await drain();
    const pid = (await msg((r as any).messageId)).provider_message_id;
    const ev = (eventId: string, status: any) => processWebhookEvent('simulator', { type: 'status', eventId, providerMessageId: pid, status, occurredAt: new Date() });
    await ev('s1', 'delivered'); await ev('s2', 'provider_accepted');
    expect((await msg((r as any).messageId)).status).toBe('delivered');
  });

  it('reply reopens a closed thread', async () => {
    const { conversationId } = await newCustomerConvo(s, sam, '(414) 201-0122');
    await pool.query(`UPDATE conversations SET status='closed', responsibility='closed'`);
    await inbound('+14142010122', 'still there?');
    expect((await pool.query('SELECT status, responsibility FROM conversations WHERE id=$1', [conversationId])).rows[0]).toMatchObject({ status: 'open', responsibility: 'needs_our_reply' });
  });

  it('different people sharing a number are not merged', async () => {
    const a = await newCustomerConvo(s, sam, '(414) 201-0123', 'Pat'); const b = await newCustomerConvo(s, sam, '(414) 201-0123', 'Lee');
    expect(a.contactId).not.toBe(b.contactId);
    expect((await pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(2);
  });
});
