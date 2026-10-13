import { pool } from '../db/pool.js';
import { HttpError, atLeastManager, isAdmin, visibilitySql, type Actor } from './authz.js';
import { assertTimezone } from './time.js';

export interface Range { from: Date; to: Date; tz: string }
export function parseRange(q: { from?: string; to?: string; tz?: string }, defaultTz: string): Range {
  const tz = q.tz ?? defaultTz; try { assertTimezone(tz); } catch { throw new HttpError(400, 'unknown timezone'); }
  const to = q.to ? new Date(q.to) : new Date(); const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) throw new HttpError(400, 'invalid date range');
  if (to.getTime() - from.getTime() > 400 * 86400_000) throw new HttpError(400, 'date range too long (max 400 days)');
  return { from, to, tz };
}

export const DEFINITIONS = {
  volume: 'Messages by direction in the range. Automatic acknowledgments, follow-ups and broadcasts are included and also broken out under Automation.',
  unansweredNow: 'Open conversations currently marked "Needs our reply" (the customer wrote last and we have not responded). A snapshot as of generation time, not limited by the date range.',
  firstHumanResponse: 'For each customer "turn" — an inbound message that follows our message or starts a conversation — the wall-clock minutes until the first reply sent by a staff member. Automatic replies, Sandra, and broadcasts do NOT count. Business hours are not excluded. Turns still waiting are reported separately, not averaged in.',
  delivery: 'Outbound messages by the status the system has actually recorded. "Accepted by provider" means the provider took the message; it is NOT delivery. Statuses only advance when the provider reports them.',
  automation: 'Workflow runs started in the range by how they ended, and texts sent by automation. "Replied within 48h" counts customer messages that arrived within 48 hours after an automated text — it shows a reply followed, not that the automation caused it.',
  costs: 'Estimates only. SMS cost = estimated segments × the rate you entered in settings (blank = unknown; carrier fees not included). AI cost sums only calls where a cost was recorded. Hosting and provider invoices are not tracked here.',
} as const;

