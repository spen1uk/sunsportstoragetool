import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError, isAdmin, type Actor, canSeeContact, atLeastManager } from './authz.js';

// ---------- storage adapter (local disk now; object storage adapter pending hosting decision) ----------
export interface BlobStore { put(key: string, data: Buffer): Promise<void>; get(key: string): Promise<Buffer>; del(key: string): Promise<void> }
export const localStore: BlobStore = {
  async put(key, data) { const f = path.join(config.mediaDir, key); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, data, { mode: 0o600 }); },
  async get(key) { return readFile(path.join(config.mediaDir, key)); },
  async del(key) { await rm(path.join(config.mediaDir, key), { force: true }); },
};
export let store: BlobStore = localStore;
export const setStore = (s: BlobStore) => { store = s; };

// ---------- validation ----------
const MMS_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'application/pdf']);
const LIBRARY_TYPES = new Set([...MMS_TYPES]);
const VOICE_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']);
export const MAX_LIBRARY_BYTES = 25 * 1024 * 1024;
/** Conservative MMS cap pending the chosen provider's documented limits (unverified). */
export const MAX_MMS_BYTES = 5 * 1024 * 1024;

/** Detect type from magic bytes; never trust the client-supplied content type. */
export function sniffType(b: Buffer): string | null {
  const h = (n: number) => b.subarray(0, n);
  if (h(3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (h(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (h(6).toString('latin1') === 'GIF87a' || h(6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (h(4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (h(4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (h(4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'audio/webm';
  if (h(4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (h(3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (h(4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  return null;
}
export const sanitizeFilename = (n: string) => path.basename(n).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';

export async function saveMedia(a: { workspaceId: string; uploaderUserId?: string | null }, f: { filename: string; data: Buffer; category?: string; origin?: 'library' | 'inbound_mms' | 'voice' | 'chat'; departmentId?: string | null; contactId?: string | null; expiresAt?: Date | null }, db: import('../db/pool.js').Db = pool) {
  const origin = f.origin ?? 'library';
  const type = sniffType(f.data);
  const allowed = origin === 'voice' ? VOICE_TYPES : LIBRARY_TYPES;
  if (!type || !allowed.has(type)) throw new HttpError(415, 'unsupported or unrecognised file type');
  if (f.data.length === 0) throw new HttpError(400, 'empty file');
  if (f.data.length > MAX_LIBRARY_BYTES) throw new HttpError(413, 'file too large');
  const id = randomUUID(); const key = `${a.workspaceId}/${id}`;
  await store.put(key, f.data);
  // scan_status stays 'unscanned': no malware scanner is integrated. Mitigations: type allowlist + magic-byte check, private storage, nosniff headers, no execution.
  await db.query(
    `INSERT INTO media_assets (id, workspace_id, uploader_user_id, filename, content_type, size_bytes, sha256, storage_key, category, origin, department_id, contact_id, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, a.workspaceId, a.uploaderUserId ?? null, sanitizeFilename(f.filename), type, f.data.length, createHash('sha256').update(f.data).digest('hex'), key, f.category ?? 'general', origin, f.departmentId ?? null, f.contactId ?? null, f.expiresAt ?? null]);
  return { id, contentType: type, size: f.data.length };
}

export async function validateAttachments(c: PoolClient, workspaceId: string, ids: string[]): Promise<string | null> {
  const r = await c.query(`SELECT content_type, size_bytes, scan_status, deleted_at FROM media_assets WHERE workspace_id=$1 AND id = ANY($2::uuid[])`, [workspaceId, ids]);
  if (r.rowCount !== new Set(ids).size) return 'attachment_not_found';
  let total = 0;
  for (const m of r.rows) {
    if (m.deleted_at || m.scan_status === 'quarantined') return 'attachment_unavailable';
    if (!MMS_TYPES.has(m.content_type)) return 'attachment_type_not_allowed';
    total += Number(m.size_bytes);
  }
  return total > MAX_MMS_BYTES ? 'attachment_too_large_for_mms' : null;
}

// ---------- signed, expiring links (private storage; revocable via deleted_at) ----------
const sign = (id: string, exp: number) => createHmac('sha256', config.mediaSigningKey).update(`${id}.${exp}`).digest('base64url');
export function signedPath(id: string, ttlSeconds = 600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return `/media/file/${id}?exp=${exp}&sig=${sign(id, exp)}`;
}
export function verifySigned(id: string, exp: string | undefined, sig: string | undefined): boolean {
  const e = Number(exp); if (!e || !sig || e < Date.now() / 1000) return false;
  const want = Buffer.from(sign(id, e)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
export async function signedMediaUrls(messageId: string): Promise<{ url: string; contentType: string }[]> {
  const r = await pool.query(`SELECT a.id, a.content_type FROM message_attachments ma JOIN media_assets a ON a.id=ma.media_id WHERE ma.message_id=$1 AND a.deleted_at IS NULL`, [messageId]);
  return r.rows.map((m) => ({ url: `${config.publicBaseUrl}${signedPath(m.id, 24 * 3600)}`, contentType: m.content_type }));
}
export async function readForServing(id: string) {
  const m = (await pool.query(`SELECT * FROM media_assets WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
  if (!m) return null;
  return { meta: m, data: await store.get(m.storage_key) };
}

// ---------- authorization + library ops ----------
export async function canAccessMedia(a: Actor, m: { workspace_id: string; department_id: string | null; contact_id: string | null; uploader_user_id: string | null; origin: string }): Promise<boolean> {
  if (m.workspace_id !== a.workspaceId) return false;
  if (isAdmin(a)) return true;
  if (m.origin === 'voice') return m.uploader_user_id === a.userId;                // voice recordings: owner only (+admins)
  if (m.contact_id) return canSeeContact(pool, a, m.contact_id);
  return !m.department_id || a.departmentIds.includes(m.department_id) || atLeastManager(a);
}
export async function getMediaForActor(a: Actor, id: string) {
  const m = (await pool.query(`SELECT * FROM media_assets WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`, [id, a.workspaceId])).rows[0];
  if (!m || !(await canAccessMedia(a, m))) throw new HttpError(404, 'media not found');
  return m;
}
export async function listMedia(a: Actor, q: { search?: string; category?: string; favorites?: boolean }) {
  const rows = (await pool.query(
    `SELECT id, filename, content_type, size_bytes, category, is_favorite, scan_status, department_id, created_at FROM media_assets
     WHERE workspace_id=$1 AND deleted_at IS NULL AND origin='library' AND ($2::text IS NULL OR filename ILIKE $2 OR category ILIKE $2) AND ($3::text IS NULL OR category=$3) AND (NOT $4 OR is_favorite)
     ORDER BY created_at DESC LIMIT 200`, [a.workspaceId, q.search ? `%${q.search}%` : null, q.category ?? null, !!q.favorites])).rows;
  const out = [];
  for (const r of rows) if (await canAccessMedia(a, { ...r, workspace_id: a.workspaceId, contact_id: null, uploader_user_id: null, origin: 'library' })) out.push(r);
  return out;
}
export async function deleteMedia(a: Actor, id: string) {
  const m = await getMediaForActor(a, id);
  if (!atLeastManager(a) && m.uploader_user_id !== a.userId) throw new HttpError(403, 'not allowed to delete this file');
  await pool.query('UPDATE media_assets SET deleted_at=now() WHERE id=$1', [id]);   // revokes all signed links immediately
  await store.del(m.storage_key);
}
