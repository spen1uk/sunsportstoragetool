import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { actor, newCustomerConvo, resetDb, type Seeded } from './helpers.js';
import * as an from '../src/domain/analytics.js';
import { buildApp } from '../src/server/app.js';

let s: Seeded; let sam: ReturnType<typeof actor>; let owner: ReturnType<typeof actor>; let sue: ReturnType<typeof actor>;
beforeEach(async () => { s = await resetDb(); sam = { ...actor(s, 'sam', 'staff', ['sales']), name: 'Sam' }; sue = { ...actor(s, 'sue', 'staff', ['service']), name: 'Sue' }; owner = { ...actor(s, 'owner', 'owner'), name: 'Owner' }; });
afterAll(() => pool.end());

const T0 = new Date('2026-07-01T15:00:00Z');   // 10:00 CDT
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const range = { from: new Date('2026-06-30T00:00:00Z'), to: new Date('2026-07-03T00:00:00Z'), tz: 'America/Chicago' };
async function msg(conversationId: string, direction: 'inbound' | 'outbound', body: string, when: Date, o: { sender?: string; status?: string; detail?: string; auto?: string; user?: string } = {}) {
  await pool.query(`INSERT INTO messages (workspace_id, conversation_id, direction, sender_type, sender_user_id, body, status, status_detail, auto_kind, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [s.workspaceId, conversationId, direction, o.sender ?? (direction === 'inbound' ? 'customer' : 'staff'), direction === 'outbound' && (o.sender ?? 'staff') === 'staff' ? (o.user ?? s.users.sam) : null, body, o.status ?? (direction === 'inbound' ? 'received' : 'delivered'), o.detail ?? null, o.auto ?? null, when]);
}

describe('analytics definitions and math', () => {
  it('response times: only human replies count; automation does not; unanswered turns reported separately; hand-computed median/p90', async () => {
    const { conversationId: c } = await newCustomerConvo(s, sam, '(414) 201-0901');
    await msg(c, 'inbound', 'hi', at(0)); await msg(c, 'outbound', 'Hello!', at(10));                                  // turn 1: 10 min
    await msg(c, 'inbound', 'price?', at(60)); await msg(c, 'outbound', 'Thanks for texting', at(61), { sender: 'automation', auto: 'first_contact' }); await msg(c, 'outbound', '$30k', at(105));   // turn 2: 45 min (auto reply ignored)
    await msg(c, 'inbound', 'can I come tomorrow?', at(200)); await msg(c, 'inbound', 'hello?', at(201));                    // turn 3: unanswered; second inbound is NOT a new turn
    const d = await an.buildAnalytics(owner, range);
    expect(d.responsiveness.firstHumanResponse).toMatchObject({ turnsInRange: 3, answered: 2, stillWaiting: 1, medianMinutes: 27.5, p90Minutes: 45 });
    expect(d.definitions.firstHumanResponse).toMatch(/Automatic replies.*do NOT count/);
  });
  it('volume by day uses the requested timezone; by department/channel/team member; suppressed sends are not counted as outbound', async () => {
    const { conversationId: c } = await newCustomerConvo(s, sam, '(414) 201-0902'); await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [c, s.departments.sales]);
    await msg(c, 'inbound', 'late night', new Date('2026-07-01T04:30:00Z'));      // 11:30 PM Jun 30 in Chicago
    await msg(c, 'inbound', 'morning', new Date('2026-07-01T15:00:00Z')); await msg(c, 'outbound', 'reply', new Date('2026-07-01T15:05:00Z')); await msg(c, 'outbound', 'blocked', new Date('2026-07-01T15:06:00Z'), { status: 'suppressed', detail: 'do_not_text' });
    const d = await an.buildAnalytics(owner, range);
    expect(d.volume.byDay).toEqual([{ date: '2026-06-30', inbound: 1, outbound: 0 }, { date: '2026-07-01', inbound: 1, outbound: 1 }]);
    expect(d.volume.byDepartment).toEqual([{ department: 'Sales', inbound: 2, outbound: 1 }]); expect(d.volume.byChannel).toEqual([{ channel: 'sms (demo)', inbound: 2, outbound: 1 }]);
    expect(d.volume.byTeamMember).toEqual([{ user: 'Sam Sales', sent: 1 }]); expect(d.meta).toMatchObject({ timezone: 'America/Chicago', scope: 'whole workspace' });
    const utc = await an.buildAnalytics(owner, { ...range, tz: 'UTC' }); expect(utc.volume.byDay.map((x) => x.date)).toEqual(['2026-07-01']);
  });
  it('delivery keeps provider acceptance separate from delivery; problems list reasons', async () => {
    const { conversationId: c } = await newCustomerConvo(s, sam, '(414) 201-0903');
    for (const [st, det] of [['provider_accepted', null], ['provider_accepted', null], ['delivered', null], ['failed', 'invalid number'], ['unknown', 'timeout'], ['suppressed', 'sms_opted_out']] as const) await msg(c, 'outbound', 'x', at(1), { status: st, detail: det ?? undefined });
    const d = await an.buildAnalytics(owner, range);
    expect(Object.fromEntries(d.delivery.byStatus.map((x) => [x.status, x.n]))).toEqual({ provider_accepted: 2, delivered: 1, failed: 1, unknown: 1, suppressed: 1 });
    expect(d.delivery.problems.map((x) => `${x.status}:${x.reason}`).sort()).toEqual(['failed:invalid number', 'suppressed:sms_opted_out', 'unknown:timeout']);
    expect(d.definitions.delivery).toMatch(/NOT delivery/);
  });
  it('unanswered snapshot, overdue tasks, freshness, honest unavailable sections, no attribution/revenue fields', async () => {
    const { conversationId: c } = await newCustomerConvo(s, sam, '(414) 201-0904'); await msg(c, 'inbound', 'help', new Date(Date.now() - 3 * 3600_000));
    await pool.query(`UPDATE conversations SET responsibility='needs_our_reply', last_inbound_at = now() - interval '3 hours' WHERE id=$1`, [c]);
    await pool.query(`INSERT INTO tasks (workspace_id, title, assignee_user_id, created_by, due_at) VALUES ($1,'late',$2,$2,now() - interval '1 day'), ($1,'later',$2,$2,now() + interval '1 day')`, [s.workspaceId, s.users.sam]);
    const d = await an.buildAnalytics(owner, { from: new Date(Date.now() - 86400_000), to: new Date(Date.now() + 60_000), tz: 'America/Chicago' });
    expect(d.responsiveness.unansweredNow).toEqual({ total: 1, over1h: 1, over24h: 0 }); expect(d.tasks).toMatchObject({ open: 2, overdue: 1 }); expect(d.tasks.overdueByAssignee).toEqual([{ assignee: 'Sam Sales', overdue: 1 }]);
    expect(d.meta.dataThrough).not.toBeNull(); expect(d.meta.generatedAt).toBeInstanceOf(Date); expect(Object.keys(d.unavailable)).toEqual(['appointments', 'reviews', 'payments']);
    expect(JSON.stringify(d)).not.toMatch(/attribution":|revenue":|"sales_/i);
  });
  it('is permission-scoped: department staff see only conversations they can access; admins see everything; staff get only their own task numbers', async () => {
    const a = await newCustomerConvo(s, sam, '(414) 201-0905'); const b = await newCustomerConvo(s, sam, '(414) 201-0906');
    await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [a.conversationId, s.departments.sales]); await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [b.conversationId, s.departments.financing]);
    await msg(a.conversationId, 'inbound', 'sales q', at(0)); await msg(b.conversationId, 'inbound', 'financing q', at(0)); await msg(b.conversationId, 'inbound', 'financing q2', at(1));
    expect((await an.buildAnalytics(sam, range)).volume.totals.inbound).toBe(1); expect((await an.buildAnalytics(owner, range)).volume.totals.inbound).toBe(3);
    expect((await an.buildAnalytics(sue, range)).volume.totals.inbound).toBe(0);
    await pool.query(`INSERT INTO tasks (workspace_id, title, assignee_user_id, created_by, due_at) VALUES ($1,'t1',$2,$2,now() - interval '1 day'), ($1,'t2',$3,$3,now() - interval '1 day')`, [s.workspaceId, s.users.sam, s.users.sue]);
    expect((await an.buildAnalytics(sam, range)).tasks).toMatchObject({ open: 1, overdue: 1, overdueByAssignee: [] }); expect((await an.buildAnalytics(owner, range)).tasks.open).toBe(2);
    expect((await an.buildAnalytics(sam, range)).volume.byTeamMember).toEqual([]);
  });
  it('costs: SMS unknown without a rate, estimated with one; AI sums only recorded costs', async () => {
    const { conversationId: c } = await newCustomerConvo(s, sam, '(414) 201-0907'); await msg(c, 'outbound', 'a'.repeat(200), at(1), { status: 'provider_accepted' });
    expect((await an.buildAnalytics(owner, range)).costs.sms).toMatchObject({ estimatedSegments: 2, estimatedUsd: null });
    await pool.query(`INSERT INTO workspace_settings VALUES ($1,'sms_cost_per_segment','0.01',NULL)`, [s.workspaceId]); expect((await an.buildAnalytics(owner, range)).costs.sms.estimatedUsd).toBe(0.02);
    await pool.query(`INSERT INTO ai_usage (workspace_id, provider, model, purpose, cost_usd, created_at) VALUES ($1,'heuristic','rules','x',0,$2), ($1,'llm','m','x',NULL,$2)`, [s.workspaceId, at(1)]);
    expect((await an.buildAnalytics(owner, range)).costs.ai.byProvider).toEqual(expect.arrayContaining([expect.objectContaining({ provider: 'llm', unknown_cost_calls: 1 })]));
  });
  it('range validation; CSV export escapes and neutralises spreadsheet formulas; broadcasts export is manager-only', async () => {
    expect(() => an.parseRange({ from: '2026-07-02', to: '2026-07-01' }, 'UTC')).toThrow(/invalid/); expect(() => an.parseRange({ from: '2024-01-01', to: '2026-07-01' }, 'UTC')).toThrow(/too long/); expect(() => an.parseRange({ tz: 'Mars/Base' }, 'UTC')).toThrow(/timezone/);
    await pool.query(`UPDATE departments SET name='=HYPERLINK("http://evil","x")' WHERE id=$1`, [s.departments.sales]);
    const { conversationId: c } = await newCustomerConvo(s, sam, '(414) 201-0908'); await pool.query('UPDATE conversations SET department_id=$2 WHERE id=$1', [c, s.departments.sales]); await msg(c, 'inbound', 'hi', at(0));
    const csv = (await an.exportReport(owner, 'volume_by_department', range)).csv; expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`); expect(csv.split('\n')[0]).toBe('department,inbound,outbound');
    await expect(an.exportReport(sam, 'broadcasts', range)).rejects.toThrow(/manager/); await expect(an.exportReport(sam, 'nope', range)).rejects.toThrow(/unknown report/);
  });
  it('automation section reports runs by outcome and replied-within-48h as a fact, not causation', async () => {
    const { conversationId: c } = await newCustomerConvo(s, sam, '(414) 201-0909');
    await msg(c, 'outbound', 'Checking in', at(0), { sender: 'automation', auto: 'follow_up' }); await msg(c, 'inbound', 'yes!', at(30)); await msg(c, 'outbound', 'Checking in again', at(1000), { sender: 'automation', auto: 'follow_up' });
    const w = (await pool.query(`INSERT INTO workflows (workspace_id, name) VALUES ($1,'Follow up') RETURNING id`, [s.workspaceId])).rows[0].id; await pool.query(`INSERT INTO workflow_versions VALUES ($1,1,'{}',NULL)`, [w]);
    const ct = (await pool.query('SELECT contact_id FROM conversations WHERE id=$1', [c])).rows[0].contact_id;
    await pool.query(`INSERT INTO workflow_runs (workspace_id, workflow_id, version, conversation_id, contact_id, trigger_type, trigger_ref, status, stop_reason, created_at) VALUES ($1,$2,1,$3,$4,'no_response','a','completed',NULL,$5), ($1,$2,1,$3,$4,'no_response','b','stopped','customer_replied',$5)`, [s.workspaceId, w, c, ct, at(5)]);
    const d = await an.buildAnalytics(owner, range);
    expect(d.automation.autoMessages).toEqual([{ kind: 'follow_up', sent: 2, replied_48h: 1 }]);
    expect(d.automation.runs).toEqual(expect.arrayContaining([{ workflow: 'Follow up', status: 'completed', reason: '', n: 1 }, { workflow: 'Follow up', status: 'stopped', reason: 'customer_replied', n: 1 }]));
    expect(d.definitions.automation).toMatch(/not that the automation caused it/);
  });
});