export async function buildAnalytics(a: Actor, r: Range) {
  const v = visibilitySql(a, 'c', 4); const scope = isAdmin(a) ? 'whole workspace' : 'conversations visible to you';
  const base = [a.workspaceId, r.from, r.to, ...v.params]; // $1 ws, $2 from, $3 to, then visibility params from $4
  const tzIdx = base.length + 1;
  const msgFilter = `m.workspace_id=$1 AND m.created_at >= $2 AND m.created_at < $3 AND ${v.sql}`;
  const join = `FROM messages m JOIN conversations c ON c.id=m.conversation_id`;

  const [byDay, byDept, byChannel, byUser, latest] = await Promise.all([
    pool.query(`SELECT to_char((m.created_at AT TIME ZONE $${tzIdx})::date,'YYYY-MM-DD') AS date, count(*) FILTER (WHERE m.direction='inbound')::int AS inbound, count(*) FILTER (WHERE m.direction='outbound' AND m.status<>'suppressed')::int AS outbound ${join} WHERE ${msgFilter} GROUP BY 1 ORDER BY 1`, [...base, r.tz]),
    pool.query(`SELECT COALESCE(d.name,'Unrouted') AS department, count(*) FILTER (WHERE m.direction='inbound')::int AS inbound, count(*) FILTER (WHERE m.direction='outbound' AND m.status<>'suppressed')::int AS outbound ${join} LEFT JOIN departments d ON d.id=c.department_id WHERE ${msgFilter} GROUP BY 1 ORDER BY 2 DESC`, base),
    pool.query(`SELECT ch.kind || CASE WHEN ch.is_simulated THEN ' (demo)' ELSE '' END AS channel, count(*) FILTER (WHERE m.direction='inbound')::int AS inbound, count(*) FILTER (WHERE m.direction='outbound' AND m.status<>'suppressed')::int AS outbound ${join} JOIN channels ch ON ch.id=c.channel_id WHERE ${msgFilter} GROUP BY 1`, base),
    atLeastManager(a) ? pool.query(`SELECT u.name AS user, count(*)::int AS sent ${join} JOIN users u ON u.id=m.sender_user_id WHERE ${msgFilter} AND m.direction='outbound' AND m.sender_type='staff' AND m.status<>'suppressed' GROUP BY 1 ORDER BY 2 DESC`, base) : Promise.resolve({ rows: [] }),
    pool.query(`SELECT max(m.created_at) AS t ${join} WHERE m.workspace_id=$1 AND ${v.sql.replace(/\$4/g, '$2').replace(/\$5/g, '$3')}`, [a.workspaceId, ...v.params]),
  ]);

  const unanswered = (await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.last_inbound_at < now() - interval '1 hour')::int AS over_1h, count(*) FILTER (WHERE c.last_inbound_at < now() - interval '24 hours')::int AS over_24h
     FROM conversations c WHERE c.workspace_id=$1 AND c.status='open' AND c.responsibility='needs_our_reply' AND ${v.sql.replace(/\$4/g, '$2').replace(/\$5/g, '$3')}`, [a.workspaceId, ...v.params])).rows[0];

  const o = 2 + v.params.length;   // first free parameter index after workspace + visibility params
  const turns = (await pool.query(
    `WITH ordered AS (
       SELECT m.id, m.conversation_id, m.seq, m.direction, m.created_at, lag(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.seq) AS prev_dir
       FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.workspace_id=$1 AND m.status NOT IN ('suppressed','failed') AND ${v.sql.replace(/\$4/g, '$2').replace(/\$5/g, '$3')}),
     t AS (SELECT * FROM ordered WHERE direction='inbound' AND (prev_dir IS NULL OR prev_dir='outbound') AND created_at >= $${o} AND created_at < $${o + 1})
     SELECT t.id, t.conversation_id, t.created_at, (SELECT min(r.created_at) FROM messages r WHERE r.conversation_id=t.conversation_id AND r.seq>t.seq AND r.direction='outbound' AND r.sender_type='staff' AND r.auto_kind IS NULL AND r.status NOT IN ('suppressed','failed')) AS replied_at FROM t`, [a.workspaceId, ...v.params, r.from, r.to])).rows;
  const mins = turns.filter((t) => t.replied_at).map((t) => (new Date(t.replied_at).getTime() - new Date(t.created_at).getTime()) / 60000).sort((x, y) => x - y);
  const pct = (p: number) => (mins.length ? Math.round(mins[Math.min(mins.length - 1, Math.ceil(p * mins.length) - 1)] * 10) / 10 : null);
  const median = mins.length ? Math.round((mins.length % 2 ? mins[(mins.length - 1) / 2] : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2) * 10) / 10 : null;

  const taskScope = atLeastManager(a) ? 'AND $2::uuid IS NOT NULL' : 'AND t.assignee_user_id=$2';
  const tasks = (await pool.query(`SELECT count(*) FILTER (WHERE t.status='open')::int AS open, count(*) FILTER (WHERE t.status='open' AND t.due_at < now())::int AS overdue, count(*) FILTER (WHERE t.status='done' AND t.completed_at >= $3 AND t.completed_at < $4)::int AS completed_in_range FROM tasks t WHERE t.workspace_id=$1 ${taskScope}`, [a.workspaceId, a.userId, r.from, r.to])).rows[0];
  const overdueBy = atLeastManager(a) ? (await pool.query(`SELECT u.name AS assignee, count(*)::int AS overdue FROM tasks t JOIN users u ON u.id=t.assignee_user_id WHERE t.workspace_id=$1 AND t.status='open' AND t.due_at < now() GROUP BY 1 ORDER BY 2 DESC`, [a.workspaceId])).rows : [];

  const delivery = (await pool.query(`SELECT m.status, count(*)::int AS n ${join} WHERE ${msgFilter} AND m.direction='outbound' GROUP BY 1 ORDER BY 2 DESC`, base)).rows;
  const failures = (await pool.query(`SELECT COALESCE(m.status_detail,'(no detail)') AS reason, m.status, count(*)::int AS n ${join} WHERE ${msgFilter} AND m.direction='outbound' AND m.status IN ('failed','unknown','suppressed') GROUP BY 1,2 ORDER BY 3 DESC LIMIT 15`, base)).rows;

  const runs = (await pool.query(`SELECT w.name AS workflow, r.status, COALESCE(r.stop_reason,'') AS reason, count(*)::int AS n FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id JOIN conversations c ON c.id=r.conversation_id WHERE r.workspace_id=$1 AND r.created_at >= $2 AND r.created_at < $3 AND ${v.sql} GROUP BY 1,2,3 ORDER BY 1,4 DESC`, base)).rows;
  const autoMsgs = (await pool.query(`SELECT m.auto_kind AS kind, count(*)::int AS sent, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages rep WHERE rep.conversation_id=m.conversation_id AND rep.direction='inbound' AND rep.created_at > m.created_at AND rep.created_at < m.created_at + interval '48 hours'))::int AS replied_48h ${join} WHERE ${msgFilter} AND m.auto_kind IS NOT NULL AND m.status<>'suppressed' GROUP BY 1`, base)).rows;
  const bcasts = atLeastManager(a) ? (await pool.query(
    `SELECT b.id, b.name, b.purpose, b.status, count(r.id)::int AS recipients, count(*) FILTER (WHERE m.status IS NOT NULL AND m.status NOT IN ('suppressed','failed'))::int AS sent, count(*) FILTER (WHERE m.status='delivered')::int AS delivered, count(*) FILTER (WHERE m.status='failed')::int AS failed, count(*) FILTER (WHERE r.status IN ('suppressed','skipped') OR m.status='suppressed')::int AS not_sent,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM messages rep WHERE rep.conversation_id=m.conversation_id AND rep.direction='inbound' AND rep.created_at > m.created_at AND rep.created_at < m.created_at + interval '48 hours'))::int AS replied_48h
     FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.broadcast_id=b.id LEFT JOIN messages m ON m.id=r.message_id WHERE b.workspace_id=$1 AND b.created_at >= $2 AND b.created_at < $3 GROUP BY b.id ORDER BY b.created_at DESC`, [a.workspaceId, r.from, r.to])).rows : [];

  const segRows = (await pool.query(`SELECT m.body ${join} WHERE ${msgFilter} AND m.direction='outbound' AND m.status IN ('provider_accepted','delivered','sending','unknown')`, base)).rows;
  const { smsSegments } = await import('./segments.js'); const segments = segRows.reduce((n, x) => n + smsSegments(x.body).segments, 0);
  const rate = (await pool.query(`SELECT value FROM workspace_settings WHERE workspace_id=$1 AND key='sms_cost_per_segment'`, [a.workspaceId])).rows[0]?.value;
  const ai = atLeastManager(a) ? (await pool.query(`SELECT count(*)::int AS calls, COALESCE(sum(cost_usd),0)::float AS known_usd, count(*) FILTER (WHERE cost_usd IS NULL)::int AS unknown_cost_calls, provider FROM ai_usage WHERE workspace_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY provider`, [a.workspaceId, r.from, r.to])).rows : [];

  return {
    meta: { from: r.from, to: r.to, timezone: r.tz, generatedAt: new Date(), dataThrough: latest.rows[0]?.t ?? null, scope, note: 'Computed live from recorded messages, tasks and runs. Sales attribution is not computed.' },
    definitions: DEFINITIONS,
    volume: { byDay: byDay.rows, byDepartment: byDept.rows, byChannel: byChannel.rows, byTeamMember: byUser.rows, totals: { inbound: byDay.rows.reduce((n, x) => n + x.inbound, 0), outbound: byDay.rows.reduce((n, x) => n + x.outbound, 0) } },
    responsiveness: { unansweredNow: { total: unanswered.total, over1h: unanswered.over_1h, over24h: unanswered.over_24h }, firstHumanResponse: { turnsInRange: turns.length, answered: mins.length, stillWaiting: turns.length - mins.length, medianMinutes: median, p90Minutes: pct(0.9) } },
    tasks: { ...tasks, overdueByAssignee: overdueBy },
    delivery: { byStatus: delivery, problems: failures },
    automation: { runs, autoMessages: autoMsgs, broadcasts: bcasts },
    unavailable: {
      appointments: 'Appointment outcomes need a connected calendar/appointment adapter (not connected).',
      reviews: 'Review ratings and request history need review-source connections (Phase 5).',
      payments: 'Payment analytics need a payment provider connection (Phase 5).',
    },
    costs: { sms: { estimatedSegments: segments, ratePerSegmentUsd: rate ? Number(rate) : null, estimatedUsd: rate ? Math.round(segments * Number(rate) * 10000) / 10000 : null, note: rate ? 'Estimate from the rate you entered; carrier fees and MMS not included.' : 'Unknown: no SMS provider pricing has been entered.' }, ai: { byProvider: ai, note: 'Only calls with a recorded cost are summed; none are recorded for the rule-based extractor.' } },
  };
}

const esc = (v: unknown) => { let s = v instanceof Date ? v.toISOString() : String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };   // CSV-injection safe
export const toCsv = (rows: Record<string, unknown>[]) => rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n') + '\n' : '';

export async function exportReport(a: Actor, report: string, r: Range): Promise<{ filename: string; csv: string }> {
  const data = await buildAnalytics(a, r);
  const meta = (rows: Record<string, unknown>[]) => rows;
  switch (report) {
    case 'volume_by_day': return { filename: 'volume_by_day.csv', csv: toCsv(meta(data.volume.byDay)) };
    case 'volume_by_department': return { filename: 'volume_by_department.csv', csv: toCsv(data.volume.byDepartment) };
    case 'delivery_status': return { filename: 'delivery_status.csv', csv: toCsv(data.delivery.byStatus) };
    case 'delivery_problems': return { filename: 'delivery_problems.csv', csv: toCsv(data.delivery.problems) };
    case 'automation_runs': return { filename: 'automation_runs.csv', csv: toCsv(data.automation.runs) };
    case 'broadcasts': if (!atLeastManager(a)) throw new HttpError(403, 'manager role required'); return { filename: 'broadcasts.csv', csv: toCsv(data.automation.broadcasts) };
    default: throw new HttpError(400, 'unknown report');
  }
}
