import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { HttpError, atLeastManager, isAdmin, type Actor } from '../domain/authz.js';
import * as wf from '../domain/workflows.js';
import * as bc from '../domain/broadcasts.js';
import * as an from '../domain/analytics.js';
import { loadAutomationSettings, loadHours } from '../domain/hours.js';
import { assertTimezone } from '../domain/time.js';

export function registerPhase4(app: FastifyInstance, A: (r: FastifyRequest) => Actor) {
  const id = (r: FastifyRequest) => z.string().uuid().parse((r.params as any).id);
  const mgr = (a: Actor) => { if (!atLeastManager(a)) throw new HttpError(403, 'manager role required'); };

  // ----- business hours, holidays, auto-response & quiet-hour settings -----
  app.get('/api/automation/settings', async (r) => {
    const a = A(r); const h = await loadHours(pool, a.workspaceId); const st = await loadAutomationSettings(pool, a.workspaceId);
    const hol = (await pool.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, name, closed, notice FROM holidays WHERE workspace_id=$1 ORDER BY day`, [a.workspaceId])).rows;
    const ws = (await pool.query('SELECT global_automation_pause, timezone FROM workspaces WHERE id=$1', [a.workspaceId])).rows[0];
    return { timezone: ws.timezone, globalPause: ws.global_automation_pause, hoursConfigured: h.configured, hours: [...h.byWeekday.entries()].map(([weekday, d]) => ({ weekday, ...d })).sort((x, y) => x.weekday - y.weekday), holidays: hol, autoResponse: st, triggerAdapters: wf.TRIGGER_ADAPTERS };
  });
  app.put('/api/automation/settings', async (r) => {
    const a = A(r); mgr(a);
    const b = z.object({
      hours: z.array(z.object({ weekday: z.number().int().min(0).max(6), closed: z.boolean(), open: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), close: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional() })).max(7).optional(),
      holidays: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().min(1).max(80), closed: z.boolean().default(true), notice: z.string().max(300).nullable().optional() })).max(60).optional(),
      autoResponse: z.object({ enabled: z.boolean(), firstContactMessage: z.string().max(600).nullable(), afterHoursMessage: z.string().max(600).nullable(), holidayMessage: z.string().max(600).nullable(), cadenceHours: z.number().int().min(1).max(168), quietStartHour: z.number().int().min(0).max(23), quietEndHour: z.number().int().min(0).max(23) }).optional(),
      timezone: z.string().optional(),
    }).parse(r.body);
    if (b.timezone) { try { assertTimezone(b.timezone); } catch { throw new HttpError(400, 'unknown timezone'); } await pool.query('UPDATE workspaces SET timezone=$2 WHERE id=$1', [a.workspaceId, b.timezone]); }
    if (b.hours) { await pool.query('DELETE FROM business_hours WHERE workspace_id=$1', [a.workspaceId]); for (const h of b.hours) { if (!h.closed && (!h.open || !h.close || h.open >= h.close)) throw new HttpError(400, 'open time must be before close time'); await pool.query('INSERT INTO business_hours (workspace_id, weekday, closed, open_time, close_time) VALUES ($1,$2,$3,$4,$5)', [a.workspaceId, h.weekday, h.closed, h.closed ? null : h.open, h.closed ? null : h.close]); } }
    if (b.holidays) { await pool.query('DELETE FROM holidays WHERE workspace_id=$1', [a.workspaceId]); for (const h of b.holidays) await pool.query('INSERT INTO holidays (workspace_id, day, name, closed, notice) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [a.workspaceId, h.day, h.name, h.closed, h.notice ?? null]); }
    if (b.autoResponse) { const x = b.autoResponse; await pool.query(`INSERT INTO automation_settings (workspace_id, auto_response_enabled, first_contact_message, after_hours_message, holiday_message, cadence_hours, quiet_start_hour, quiet_end_hour, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (workspace_id) DO UPDATE SET auto_response_enabled=EXCLUDED.auto_response_enabled, first_contact_message=EXCLUDED.first_contact_message, after_hours_message=EXCLUDED.after_hours_message, holiday_message=EXCLUDED.holiday_message, cadence_hours=EXCLUDED.cadence_hours, quiet_start_hour=EXCLUDED.quiet_start_hour, quiet_end_hour=EXCLUDED.quiet_end_hour, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [a.workspaceId, x.enabled, x.firstContactMessage, x.afterHoursMessage, x.holidayMessage, x.cadenceHours, x.quietStartHour, x.quietEndHour, a.userId]); }
    return { ok: true };
  });
  app.post('/api/automation/global-pause', async (r) => { await wf.setGlobalPause(A(r), z.object({ paused: z.boolean() }).parse(r.body).paused); return { ok: true }; });

  // ----- workflows -----
  app.get('/api/workflows', async (r) => wf.listWorkflows(A(r)));
  app.post('/api/workflows', async (r) => { const b = z.object({ name: z.string().min(1).max(80), description: z.string().max(300).optional(), definition: z.unknown() }).parse(r.body); return { id: await wf.createWorkflow(A(r), b) }; });
  app.put('/api/workflows/:id', async (r) => ({ version: await wf.updateWorkflow(A(r), id(r), (r.body as any)?.definition) }));
  app.post('/api/workflows/:id/status', async (r) => { await wf.setWorkflowStatus(A(r), id(r), z.object({ status: z.enum(['active', 'paused']) }).parse(r.body).status); return { ok: true }; });
  app.post('/api/workflows/dry-run', async (r) => { const b = z.object({ definition: z.unknown(), conversationId: z.string().uuid().optional() }).parse(r.body); return wf.dryRun(A(r), b.definition, b.conversationId); });
  app.get('/api/workflows/:id/runs', async (r) => wf.listRuns(A(r), id(r)));
  app.get('/api/workflow-runs/:id/log', async (r) => wf.runLog(A(r), id(r)));
  app.post('/api/workflow-runs/:id/stop', async (r) => { await wf.stopRunByStaff(A(r), id(r)); return { ok: true }; });
  app.get('/api/conversations/:id/automation', async (r) => wf.activityForConversation(A(r), id(r)));

  // ----- broadcasts -----
  app.get('/api/broadcasts', async (r) => bc.listBroadcasts(A(r)));
  app.post('/api/broadcasts', async (r) => ({ id: await bc.createBroadcast(A(r), r.body) }));
  app.put('/api/broadcasts/:id', async (r) => { await bc.updateBroadcast(A(r), id(r), r.body); return { ok: true }; });
  app.get('/api/broadcasts/:id', async (r) => bc.getBroadcast(A(r), id(r)));
  app.post('/api/broadcasts/:id/preview', async (r) => bc.previewBroadcast(A(r), id(r)));
  app.post('/api/broadcasts/:id/approve', async (r) => {
    const b = z.union([z.object({ sendNow: z.literal(true) }), z.object({ localTime: z.string(), timezone: z.string().optional() })]).parse(r.body);
    return bc.approveBroadcast(A(r), id(r), b);
  });
  app.post('/api/broadcasts/:id/:action', async (r) => { const action = z.enum(['pause', 'resume', 'cancel']).parse((r.params as any).action); await bc.setBroadcastState(A(r), id(r), action); return { ok: true }; });

  // ----- analytics -----
  const range = async (r: FastifyRequest) => { const q = z.object({ from: z.string().optional(), to: z.string().optional(), tz: z.string().optional() }).parse(r.query); const tz = (await pool.query('SELECT timezone FROM workspaces WHERE id=$1', [A(r).workspaceId])).rows[0].timezone; return an.parseRange(q, tz); };
  app.get('/api/analytics', async (r) => an.buildAnalytics(A(r), await range(r)));
  app.get('/api/analytics/export', async (r, reply) => { const rep = z.object({ report: z.string() }).parse(r.query).report; const out = await an.exportReport(A(r), rep, await range(r)); return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${out.filename}"`).send(out.csv); });
  void isAdmin;
}
