import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../domain/authz.js';
import { HttpError } from '../domain/authz.js';
import * as imp from '../migration/imports.js';
import * as plan from '../migration/plan.js';

/** Kenect migration preparation. Admin-only. Nothing here sends a message, changes routing, or contacts another vendor. */
export function registerPhase7(app: FastifyInstance, A: (r: FastifyRequest) => Actor) {
  const id = (r: FastifyRequest) => z.string().uuid().parse((r.params as { id: string }).id);
  app.get('/api/migration/imports', async (r) => imp.listBatches(A(r)));
  app.post('/api/migration/imports', async (r) => {
    const file = await (r as any).file({ limits: { fileSize: imp.MAX_BYTES } });
    if (!file) throw new HttpError(400, 'no file');
    const buf = await file.toBuffer(); if (file.file.truncated) throw new HttpError(413, 'file too large (25 MB limit)');
    const f = file.fields as Record<string, { value?: string }>;
    return imp.uploadBatch(A(r), { kind: f.kind?.value ?? '', filename: file.filename, data: buf });
  });
  app.get('/api/migration/imports/:id', async (r) => imp.getBatch(A(r), id(r)));
  app.post('/api/migration/imports/:id/stage', async (r) => imp.stageBatch(A(r), id(r), z.object({ mapping: z.unknown().optional(), options: z.unknown().optional() }).parse(r.body ?? {})));
  app.get('/api/migration/imports/:id/rows', async (r) => imp.listRows(A(r), id(r), z.object({ status: z.enum(['valid', 'error', 'duplicate', 'review', 'skipped', 'committed']).optional(), limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional() }).parse(r.query)));
  app.get('/api/migration/imports/:id/not-imported.csv', async (r, reply) => { const out = await imp.errorReport(A(r), id(r)); return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${out.filename}"`).send(out.csv); });
  app.post('/api/migration/imports/:id/commit', async (r) => imp.commitBatch(A(r), id(r), z.object({ confirm: z.string() }).parse(r.body).confirm));
  app.post('/api/migration/imports/:id/rollback', async (r) => imp.rollbackBatch(A(r), id(r), z.object({ confirm: z.string() }).parse(r.body).confirm));
  app.get('/api/migration/checklist', async (r) => plan.getChecklist(A(r)));
  app.put('/api/migration/checklist/:key', async (r) => plan.setItem(A(r), z.string().max(60).parse((r.params as { key: string }).key), z.object({ status: z.string(), evidence: z.string().max(2000).optional() }).parse(r.body)));
  app.put('/api/migration/validation-days', async (r) => { await plan.setValidationDays(A(r), z.object({ days: z.number() }).parse(r.body).days); return { ok: true }; });
}
