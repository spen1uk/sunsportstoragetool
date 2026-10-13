import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, drain, inbound, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import { simulatorControl } from '../src/providers/sms.js';
import { loadHours, nextOpenAt, openState } from '../src/domain/hours.js';
import { localParts, quietHoursEnd } from '../src/domain/time.js';
import * as wf from '../src/domain/workflows.js';
import { takeover, setHandlingMode, setResponsibility, setOpen, assign } from '../src/domain/conversations.js';
import { changeConsent } from '../src/domain/contacts.js';
import { queueOutbound } from '../src/domain/messaging.js';
import { listNotifications } from '../src/domain/notifications.js';
import { runOne } from '../src/domain/queue.js';
import { handlers } from '../src/worker/handlers.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>
beforeEach(async () => { s = await resetDb(); sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; });
afterAll(() => pool.end());

// ----- helpers -----
const setHours = async (rows: { weekday: number; open?: string; close?: string }[]) => { for (const r of rows) await pool.query(`INSERT INTO business_hours (workspace_id, weekday, closed, open_time, close_time) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id, weekday) DO UPDATE SET closed=EXCLUDED.closed, open_time=EXCLUDED.open_time, close_time=EXCLUDED.close_time`, [s.workspaceId, r.weekday, !r.open, r.open ?? null, r.close ?? null]); };
const alwaysOpen = () => setHours([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '00:00', close: '23:59' })));
const alwaysClosed = () => setHours([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday })));
const settings = (o: Record<string, unknown>) => pool.query(`INSERT INTO automation_settings (workspace_id, auto_response_enabled, first_contact_message, after_hours_message, holiday_message, cadence_hours, quiet_start_hour, quiet_end_hour) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (workspace_id) DO UPDATE SET auto_response_enabled=EXCLUDED.auto_response_enabled, first_contact_message=EXCLUDED.first_contact_message, after_hours_message=EXCLUDED.after_hours_message, holiday_message=EXCLUDED.holiday_message, cadence_hours=EXCLUDED.cadence_hours, quiet_start_hour=EXCLUDED.quiet_start_hour, quiet_end_hour=EXCLUDED.quiet_end_hour`,
  [s.workspaceId, o.enabled ?? true, o.first ?? null, o.after ?? null, o.holiday ?? null, o.cadence ?? 12, o.qs ?? 21, o.qe ?? 8]);
