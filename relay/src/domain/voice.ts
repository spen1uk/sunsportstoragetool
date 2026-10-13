import { pool } from '../db/pool.js';
import { HttpError, requireConversation, type Actor } from './authz.js';
import { saveMedia, store } from './media.js';
import { queueOutbound } from './messaging.js';
import { enqueue } from './queue.js';

/** Server-side speech-to-text adapter. None is registered by default: audio is NOT sent to any third party unless the owner configures exactly one. */
export interface Transcriber { key: string; transcribe(audio: Buffer, mime: string): Promise<{ text: string }> }
let transcriber: Transcriber | null = null;
export const registerTranscriber = (t: Transcriber | null) => { transcriber = t; };
export const transcriptionAvailable = () => !!transcriber;

export const DEFAULT_RETENTION_DAYS = 30;

const FILLERS = /\b(um+|uh+|erm|you know|like,|i mean|sort of|kind of)\b[,]?\s*/gi;
/**
 * Light cleanup that can only DELETE filler words, collapse whitespace/stutters, and fix casing/punctuation.
 * It never adds, rewrites or substitutes words, so it cannot introduce prices, promises or policies. (Property-tested.)
 */
export function cleanTranscript(raw: string): string {
  let t = raw.replace(FILLERS, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, '$1');                           // "the the" → "the"
  t = t.replace(/\s+([,.!?])/g, '$1');
  t = t.replace(/(^|[.!?]\s+)([a-z])/g, (_m, a, b) => a + b.toUpperCase());
  t = t.replace(/\bi\b/g, 'I');
  if (t && !/[.!?]$/.test(t)) t += '.';
  return t;
}

export async function createVoiceDraft(a: Actor, conversationId: string, i: { audio?: { data: Buffer; filename: string }; transcript?: string; transcriptSource?: 'browser_speech' | 'typed' }) {
  await requireConversation(pool, a, conversationId);
  if (!i.audio && !i.transcript?.trim()) throw new HttpError(400, 'provide a recording or a transcript');
  let audioId: string | null = null; let original = i.transcript?.trim() || null; let source: string | null = original ? (i.transcriptSource ?? 'typed') : null;
  if (i.audio) {
    const days = Number((await pool.query(`SELECT value FROM workspace_settings WHERE workspace_id=$1 AND key='voice_retention_days'`, [a.workspaceId])).rows[0]?.value ?? DEFAULT_RETENTION_DAYS);
    const saved = await saveMedia({ workspaceId: a.workspaceId, uploaderUserId: a.userId }, { filename: i.audio.filename || 'voice.webm', data: i.audio.data, origin: 'voice', category: 'voice', expiresAt: new Date(Date.now() + days * 86400_000) });
    audioId = saved.id;
    if (!original && transcriber) {
      try { original = (await transcriber.transcribe(i.audio.data, saved.contentType)).text.trim() || null; if (original) source = 'server_stt'; } catch { /* leave for manual transcript */ }
    }
  }
  const cleaned = original ? cleanTranscript(original) : null;
  const r = await pool.query(
    `INSERT INTO voice_drafts (workspace_id, user_id, conversation_id, audio_media_id, transcript_original, transcript_source, cleaned_text, cleanup_provider, final_text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7) RETURNING id`,
    [a.workspaceId, a.userId, conversationId, audioId, original, source, cleaned, cleaned ? 'rules-v1 (no AI)' : null]);
  return { id: r.rows[0].id as string, transcriptOriginal: original, cleanedText: cleaned, needsTranscript: !original, transcriptionAvailable: !!transcriber };
}

async function ownDraft(a: Actor, id: string) {
  const d = (await pool.query('SELECT * FROM voice_drafts WHERE id=$1 AND workspace_id=$2 AND user_id=$3', [id, a.workspaceId, a.userId])).rows[0];
  if (!d) throw new HttpError(404, 'draft not found');      // drafts are private to their creator
  return d;
}
export async function getVoiceDraft(a: Actor, id: string) { const d = await ownDraft(a, id); return { id: d.id, status: d.status, transcriptOriginal: d.transcript_original, cleanedText: d.cleaned_text, finalText: d.final_text, transcriptSource: d.transcript_source }; }
export async function updateVoiceDraft(a: Actor, id: string, finalText: string) {
  const d = await ownDraft(a, id); if (d.status !== 'draft') throw new HttpError(409, `draft already ${d.status}`);
  await pool.query('UPDATE voice_drafts SET final_text=$2 WHERE id=$1', [id, finalText]);
}
export async function discardVoiceDraft(a: Actor, id: string) {
  const d = await ownDraft(a, id); if (d.status !== 'draft') throw new HttpError(409, `draft already ${d.status}`);
  await pool.query(`UPDATE voice_drafts SET status='discarded' WHERE id=$1`, [id]);
  if (d.audio_media_id) await purgeMedia(d.audio_media_id);
}

/** The ONLY way a voice draft becomes a customer message: an explicit call carrying confirm:true and the exact text reviewed. */
export async function sendVoiceDraft(a: Actor, id: string, i: { finalText: string; confirm: boolean }) {
  if (i.confirm !== true) throw new HttpError(400, 'explicit confirmation required');
  const d = await ownDraft(a, id);
  if (d.status === 'sent') throw new HttpError(409, 'already sent');
  if (d.status !== 'draft') throw new HttpError(409, `draft is ${d.status}`);
  if (!i.finalText.trim()) throw new HttpError(400, 'message is empty');
  await requireConversation(pool, a, d.conversation_id);
  const r = await queueOutbound({ workspaceId: a.workspaceId, conversationId: d.conversation_id, body: i.finalText, senderType: 'staff', senderUserId: a.userId, idempotencyKey: `voice:${id}` });
  if (!r.ok) throw new HttpError(422, `not sent: ${r.reason}`, { reason: r.reason });
  await pool.query(`UPDATE voice_drafts SET status='sent', final_text=$2, sent_message_id=$3 WHERE id=$1`, [id, i.finalText, r.messageId]);
  return { messageId: r.messageId };
}

async function purgeMedia(mediaId: string) {
  const m = (await pool.query(`UPDATE media_assets SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING storage_key`, [mediaId])).rows[0];
  if (m) await store.del(m.storage_key);
}

/** Retention: delete expired recordings (file + record access). Scheduled hourly by the worker. */
export async function purgeExpiredMedia(): Promise<number> {
  const rows = (await pool.query(`SELECT id FROM media_assets WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < now()`)).rows;
  for (const r of rows) await purgeMedia(r.id);
  return rows.length;
}
export async function scheduleMaintenance() {
  await enqueue(pool, 'maintenance', {}, { runAt: new Date(Date.now() + 3600_000), dedupeKey: 'hourly' });
}