describe('phase 4 API', () => {
  it('permissions, validation, settings round-trip, dry-run, broadcast flow, analytics + CSV over HTTP', async () => {
    const app = await buildApp();
    const login = async (email: string) => { const r = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-relay-csrf': '1' }, payload: { email, password: 'test-password-123' } }); return (r.headers['set-cookie'] as string).split(';')[0]; };
    const call = async (cookie: string, method: string, url: string, payload?: object) => { const r = await app.inject({ method: method as any, url, headers: { cookie, 'x-relay-csrf': '1' }, payload }); return { status: r.statusCode, body: r.body && r.headers['content-type']?.toString().includes('json') ? JSON.parse(r.body) : r.body, headers: r.headers }; };
    const mgr = await login('owner@demo.relay.test'), stf = await login('sam@demo.relay.test');
    // settings
    expect((await call(stf, 'PUT', '/api/automation/settings', { hours: [] })).status).toBe(403);
    expect((await call(mgr, 'PUT', '/api/automation/settings', { hours: [{ weekday: 1, closed: false, open: '17:00', close: '09:00' }] })).status).toBe(400);
    expect((await call(mgr, 'PUT', '/api/automation/settings', { hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, closed: false, open: '09:00', close: '17:00' })), holidays: [{ day: '2026-12-25', name: 'Christmas', closed: true, notice: 'Merry Christmas — closed today.' }], autoResponse: { enabled: false, firstContactMessage: 'Hi!', afterHoursMessage: null, holidayMessage: null, cadenceHours: 12, quietStartHour: 21, quietEndHour: 8 } })).status).toBe(200);
    const st = (await call(stf, 'GET', '/api/automation/settings')).body; expect(st.hoursConfigured).toBe(true); expect(st.holidays[0]).toMatchObject({ day: '2026-12-25', name: 'Christmas' }); expect(st.triggerAdapters.appointment_event.verified).toBe(false);
    // workflows
    const def = { trigger: { type: 'inbound_message' }, steps: [{ type: 'add_tag', tag: 'seen' }] };
    expect((await call(stf, 'POST', '/api/workflows', { name: 'W', definition: def })).status).toBe(403);
    expect((await call(mgr, 'POST', '/api/workflows', { name: 'W', definition: { trigger: { type: 'evil' }, steps: [] } })).status).toBe(400);
    const wid = (await call(mgr, 'POST', '/api/workflows', { name: 'W', definition: def })).body.id; expect((await call(mgr, 'POST', `/api/workflows/${wid}/status`, { status: 'active' })).status).toBe(200);
    expect((await call(stf, 'POST', '/api/workflows/dry-run', { definition: def })).body.plan.length).toBeGreaterThan(0);
    expect((await call(stf, 'POST', `/api/workflows/${wid}/status`, { status: 'paused' })).status).toBe(403);
    expect((await call(stf, 'POST', '/api/automation/global-pause', { paused: true })).status).toBe(403); expect((await call(mgr, 'POST', '/api/automation/global-pause', { paused: true })).status).toBe(200); await call(mgr, 'POST', '/api/automation/global-pause', { paused: false });
    // broadcasts
    const c = (await call(mgr, 'POST', '/api/contacts', { firstName: 'Zed', phone: '(414) 201-0950', tags: ['vip'] })).body.id; await call(mgr, 'POST', `/api/contacts/${c}/consent`, { type: 'marketing_opt_in', evidence: 'form' });
    expect((await call(stf, 'POST', '/api/broadcasts', { name: 'B', purpose: 'marketing', body: 'Hi {{first_name}}', audience: { tags: ['vip'] } })).status).toBe(403);
    const bid = (await call(mgr, 'POST', '/api/broadcasts', { name: 'B', purpose: 'marketing', body: 'Hi {{first_name}}', audience: { tags: ['vip'] } })).body.id;
    const pv = (await call(mgr, 'POST', `/api/broadcasts/${bid}/preview`)).body; expect(pv).toMatchObject({ eligibleCount: 1, excludedCount: 0 }); expect(pv.samples[0].text).toBe('Hi Zed');
    expect((await call(stf, 'POST', `/api/broadcasts/${bid}/approve`, { sendNow: true })).status).toBe(403); expect((await call(mgr, 'POST', `/api/broadcasts/${bid}/approve`, { sendNow: true })).body.eligible).toBe(1);
    expect((await call(mgr, 'PUT', `/api/broadcasts/${bid}`, { name: 'x', purpose: 'marketing', body: 'x', audience: { tags: ['vip'] } })).status).toBe(409);   // approved → locked
    expect((await call(mgr, 'POST', `/api/broadcasts/${bid}/cancel`)).status).toBe(200);
    // analytics
    const an1 = await call(stf, 'GET', '/api/analytics'); expect(an1.status).toBe(200); expect(an1.body.meta.scope).toBe('conversations visible to you');
    expect((await call(stf, 'GET', '/api/analytics?from=2026-07-02&to=2026-07-01')).status).toBe(400);
    const csv = await call(mgr, 'GET', '/api/analytics/export?report=volume_by_day'); expect(csv.status).toBe(200); expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.headers['content-disposition']).toContain('volume_by_day.csv');
    expect((await call(stf, 'GET', '/api/analytics/export?report=broadcasts')).status).toBe(403);
    await app.close();
  });
});