const noQuiet = { qs: 0, qe: 0 };
const sentBodies = () => simulatorControl.sent.map((x) => x.body);
const conv = async (id: string) => (await pool.query('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];
const named = async (phone: string, first = 'Casey') => { const r = await newCustomerConvo(s, sam, phone, first); return r; };
/** Make due workflow steps run now (stand-in for time passing) and process all jobs. */
const tick = async () => { await pool.query(`UPDATE jobs SET run_at=now() WHERE status='pending' AND kind='workflow_step'`); await drain(); };
const run = async (workflowId?: string) => (await pool.query(`SELECT * FROM workflow_runs ${workflowId ? 'WHERE workflow_id=$1' : ''} ORDER BY created_at DESC LIMIT 1`, workflowId ? [workflowId] : [])).rows[0];
const logOf = async (runId: string) => (await pool.query('SELECT step, outcome, detail FROM workflow_run_log WHERE run_id=$1 ORDER BY id', [runId])).rows;
const mk = async (name: string, definition: object, activate = true) => { const id = await wf.createWorkflow(owner, { name, definition }); if (activate) await wf.setWorkflowStatus(owner, id, 'active'); return id; };
const send = (body: string, kind: 'follow_up' | 'workflow' = 'workflow', extra: object = {}) => ({ type: 'send_message', body, kind, ...extra });
const inboundDef = (steps: object[], extra: object = {}) => ({ trigger: { type: 'inbound_message' }, conditions: [], steps, limits: { maxSendsPerContactPerDay: 5, respectQuietHours: false, staffWaitReminderHours: 4, staffWaitEscalateHours: 24 }, ...extra });

describe('business hours (DST-aware)', () => {
  const weekHours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open: '08:00', close: '17:00' }));
  it('open/closed boundaries are correct on spring-forward and fall-back days', async () => {
    await setHours(weekHours); const h = await loadHours(pool, s.workspaceId);
    const st = (iso: string) => openState(h, new Date(iso)).state;
    expect([st('2026-03-07T13:59:00Z'), st('2026-03-07T14:00:00Z')]).toEqual(['closed', 'open']);      // CST (UTC-6)
    expect([st('2026-03-08T12:59:00Z'), st('2026-03-08T13:00:00Z')]).toEqual(['closed', 'open']);      // day DST starts: CDT (UTC-5) by 08:00
    expect([st('2026-11-01T13:59:00Z'), st('2026-11-01T14:00:00Z')]).toEqual(['closed', 'open']);      // day DST ends: CST again
    expect(st('2026-07-01T21:59:00Z')).toBe('open'); expect(st('2026-07-01T22:00:00Z')).toBe('closed'); // 16:59 / 17:00 CDT
  });
  it('unconfigured hours are "unknown", never assumed; holidays override; nextOpenAt skips closed days', async () => {
    expect(openState(await loadHours(pool, s.workspaceId), new Date()).state).toBe('unknown');
    await setHours([{ weekday: 0 }, { weekday: 6 }, ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, open: '09:00', close: '17:00' }))]);
    await pool.query(`INSERT INTO holidays (workspace_id, day, name, closed, notice) VALUES ($1,'2026-07-03','Independence Day (observed)',true,'We are closed for the holiday.')`, [s.workspaceId]);
    const h = await loadHours(pool, s.workspaceId);
    expect(openState(h, new Date('2026-07-03T17:00:00Z'))).toMatchObject({ state: 'closed', reason: 'holiday', holiday: { notice: 'We are closed for the holiday.' } });
    expect(openState(h, new Date('2026-07-04T17:00:00Z'))).toMatchObject({ state: 'closed', reason: 'closed_day' });
    expect(nextOpenAt(h, new Date('2026-07-02T22:30:00Z'))!.toISOString()).toBe('2026-07-06T14:00:00.000Z');  // Thu evening → skips holiday Fri + weekend → Mon 09:00 CDT
    expect(nextOpenAt(h, new Date('2026-07-06T15:00:00Z'))!.toISOString()).toBe('2026-07-06T15:00:00.000Z');  // already open
  });
  it('quiet hours end at the right instant across DST changes', () => {
    expect(quietHoursEnd(new Date('2026-03-08T07:30:00Z'), 'America/Chicago', 21, 8)!.toISOString()).toBe('2026-03-08T13:00:00.000Z');   // 01:30 CST → 08:00 CDT
    expect(quietHoursEnd(new Date('2026-11-01T06:30:00Z'), 'America/Chicago', 21, 8)!.toISOString()).toBe('2026-11-01T14:00:00.000Z');   // 01:30 CDT → 08:00 CST
    expect(quietHoursEnd(new Date('2026-07-01T03:00:00Z'), 'America/Chicago', 21, 8)!.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(quietHoursEnd(new Date('2026-07-01T18:00:00Z'), 'America/Chicago', 21, 8)).toBeNull();
    expect(localParts(new Date('2026-03-08T13:00:00Z'), 'America/Chicago').hour).toBe(8);
  });
});

