import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { HttpError, atLeastManager, isAdmin, type Actor } from '../domain/authz.js';
import * as tpl from '../domain/templates.js';
import * as sched from '../domain/scheduling.js';
import * as media from '../domain/media.js';
import * as notif from '../domain/notifications.js';

export const SETTING_KEYS = ['business_phone', 'business_address', 'business_hours', 'directions_link', 'review_link', 'website'] as const;

export function registerPhase2(app: FastifyInstance, A: (r: FastifyRequest) => Actor) {
  const id = (r: FastifyRequest) => z.string().uuid().parse((r.params as any).id);

  // ----- templates -----
  app.get('/api/templates', async (r) => { const q = z.object({ search: z.string().optional(), category: z.string().optional(), favorites: z.string().optional(), inactive: z.string().optional() }).parse(r.query); return tpl.listTemplates(A(r), { search: q.search, category: q.category, favoritesOnly: q.favorites === '1', includeInactive: q.inactive === '1' }); });
  app.get('/api/templates/categories', async () => tpl.TEMPLATE_CATEGORIES);
  app.post('/api/templates', async (r) => ({ id: await tpl.createTemplate(A(r), z.object({ category: z.string(), name: z.string().min(1).max(80), body: z.string().min(1).max(1600), departmentId: z.string().uuid().nullable().optional() }).parse(r.body)) }));
  app.get('/api/templates/:id/versions', async (r) => tpl.templateVersions(A(r), id(r)));
  app.post('/api/templates/:id/versions', async (r) => ({ version: await tpl.updateTemplate(A(r), id(r), z.object({ body: z.string().min(1).max(1600) }).parse(r.body).body) }));
  app.post('/api/templates/:id/revert', async (r) => ({ version: await tpl.revertTemplate(A(r), id(r), z.object({ version: z.number().int() }).parse(r.body).version) }));
  app.post('/api/templates/:id/active', async (r) => { await tpl.setTemplateActive(A(r), id(r), z.object({ active: z.boolean() }).parse(r.body).active); return { ok: true }; });
  app.post('/api/templates/:id/favorite', async (r) => { await tpl.toggleFavorite(A(r), id(r), z.object({ favorite: z.boolean() }).parse(r.body).favorite); return { ok: true }; });
  app.post('/api/templates/:id/render', async (r) => tpl.renderTemplate(A(r), id(r), z.object({ conversationId: z.string().uuid().optional() }).parse(r.body ?? {}).conversationId));

  // ----- scheduled sends -----
  app.post('/api/conversations/:id/scheduled', async (r) => sched.createScheduled(A(r), id(r), z.object({ body: z.string().max(1600), localTime: z.string(), timezone: z.string().optional(), mediaIds: z.array(z.string().uuid()).optional() }).parse(r.body)));
  app.get('/api/conversations/:id/scheduled', async (r) => sched.listScheduled(A(r), id(r)));
  app.post('/api/scheduled/:id/cancel', async (r) => { await sched.cancelScheduled(A(r), id(r)); return { ok: true }; });
  app.get('/api/scheduled/:id/history', async (r) => sched.scheduledHistory(A(r), id(r)));

  // ----- media -----
  app.post('/api/media', async (r) => {
    const a = A(r);
    const file = await (r as any).file({ limits: { fileSize: media.MAX_LIBRARY_BYTES } });
    if (!file) throw new HttpError(400, 'no file');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, 'file too large');
    const f = file.fields as Record<string, { value?: string }>;
    const departmentId = f.departmentId?.value ? z.string().uuid().parse(f.departmentId.value) : null;
    if (departmentId && !isAdmin(a) && !a.departmentIds.includes(departmentId)) throw new HttpError(403, 'not a member of that department');
    return media.saveMedia({ workspaceId: a.workspaceId, uploaderUserId: a.userId }, { filename: file.filename, data: buf, category: f.category?.value || 'general', departmentId });
  });
  app.get('/api/media', async (r) => { const q = z.object({ search: z.string().optional(), category: z.string().optional(), favorites: z.string().optional() }).parse(r.query); return media.listMedia(A(r), { search: q.search, category: q.category, favorites: q.favorites === '1' }); });
  app.get('/api/media/:id/link', async (r) => { await media.getMediaForActor(A(r), id(r)); return { url: media.signedPath(id(r), 600), expiresInSeconds: 600 }; });
  app.post('/api/media/:id/favorite', async (r) => { await media.getMediaForActor(A(r), id(r)); await pool.query('UPDATE media_assets SET is_favorite=$2 WHERE id=$1', [id(r), z.object({ favorite: z.boolean() }).parse(r.body).favorite]); return { ok: true }; });
  app.delete('/api/media/:id', async (r) => { await media.deleteMedia(A(r), id(r)); return { ok: true }; });
  // Signed-link download: unauthenticated by design (providers fetch it), bound to media id + expiry, revoked by deletion.
  app.get('/media/file/:id', async (r, reply) => {
    const q = r.query as { exp?: string; sig?: string }; const mid = id(r);
    if (!media.verifySigned(mid, q.exp, q.sig)) return reply.status(403).send({ error: 'invalid or expired link' });
    const m = await media.readForServing(mid); if (!m) return reply.status(404).send({ error: 'not found' });
    return reply.header('content-type', m.meta.content_type).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store')
      .header('content-security-policy', "sandbox; default-src 'none'").header('content-disposition', `inline; filename="${m.meta.filename.replace(/"/g, '')}"`).send(m.data);
  });

  // ----- notifications -----
  app.get('/api/notifications', async (r) => notif.listNotifications(A(r)));
  app.post('/api/notifications/read', async (r) => { await notif.markNotificationsRead(A(r), z.object({ id: z.string().uuid().optional() }).parse(r.body ?? {}).id); return { ok: true }; });

  // ----- workspace settings (business facts used by templates; only what the business enters) -----
  app.get('/api/settings', async (r) => Object.fromEntries((await pool.query('SELECT key, value FROM workspace_settings WHERE workspace_id=$1', [A(r).workspaceId])).rows.map((x) => [x.key, x.value])));
  app.put('/api/settings', async (r) => {
    const a = A(r); if (!atLeastManager(a)) throw new HttpError(403, 'manager role required');
    const b = z.record(z.enum(SETTING_KEYS), z.string().max(500)).parse(r.body);
    for (const [k, v] of Object.entries(b)) {
      if (v.trim() === '') await pool.query('DELETE FROM workspace_settings WHERE workspace_id=$1 AND key=$2', [a.workspaceId, k]);
      else await pool.query(`INSERT INTO workspace_settings (workspace_id,key,value,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id,key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [a.workspaceId, k, v, a.userId]);
    }
    return { ok: true };
  });
}
