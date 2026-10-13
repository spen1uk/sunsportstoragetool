import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../domain/authz.js';
import * as chat from '../domain/chat.js';
import * as summary from '../domain/summary.js';
import * as voice from '../domain/voice.js';
import * as inv from '../domain/inventory.js';
import * as outreach from '../domain/outreach.js';
import { HttpError } from '../domain/authz.js';

export function registerPhase3(app: FastifyInstance, A: (r: FastifyRequest) => Actor) {
  const id = (r: FastifyRequest) => z.string().uuid().parse((r.params as any).id);
  const uuid = z.string().uuid();

  // ----- team chat (internal only; separate from customer messaging) -----
  app.get('/api/chat/channels', async (r) => chat.listChannels(A(r)));
  app.post('/api/chat/dm', async (r) => ({ id: await chat.openDm(A(r), uuid.parse((r.body as any)?.userId)) }));
  app.post('/api/chat/groups', async (r) => { const b = z.object({ name: z.string().min(1).max(80), memberIds: z.array(uuid).min(1) }).parse(r.body); return { id: await chat.createGroup(A(r), b.name, b.memberIds) }; });
  app.post('/api/chat/customer', async (r) => ({ id: await chat.openCustomerChannel(A(r), uuid.parse((r.body as any)?.contactId)) }));
  app.get('/api/chat/channels/:id/messages', async (r) => chat.getMessages(A(r), id(r), { threadRootId: z.string().uuid().optional().parse((r.query as any).thread) }));
  app.post('/api/chat/channels/:id/messages', async (r) => {
    const b = z.object({ body: z.string().max(4000), parentId: uuid.nullable().optional(), mentions: z.array(uuid).max(20).optional(), mediaIds: z.array(uuid).max(5).optional() }).parse(r.body);
    return { id: await chat.postMessage(A(r), id(r), b) };
  });
  app.post('/api/chat/channels/:id/read', async (r) => { await chat.markChannelRead(A(r), id(r)); return { ok: true }; });
  app.patch('/api/chat/messages/:id', async (r) => { await chat.editMessage(A(r), id(r), z.object({ body: z.string().min(1).max(4000) }).parse(r.body).body); return { ok: true }; });
  app.delete('/api/chat/messages/:id', async (r) => { await chat.deleteMessage(A(r), id(r)); return { ok: true }; });
  app.post('/api/chat/messages/:id/task', async (r) => ({ id: await chat.messageToTask(A(r), id(r), z.object({ assigneeId: uuid, dueAt: z.string().nullable().optional(), title: z.string().max(200).optional() }).parse(r.body)) }));
  app.get('/api/chat/search', async (r) => chat.searchMessages(A(r), z.object({ q: z.string().max(100) }).parse(r.query).q));

  // ----- tasks -----
  app.get('/api/tasks', async (r) => { const q = z.object({ scope: z.enum(['mine', 'created', 'all']).optional(), status: z.enum(['open', 'done', 'cancelled']).optional() }).parse(r.query); return chat.listTasks(A(r), q); });
  app.post('/api/tasks', async (r) => ({ id: await chat.createTask(A(r), z.object({ title: z.string().min(1).max(200), assigneeId: uuid.optional(), dueAt: z.string().nullable().optional(), contactId: uuid.nullable().optional(), conversationId: uuid.nullable().optional() }).parse(r.body)) }));
  app.patch('/api/tasks/:id', async (r) => { await chat.updateTask(A(r), id(r), z.object({ status: z.enum(['open', 'done', 'cancelled']).optional(), dueAt: z.string().nullable().optional(), assigneeId: uuid.optional() }).parse(r.body)); return { ok: true }; });

  // ----- summaries (permission-scoped; built from customer-visible messages only) -----
  app.get('/api/contacts/:id/summary', async (r) => summary.getSummary(A(r), id(r)));
  app.post('/api/contacts/:id/summary/rebuild', async (r) => { await summary.requestRebuild(A(r), id(r), z.object({ force: z.boolean().optional() }).parse(r.body ?? {}).force ?? false); return { ok: true, queued: true }; });
  app.post('/api/messages/:id/redact', async (r) => { await summary.redactMessage(A(r), id(r)); return { ok: true }; });

  // ----- voice drafts (never auto-send) -----
  app.get('/api/voice/capabilities', async () => ({ serverTranscription: voice.transcriptionAvailable(), note: voice.transcriptionAvailable() ? 'Server transcription is configured.' : 'No server transcription provider is configured; use browser speech recognition (if supported) or type the text. Audio is not sent to any third party.' }));
  app.post('/api/conversations/:id/voice-drafts', async (r) => {
    const fields: Record<string, string> = {}; let audio: { data: Buffer; filename: string } | undefined;
    for await (const part of (r as any).parts({ limits: { fileSize: 10 * 1024 * 1024 } })) {
      if (part.type === 'file') { const buf: Buffer = await part.toBuffer(); if (part.file.truncated) throw new HttpError(413, 'recording too large'); if (buf.length) audio = { data: buf, filename: part.filename }; }
      else fields[part.fieldname] = String(part.value);
    }
    return voice.createVoiceDraft(A(r), id(r), { audio, transcript: fields.transcript, transcriptSource: fields.transcriptSource === 'browser_speech' ? 'browser_speech' : 'typed' });
  });
  app.get('/api/voice-drafts/:id', async (r) => voice.getVoiceDraft(A(r), id(r)));
  app.patch('/api/voice-drafts/:id', async (r) => { await voice.updateVoiceDraft(A(r), id(r), z.object({ finalText: z.string().max(1600) }).parse(r.body).finalText); return { ok: true }; });
  app.delete('/api/voice-drafts/:id', async (r) => { await voice.discardVoiceDraft(A(r), id(r)); return { ok: true }; });
  app.post('/api/voice-drafts/:id/send', async (r) => voice.sendVoiceDraft(A(r), id(r), z.object({ finalText: z.string().max(1600), confirm: z.boolean() }).parse(r.body)));

  // ----- inventory + matching -----
  app.get('/api/inventory', async (r) => inv.listInventory(A(r)));
  app.post('/api/inventory/import', async (r) => { const b = z.object({ sourceKey: z.string().min(1).max(40), fullSync: z.boolean().optional(), boats: z.array(z.unknown()).min(1).max(1000) }).parse(r.body); return inv.upsertBoats(A(r), b.sourceKey, b.boats as never, { fullSync: b.fullSync, kind: 'import' }); });
  app.post('/api/inventory', async (r) => inv.upsertBoats(A(r), 'manual', [r.body as never], { kind: 'manual' }));
  app.post('/api/inventory/sources/:key/confirm', async (r) => { await inv.confirmSourceCurrent(A(r), z.string().parse((r.params as any).key)); return { ok: true }; });
  app.get('/api/contacts/:id/preferences', async (r) => inv.getPreferences(A(r), id(r)));
  app.put('/api/contacts/:id/preferences', async (r) => { await inv.setPreferences(A(r), id(r), r.body); return { ok: true }; });
  app.get('/api/contacts/:id/matches', async (r) => inv.getMatches(A(r), id(r), { includeExcluded: (r.query as any).excluded === '1' }));
  app.post('/api/contacts/:id/matches/:boatId/feedback', async (r) => { const b = z.object({ status: z.enum(['suggested', 'dismissed', 'interested']), reason: z.string().max(300).optional() }).parse(r.body); await inv.matchFeedback(A(r), id(r), uuid.parse((r.params as any).boatId), b.status, b.reason); return { ok: true }; });
  app.post('/api/contacts/:id/packages', async (r) => outreach.createPackage(A(r), id(r), z.object({ boatIds: z.array(uuid).min(1).max(5) }).parse(r.body).boatIds));
}