describe('auto-responses', () => {
  it('are off by default; nothing is sent', async () => { await alwaysOpen(); await inbound('+14142010701', 'hello'); await drain(); expect(simulatorControl.sent).toHaveLength(0); });
  it('first contact greeting is sent once, passively (customer still needs our reply, fence untouched)', async () => {
    await alwaysOpen(); await settings({ ...noQuiet, first: 'Thanks for texting {{business_name}}! A team member will reply shortly.' });
    await inbound('+14142010702', 'Do you have pontoons?'); const cid = (await pool.query('SELECT id, revision FROM conversations')).rows[0];
    await drain(); expect(sentBodies()).toEqual(['Thanks for texting Sun Sport Marine! A team member will reply shortly.']);
    const after = await conv(cid.id); expect(after.responsibility).toBe('needs_our_reply'); expect(after.revision).toBe(cid.revision);
    expect((await pool.query(`SELECT auto_kind, sender_type FROM messages WHERE direction='outbound'`)).rows[0]).toEqual({ auto_kind: 'first_contact', sender_type: 'automation' });
    await inbound('+14142010702', 'also, price?'); await drain(); expect(simulatorControl.sent).toHaveLength(1);   // not again
  });
  it('after-hours notice honors cadence (no repeated acknowledgments); holiday notice wins on holidays', async () => {
    await alwaysClosed(); await settings({ ...noQuiet, after: 'We are closed right now and will reply when we open.', cadence: 12 });
    await inbound('+14142010703', 'hi'); await drain(); await inbound('+14142010703', 'anyone?'); await drain();
    expect(sentBodies()).toEqual(['We are closed right now and will reply when we open.']);
    await pool.query(`UPDATE messages SET created_at = now() - interval '13 hours' WHERE auto_kind='after_hours'`);
    await inbound('+14142010703', 'still there?'); await drain(); expect(simulatorControl.sent).toHaveLength(2);
    const lp = localParts(new Date(), 'America/Chicago'); await pool.query(`INSERT INTO holidays (workspace_id, day, name, closed, notice) VALUES ($1,$2,'Test Holiday',true,'Closed today for a holiday.')`, [s.workspaceId, lp.date]);
    await inbound('+14142010704', 'hello'); await drain(); expect(sentBodies().at(-1)).toBe('Closed today for a holiday.');
  });
  it('closed + first contact sends ONE message (the closed notice), not two', async () => {
    await alwaysClosed(); await settings({ ...noQuiet, first: 'Welcome!', after: 'Closed now.' }); await inbound('+14142010705', 'hi'); await drain(); expect(sentBodies()).toEqual(['Closed now.']);
  });
  it('skips (and records why) for: staff already replied, Sandra/paused handling, STOP, global pause, missing details', async () => {
    await alwaysOpen(); await settings({ ...noQuiet, first: 'Hi {{first_name}}, thanks for texting!' });
    // staff replies before the automation job runs
    const a = await named('(414) 201-0710', 'Pat'); await inbound('+14142010710', 'hello'); await queueOutbound({ workspaceId: s.workspaceId, conversationId: a.conversationId, body: 'On it!', senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: 'human-reply-0001' }); await drain();
    expect(sentBodies()).toEqual(['On it!']);
    // Sandra / paused
    const b = await named('(414) 201-0711', 'Lee'); await setHandlingMode(owner, b.conversationId, 'sandra'); await inbound('+14142010711', 'hello'); await drain(); expect(sentBodies()).toEqual(['On it!']);
    // STOP is never auto-answered by the greeting (compliance ack only)
    await inbound('+14142010712', 'STOP'); await drain(); expect(sentBodies().filter((x) => /Hi /.test(x))).toHaveLength(0);
    // global pause
    await pool.query('UPDATE workspaces SET global_automation_pause=true'); await inbound('+14142010713', 'hello again'); await drain(); expect(sentBodies().filter((x) => /Hi /.test(x))).toHaveLength(0);
    await pool.query('UPDATE workspaces SET global_automation_pause=false');
    // auto-created lead has no real first name → message can't be completed → skipped with a timeline note
    await inbound('+14142010714', 'new here'); await drain(); expect(sentBodies().filter((x) => /Hi /.test(x))).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int n FROM timeline_events WHERE summary LIKE 'Auto-response skipped: missing details first name%'`)).rows[0].n).toBe(1);
  });
  it('a stale auto-response is fenced out when a customer/human acts before the worker sends it', async () => {
    await alwaysOpen(); await settings({ ...noQuiet, first: 'Thanks for texting!' });
    await inbound('+14142010715', 'hello'); const c = (await pool.query('SELECT id FROM conversations')).rows[0].id;
    await takeover(sam, c); await drain();            // takeover sets human handling + bumps; auto-response job runs after → staff hasn't replied, mode is human → may still send
    // but if the revision moves between decision and send, queueOutbound rejects: simulate directly
    const r = await queueOutbound({ workspaceId: s.workspaceId, conversationId: c, body: 'late ack', senderType: 'automation', expectedRevision: 1, idempotencyKey: 'late-ack-0001', passive: true });
    expect(r).toMatchObject({ ok: false, reason: 'stale_revision' });
  });
});

describe('workflow definitions & activation', () => {
  it('rejects malformed definitions; staff cannot manage; external-event triggers cannot be activated (no verified adapter)', async () => {
    await expect(wf.createWorkflow(sam, { name: 'x', definition: inboundDef([{ type: 'end' }]) })).rejects.toThrow(/manager/);
    await expect(wf.createWorkflow(owner, { name: 'bad', definition: { trigger: { type: 'inbound_message' }, steps: [{ type: 'run_script', code: 'x' }] } })).rejects.toThrow();
    await expect(wf.createWorkflow(owner, { name: 'bad2', definition: { trigger: { type: 'inbound_message' }, steps: [] } })).rejects.toThrow();
    const id = await mk('Appointment reminder', { trigger: { type: 'appointment_event', event: 'created' }, steps: [send('See you soon!')] }, false);
    await expect(wf.setWorkflowStatus(owner, id, 'active')).rejects.toThrow(/verified adapter/);
  });
  it('refuses to activate automations that depend on business hours that are not configured, or send nothing', async () => {
    const a = await mk('BH', inboundDef([{ type: 'wait', minutes: 30, businessHoursOnly: true }, send('hi')]), false);
    await expect(wf.setWorkflowStatus(owner, a, 'active')).rejects.toThrow(/business hours/); await alwaysOpen(); await wf.setWorkflowStatus(owner, a, 'active');
    const b = await mk('Empty', inboundDef([{ type: 'send_message', kind: 'workflow' }]), false); await expect(wf.setWorkflowStatus(owner, b, 'active')).rejects.toThrow(/no message/);
  });
});

describe('workflow execution', () => {
  it('inbound trigger → tag → wait → send; one run per trigger even if the event is delivered twice; log explains each step', async () => {
    const id = await mk('Welcome', inboundDef([{ type: 'add_tag', tag: 'hot-lead' }, { type: 'wait', minutes: 10 }, send('Quick note from the team: we got your message.')]));
    await inbound('+14142010720', 'looking for a boat'); await drain();
    const cid = (await pool.query('SELECT id FROM conversations')).rows[0].id; const msgId = (await pool.query(`SELECT id FROM messages WHERE direction='inbound'`)).rows[0].id;
    await wf.handleWorkflowEvent({ type: 'inbound_message', conversationId: cid, messageId: msgId });       // duplicate delivery
    expect((await pool.query('SELECT count(*)::int n FROM workflow_runs')).rows[0].n).toBe(1);
    let r = await run(id); expect(r.status).toBe('waiting'); expect((await conv(cid)).tags).toContain('hot-lead'); expect(simulatorControl.sent).toHaveLength(0);
    expect(new Date(r.next_run_at).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    await tick(); r = await run(id); expect(r.status).toBe('completed'); expect(sentBodies()).toEqual(['Quick note from the team: we got your message.']);
    expect((await conv(cid)).responsibility).toBe('needs_our_reply');                  // a passive workflow message doesn't pretend we replied
    const log = await logOf(r.id); expect(log.map((l) => l.step)).toEqual(['start', 'add_tag', 'wait', 'send_message', 'end']);
    expect(log.find((l) => l.step === 'wait')!.detail).toMatch(/next step at/); expect(log.at(-1)!.detail).toBe('all steps finished');
    const act = await wf.activityForConversation(owner, cid); expect(act[0]).toMatchObject({ workflow: 'Welcome', status: 'completed' });
  });

  it.each([
    ['customer reply', 'customer_replied', async (c: string) => { await inbound('+14142010721', 'actually never mind'); void c; }],
    ['employee takeover', 'employee_takeover', async (c: string) => { await takeover(sam, c); }],
    ['conversation closed', 'conversation_closed', async (c: string) => { await setOpen(sam, c, false); }],
    ['customer opt-out (STOP)', 'opted_out', async (c: string) => { void c; await inbound('+14142010721', 'STOP'); }],
    ['do-not-text set by staff', 'opted_out', async (c: string) => { const ct = (await pool.query('SELECT contact_id FROM conversations WHERE id=$1', [c])).rows[0].contact_id; await changeConsent(sam, ct, 'do_not_text_set'); }],
    ['Sandra handling', 'handling_mode_sandra', async (c: string) => { await setHandlingMode(owner, c, 'sandra'); }],
    ['automation paused mode', 'handling_mode_paused', async (c: string) => { await setHandlingMode(owner, c, 'paused'); }],
  ])('pending steps are cancelled on %s (nothing is sent afterwards)', async (_n, reason, act) => {
    const id = await mk('Cancelable', inboundDef([{ type: 'wait', minutes: 60 }, send('automated follow-up text')]));
    await inbound('+14142010721', 'hello'); await drain(); const c = (await pool.query('SELECT id FROM conversations')).rows[0].id;
    expect((await run(id)).status).toBe('waiting'); simulatorControl.reset();
    await act(c); await drain(); await tick();
    const r = await run(id); expect(r.status).toBe('stopped'); expect(r.stop_reason).toBe(reason);
    expect(sentBodies().filter((b) => b.includes('automated follow-up'))).toHaveLength(0);
    expect((await logOf(r.id)).at(-1)!.outcome).toBe('stopped');
  });

  it('global pause holds runs (log says why) and they continue after un-pausing', async () => {
    const id = await mk('Pausable', inboundDef([{ type: 'wait', minutes: 5 }, send('after pause')])); await inbound('+14142010722', 'hi'); await drain();
    await wf.setGlobalPause(owner, true); await tick(); expect(simulatorControl.sent).toHaveLength(0); expect((await logOf((await run(id)).id)).some((l) => l.outcome === 'paused')).toBe(true);
    await wf.setGlobalPause(owner, false); await tick(); expect(sentBodies()).toContain('after pause'); expect((await run(id)).status).toBe('completed');
  });
  it('a paused automation holds its runs; re-activating resumes them; edits create a new version while old runs keep theirs', async () => {
    const id = await mk('Versioned', inboundDef([{ type: 'wait', minutes: 5 }, send('version ONE text')])); await inbound('+14142010723', 'hi'); await drain();
    await wf.setWorkflowStatus(owner, id, 'paused'); await tick(); expect(simulatorControl.sent).toHaveLength(0);
    expect(await wf.updateWorkflow(owner, id, inboundDef([send('version TWO text')]))).toBe(2);
    await wf.setWorkflowStatus(owner, id, 'active'); await tick();
    expect(sentBodies()).toEqual(['version ONE text']); expect((await run(id)).version).toBe(1);
  });
  it('branches choose a path from live conversation data and log why', async () => {
    const id = await mk('Branchy', inboundDef([{ type: 'branch', if: { field: 'message_contains', op: 'contains', value: 'trade' }, then: [{ type: 'add_tag', tag: 'has-trade' }], else: [{ type: 'add_tag', tag: 'no-trade' }] }, { type: 'add_tag', tag: 'after-branch' }]));
    await inbound('+14142010724', 'I want to trade my boat'); await inbound('+14142010725', 'just browsing'); await drain();
    const tags = (await pool.query(`SELECT tags FROM conversations ORDER BY created_at`)).rows.map((r) => r.tags);
    expect(tags[0]).toEqual(expect.arrayContaining(['has-trade', 'after-branch'])); expect(tags[0]).not.toContain('no-trade');
    expect(tags[1]).toEqual(expect.arrayContaining(['no-trade', 'after-branch'])); expect(tags[1]).not.toContain('has-trade');
    expect((await logOf((await run(id)).id)).find((l) => l.step === 'branch')!.detail).toMatch(/Checked message_contains/);
  });
  it('conditions gate whether a run starts at all', async () => {
    await mk('Sales only', inboundDef([{ type: 'add_tag', tag: 'sales-flow' }], { conditions: [{ field: 'department', op: 'is', value: 'sales' }] }));
    await inbound('+14142010726', 'hi'); await drain(); expect((await pool.query('SELECT count(*)::int n FROM workflow_runs')).rows[0].n).toBe(0);
    const cid = (await pool.query('SELECT id FROM conversations')).rows[0].id; await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [cid, s.departments.sales]);
    await inbound('+14142010726', 'hi again'); await drain(); expect((await pool.query('SELECT count(*)::int n FROM workflow_runs')).rows[0].n).toBe(1);
  });
  it('quiet hours defer sends to the end of the window (DST-safe); frequency limits stop runaway texting', async () => {
    const lp = localParts(new Date(), 'America/Chicago'); await settings({ qs: lp.hour, qe: (lp.hour + 1) % 24 });        // quiet right now
    const id = await mk('Quiet', inboundDef([send('quiet test')], { limits: { maxSendsPerContactPerDay: 5, respectQuietHours: true, staffWaitReminderHours: 4, staffWaitEscalateHours: 24 } }));
    await inbound('+14142010727', 'hi'); await drain(); await tick(); expect(simulatorControl.sent).toHaveLength(0);
    const r = await run(id); expect(r.status).toBe('waiting'); expect((await logOf(r.id)).at(-1)!.detail).toMatch(/Quiet hours.*deferred to/);
    expect(new Date(r.next_run_at).getTime()).toBeGreaterThan(Date.now());
    await settings({ ...noQuiet }); await tick(); expect(sentBodies()).toEqual(['quiet test']);
  });
  it('frequency limit: a customer never gets more than the configured automated texts per day', async () => {
    await mk('Chatty', inboundDef([send('automated text')], { limits: { maxSendsPerContactPerDay: 1, respectQuietHours: false, staffWaitReminderHours: 4, staffWaitEscalateHours: 24 } }));
    await inbound('+14142010728', 'one'); await drain(); await inbound('+14142010728', 'two'); await drain();
    expect(sentBodies().filter((b) => b === 'automated text')).toHaveLength(1);
    expect((await pool.query(`SELECT stop_reason FROM workflow_runs WHERE status='stopped'`)).rows[0].stop_reason).toBe('frequency_limit');
  });
  it('loop protection: one active run per conversation and a daily run cap', async () => {
    const id = await mk('Looper', inboundDef([{ type: 'wait', minutes: 600 }, { type: 'add_tag', tag: 'x' }]));
    await inbound('+14142010729', 'one'); await drain();                                       // run 1 waiting
    const cid = (await pool.query('SELECT id FROM conversations')).rows[0].id;
    await pool.query(`UPDATE workflow_runs SET baseline_inbound_at = now() + interval '1 day'`);   // keep it alive so the second inbound doesn't stop it
    await inbound('+14142010729', 'two'); await drain();
    expect((await pool.query('SELECT count(*)::int n FROM workflow_runs')).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int n FROM timeline_events WHERE summary LIKE '%already running%'`)).rows[0].n).toBe(1);
    await pool.query(`UPDATE workflow_runs SET status='completed'`);
    for (let i = 0; i < 6; i++) { await pool.query(`INSERT INTO workflow_runs (workspace_id, workflow_id, version, conversation_id, contact_id, trigger_type, trigger_ref, status) SELECT workspace_id,$1,1,id,contact_id,'inbound_message',$3||$2::text,'completed' FROM conversations WHERE id=$4`, [id, i, 'seed', cid]); }
    await inbound('+14142010729', 'three'); await drain();
    expect((await pool.query(`SELECT count(*)::int n FROM timeline_events WHERE summary LIKE '%run limit%'`)).rows[0].n).toBeGreaterThan(0);
  });
  it('restart recovery: a job whose worker died mid-run is reclaimed and the step executes exactly once; concurrent advances do not double-send', async () => {
    const id = await mk('Durable', inboundDef([{ type: 'wait', minutes: 1 }, send('exactly once')])); await inbound('+14142010730', 'hi'); await drain();
    const r = await run(id);
    await pool.query(`UPDATE jobs SET status='running', attempts=1, locked_until=now() - interval '5 minutes', run_at=now() WHERE kind='workflow_step' AND status='pending'`);   // "worker crashed holding the lease"
    expect(await runOne(handlers)).toBe(true); await drain();
    expect(sentBodies().filter((b) => b === 'exactly once')).toHaveLength(1); expect((await run(id)).status).toBe('completed');
    // concurrent advance of a fresh run
    await pool.query(`UPDATE conversations SET revision=revision`); const id2 = await mk('Durable2', inboundDef([send('race text')])); await inbound('+14142010731', 'hi');
    const cid2 = (await pool.query(`SELECT id FROM conversations WHERE contact_id IN (SELECT contact_id FROM contact_identities WHERE normalized='+14142010731')`)).rows[0].id; const mid2 = (await pool.query(`SELECT id FROM messages WHERE conversation_id=$1`, [cid2])).rows[0].id;
    await wf.handleWorkflowEvent({ type: 'inbound_message', conversationId: cid2, messageId: mid2 }); await pool.query(`UPDATE jobs SET status='cancelled' WHERE kind='workflow_step'`);
    const r2 = await run(id2); await Promise.all([wf.advanceRun(r2.id), wf.advanceRun(r2.id)]); await drain();
    expect(sentBodies().filter((b) => b === 'race text')).toHaveLength(1); void r;
  });
  it('staff can stop a run; stopped runs never act', async () => {
    const id = await mk('Stoppable', inboundDef([{ type: 'wait', minutes: 5 }, send('should never send')])); await inbound('+14142010732', 'hi'); await drain();
    const r = await run(id); await wf.stopRunByStaff(sam, r.id); await tick(); expect(simulatorControl.sent).toHaveLength(0);
    expect((await run(id))).toMatchObject({ status: 'stopped', stop_reason: 'stopped_by_staff' });
  });
});

describe('THE FOLLOW-UP RULE', () => {
  const followDef = (extra: object = {}) => ({ trigger: { type: 'no_response', afterHours: 24 }, conditions: [], steps: [send('Just checking in — still interested?', 'follow_up')], limits: { maxSendsPerContactPerDay: 3, respectQuietHours: false, staffWaitReminderHours: 4, staffWaitEscalateHours: 24 }, ...extra });
  const staffSent = async (phone: string, body: string, hoursAgo: number) => {
    const { conversationId } = await named(phone, 'Dana'); await assign(owner, conversationId, s.users.sam);
    const r = await queueOutbound({ workspaceId: s.workspaceId, conversationId, body, senderType: 'staff', senderUserId: s.users.sam, idempotencyKey: `fu-${phone}-0001` }); await drain();
    await pool.query(`UPDATE conversations SET last_outbound_at = now() - ($2||' hours')::interval WHERE id=$1`, [conversationId, String(hoursAgo)]); simulatorControl.reset();
    return { conversationId, messageId: (r as any).messageId as string };
  };
  it('we sent something and heard nothing for 24h → one follow-up, once', async () => {
    const id = await mk('Follow up', followDef()); const { conversationId } = await staffSent('(414) 201-0740', 'Want to see the 2019 Sea Ray this weekend?', 25);
    expect(await wf.scanNoResponse()).toBe(1); expect(await wf.scanNoResponse()).toBe(0);      // idempotent per outbound message
    await drain(); expect(sentBodies()).toEqual(['Just checking in — still interested?']);
    expect((await run(id)).status).toBe('completed'); expect((await conv(conversationId)).responsibility).toBe('waiting_on_customer');
    expect((await pool.query(`SELECT auto_kind FROM messages WHERE auto_kind IS NOT NULL`)).rows[0].auto_kind).toBe('follow_up');
  });
  it('NOT started before the wait elapses, and not for threads where we owe the customer', async () => {
    await mk('Follow up', followDef()); await staffSent('(414) 201-0741', 'Quick question?', 5);
    const owed = await staffSent('(414) 201-0742', 'Let me check on that and get back to you', 30); await setResponsibility(owner, owed.conversationId, 'waiting_on_staff');
    expect(await wf.scanNoResponse()).toBe(0); await drain(); expect(simulatorControl.sent).toHaveLength(0);
  });
  it('when staff OWE the customer, follow-ups are PAUSED: assigned employee is reminded, then managers are escalated; follow-up resumes only after staff respond', async () => {
    const id = await mk('Follow up', followDef()); const { conversationId } = await staffSent('(414) 201-0743', 'Is the 22ft still what you want?', 25);
    expect(await wf.scanNoResponse()).toBe(1);
    // staff realise they owe info and correct the state BEFORE the follow-up fires
    await pool.query(`UPDATE jobs SET status='cancelled' WHERE kind='workflow_step'`); await setResponsibility(sam, conversationId, 'waiting_on_staff');
    const r = await run(id); await wf.advanceRun(r.id);
    expect(simulatorControl.sent).toHaveLength(0); expect((await logOf(r.id)).some((l) => l.outcome === 'held' && /ON HOLD/.test(l.detail))).toBe(true);
    expect((await listNotifications(sam)).items.some((n) => n.type === 'staff_wait_reminder')).toBe(false);   // not yet: reminder after 4h
    await pool.query(`UPDATE workflow_runs SET staff_wait_since = now() - interval '5 hours' WHERE id=$1`, [r.id]); await wf.advanceRun(r.id);
    expect((await listNotifications(sam)).items.filter((n) => n.type === 'staff_wait_reminder')).toHaveLength(1);           // reminded the ASSIGNED employee
    await wf.advanceRun(r.id); expect((await listNotifications(sam)).items.filter((n) => n.type === 'staff_wait_reminder')).toHaveLength(1);   // only once
    expect((await listNotifications(owner)).items.some((n) => n.type === 'staff_wait_escalation')).toBe(false);
    await pool.query(`UPDATE workflow_runs SET staff_wait_since = now() - interval '25 hours' WHERE id=$1`, [r.id]); await wf.advanceRun(r.id);
    expect((await listNotifications(owner)).items.some((n) => n.type === 'staff_wait_escalation')).toBe(true);               // escalated to managers/owner
    expect(simulatorControl.sent).toHaveLength(0);                                                                           // never texted the customer while we owed them
    expect((await run(id)).status).toBe('waiting');
    await setResponsibility(sam, conversationId, 'waiting_on_customer'); await wf.advanceRun(r.id);                         // staff delivered; ball is in customer's court
    await drain();
    expect(sentBodies()).toEqual(['Just checking in — still interested?']); expect((await run(id)).status).toBe('completed');
    expect((await logOf(r.id)).map((l) => l.outcome)).toEqual(expect.arrayContaining(['held', 'reminded', 'escalated', 'resumed', 'sent']));
  });
  it('a customer reply or an employee takeover cancels the pending follow-up', async () => {
    const id = await mk('Follow up', followDef({ steps: [{ type: 'wait', minutes: 60 }, send('Checking in', 'follow_up')] }));
    const a = await staffSent('(414) 201-0744', 'Still looking?', 30); await wf.scanNoResponse(); await drain();
    await inbound('+14142010744', 'yes, still looking!'); await tick(); expect((await run(id)).stop_reason).toBe('customer_replied');
    const b = await staffSent('(414) 201-0745', 'Still looking?', 30); await wf.scanNoResponse(); await drain(); await takeover(sam, b.conversationId); await tick();
    expect((await pool.query(`SELECT stop_reason FROM workflow_runs WHERE conversation_id=$1`, [b.conversationId])).rows[0].stop_reason).toBe('employee_takeover');
    expect(sentBodies().filter((x) => x === 'Checking in')).toHaveLength(0); void a;
  });
  it('requireQuestion: no follow-up when our last message asked nothing', async () => {
    const id = await mk('Follow up', followDef({ steps: [send('Checking in', 'follow_up', { requireQuestion: true })] }));
    await staffSent('(414) 201-0746', 'Thanks, see you Saturday.', 30); await wf.scanNoResponse(); await drain();
    expect(simulatorControl.sent).toHaveLength(0); expect((await logOf((await run(id)).id)).some((l) => l.outcome === 'skipped')).toBe(true);
  });
  it('inbound-triggered follow-ups also respect it: customer wrote, staff never replied → reminders, no customer text', async () => {
    const id = await mk('Nudge', inboundDef([{ type: 'wait', minutes: 30 }, send('Any update?', 'follow_up')])); await inbound('+14142010747', 'need a quote'); await drain();
    await tick(); const r = await run(id); expect(simulatorControl.sent).toHaveLength(0); expect(r.status).toBe('waiting');   // responsibility = needs_our_reply → held
    expect((await logOf(r.id)).some((l) => l.outcome === 'held')).toBe(true);
  });
});

describe('dry-run & inventory trigger', () => {
  it('dry-run shows what would happen with no side effects, and explains blocks', async () => {
    const { conversationId } = await named('(414) 201-0750'); await setResponsibility(sam, conversationId, 'waiting_on_staff'); await alwaysOpen();
    const def = { trigger: { type: 'no_response', afterHours: 24 }, conditions: [{ field: 'department', op: 'is_not', value: 'financing' }], steps: [{ type: 'wait', minutes: 120, businessHoursOnly: true }, send('Checking in', 'follow_up')] };
    const d = await wf.dryRun(sam, def, conversationId);
    expect(d.conditionsMet).toBe(true); expect(d.plan.map((p) => p.step)).toEqual(['wait', 'send_message']);
    expect(d.plan[1]).toMatchObject({ blocked: true }); expect(d.plan[1].result).toMatch(/owe the customer.*HELD.*reminded/);
    const none = await wf.dryRun(sam, { ...def, conditions: [{ field: 'department', op: 'is', value: 'financing' }] }, conversationId); expect(none.conditionsMet).toBe(false);
    const ext = await wf.dryRun(sam, { trigger: { type: 'invoice_state', event: 'overdue' }, steps: [send('Invoice due')] }); expect(ext.notes.join(' ')).toMatch(/cannot be activated yet/);
    expect((await pool.query('SELECT count(*)::int n FROM workflow_runs')).rows[0].n).toBe(0); expect(simulatorControl.sent).toHaveLength(0);
  });
  it('inventory_update trigger contacts ONLY customers who marked interest in that boat, on a real price drop', async () => {
    const inv = await import('../src/domain/inventory.js');
    const { contactId } = await named('(414) 201-0751', 'Ivy'); const other = await named('(414) 201-0752', 'Ned');
    await pool.query(`INSERT INTO workflow_runs SELECT * FROM workflow_runs WHERE false`);
    await inv.upsertBoats(owner, 'manual', [{ externalId: 'W1', status: 'available', year: 2019, make: 'Sea Ray', model: 'SLX', boatType: 'bowrider', lengthFt: 25, price: 32000, features: [], mediaIds: [] }]);
    await inv.setPreferences(sam, contactId, { budgetMax: 40000 }); await inv.setPreferences(sam, other.contactId, { budgetMax: 40000 }); await drain();
    const boat = (await pool.query('SELECT id FROM inventory_boats')).rows[0].id; await inv.matchFeedback(sam, contactId, boat, 'interested');
    const id = await mk('Price drop', { trigger: { type: 'inventory_update', change: 'price_drop' }, conditions: [], steps: [send('Good news: the boat you liked just dropped in price.')], limits: { maxSendsPerContactPerDay: 2, respectQuietHours: false, staffWaitReminderHours: 4, staffWaitEscalateHours: 24 } });
    await inv.upsertBoats(owner, 'manual', [{ externalId: 'W1', status: 'available', year: 2019, make: 'Sea Ray', model: 'SLX', boatType: 'bowrider', lengthFt: 25, price: 30000, features: [], mediaIds: [] }]);
    await drain(); await tick();
    expect(sentBodies()).toEqual(['Good news: the boat you liked just dropped in price.']); expect((await run(id)).contact_id).toBe(contactId);
    simulatorControl.reset(); await inv.upsertBoats(owner, 'manual', [{ externalId: 'W1', status: 'available', year: 2019, make: 'Sea Ray', model: 'SLX', boatType: 'bowrider', lengthFt: 25, price: 31000, features: [], mediaIds: [] }]);   // price INCREASE
    await drain(); await tick(); expect(simulatorControl.sent).toHaveLength(0);
  });
});
