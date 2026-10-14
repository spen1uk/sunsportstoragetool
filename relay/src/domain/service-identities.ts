import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { HttpError, isAdmin, type Actor } from './authz.js';
import { audit } from './events.js';
import { decryptJson, encryptJson } from '../integrations/crypto.js';
import { assertSafeUrl, UnsafeUrlError } from '../integrations/ssrf.js';
import { webhookTransport } from './webhooks.js';

/** Every scope the API understands. Anything else is rejected at creation time (no silent typos granting nothing/everything). */
export const SCOPES = [
  'conversations:read', 'messages:read', 'contacts:read', 'contacts:pii', 'summaries:read', 'inventory:read', 'business:read', 'events:read',
  'messages:send', 'drafts:write', 'conversations:write', 'tasks:write',
] as const;
export type Scope = (typeof SCOPES)[number];
export const AUTONOMY = ['read_only', 'drafts', 'send'] as const;
export type Autonomy = (typeof AUTONOMY)[number];

export interface ServiceContext {
  identityId: string; keyId: string; workspaceId: string; name: string;
  scopes: Set<string>; autonomy: Autonomy; departmentIds: string[]; rateLimitPerMin: number;
  /** Read-side visibility reuses the staff rules: a service identity is a 'staff'-role actor limited to its own departments. Its id can never equal a real user id. */
  actor: Actor;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const newApiKey = () => { const prefix = randomBytes(6).toString('hex'); const secret = randomBytes(24).toString('base64url'); return { prefix, key: `rk_${prefix}_${secret}` }; };

const adminOnly = (a: Actor) => { if (!isAdmin(a)) throw new HttpError(403, 'owner or admin required to manage the assistant'); };

const createSchema = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(SCOPES)).max(SCOPES.length).default([]),
  departmentIds: z.array(z.string().uuid()).max(20).default([]),
  autonomy: z.enum(AUTONOMY).default('read_only'),
  webhookUrl: z.string().url().max(500).nullable().optional(),
  rateLimitPerMin: z.number().int().min(10).max(2000).optional(),
});

async function checkDepartments(db: Db, workspaceId: string, ids: string[]) {
  if (!ids.length) return;
  const r = await db.query('SELECT count(*)::int n FROM departments WHERE workspace_id=$1 AND id = ANY($2::uuid[])', [workspaceId, ids]);
  if (r.rows[0].n !== new Set(ids).size) throw new HttpError(400, 'unknown department');
}
async function checkWebhook(url: string | null | undefined) {
  if (!url) return;
  try { await assertSafeUrl(url, webhookTransport.opts.resolve); } catch (e) { if (e instanceof UnsafeUrlError) throw new HttpError(400, `webhook destination rejected: ${e.message}`); throw e; }
}
const sendGate = (a: Actor, autonomy: string, scopes: string[]) => {
  if (autonomy === 'send' && a.role !== 'owner') throw new HttpError(403, 'only the owner can allow the assistant to send customer messages');
  if (scopes.includes('messages:send') && a.role !== 'owner') throw new HttpError(403, 'only the owner can grant the messages:send scope');
};

export async function createIdentity(a: Actor, input: unknown) {
  adminOnly(a); const b = createSchema.parse(input);
  sendGate(a, b.autonomy, b.scopes);
  await checkDepartments(pool, a.workspaceId, b.departmentIds); await checkWebhook(b.webhookUrl);
  return tx(async (c) => {
    const id = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id as string;
    let secretEnc: string | null = null; let kv: number | null = null; let whsec: string | null = null;
    if (b.webhookUrl) { whsec = `whsec_${randomBytes(24).toString('base64url')}`; const e = encryptJson({ secret: whsec }, `svc:${id}`); secretEnc = e.enc; kv = e.keyVersion; }
    try {
      await c.query(`INSERT INTO service_identities (id, workspace_id, name, scopes, department_ids, autonomy, webhook_url, webhook_secret_enc, key_version, rate_limit_per_min, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, a.workspaceId, b.name, b.scopes, b.departmentIds, b.autonomy, b.webhookUrl ?? null, secretEnc, kv, b.rateLimitPerMin ?? 120, a.userId]);
    } catch (e) { if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'an identity with that name already exists'); throw e; }
    const k = await issueKey(c, a, id, 'initial');
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.identity.create', targetType: 'service_identity', targetId: id, meta: { name: b.name, scopes: b.scopes, autonomy: b.autonomy, departments: b.departmentIds.length } });
    return { id, apiKey: k.key, keyId: k.id, webhookSecret: whsec, note: 'Store the API key (and webhook secret) now — they are shown only once.' };
  });
}

async function issueKey(c: Db, a: Actor, identityId: string, label: string, expiresAt?: Date | null) {
  const { prefix, key } = newApiKey();
  const r = await c.query(`INSERT INTO api_keys (identity_id, prefix, secret_hash, label, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [identityId, prefix, hash(key), label.slice(0, 60), expiresAt ?? null, a.userId]);
  return { id: r.rows[0].id as string, key };
}
const own = async (db: Db, a: Actor, id: string) => { const r = (await db.query('SELECT * FROM service_identities WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId])).rows[0]; if (!r) throw new HttpError(404, 'identity not found'); return r; };

export async function listIdentities(a: Actor) {
  adminOnly(a);
  const rows = (await pool.query(
    `SELECT i.id, i.name, i.status, i.scopes, i.department_ids, i.autonomy, i.webhook_url, i.rate_limit_per_min, i.last_used_at, i.ack_cursor, i.push_last_error, i.created_at,
       (SELECT coalesce(max(seq),0) FROM service_events e WHERE e.workspace_id=i.workspace_id) AS head_seq,
       COALESCE((SELECT json_agg(json_build_object('id',k.id,'prefix',k.prefix,'label',k.label,'expiresAt',k.expires_at,'revokedAt',k.revoked_at,'lastUsedAt',k.last_used_at,'createdAt',k.created_at) ORDER BY k.created_at) FROM api_keys k WHERE k.identity_id=i.id),'[]'::json) AS keys
     FROM service_identities i WHERE i.workspace_id=$1 ORDER BY i.created_at`, [a.workspaceId])).rows;
  return rows.map((r) => ({ ...r, key_hint: undefined }));
}

export async function updateIdentity(a: Actor, id: string, input: unknown) {
  adminOnly(a);
  const b = createSchema.partial().omit({ name: true }).extend({ status: z.enum(['active', 'disabled']).optional() }).parse(input);
  const cur = await own(pool, a, id);
  const nextAuto = b.autonomy ?? cur.autonomy; const nextScopes = b.scopes ?? cur.scopes;
  // Only the owner may widen into customer-facing sending; anyone admin+ may narrow at any time.
  if ((b.autonomy === 'send' && cur.autonomy !== 'send') || (b.scopes?.includes('messages:send') && !cur.scopes.includes('messages:send'))) sendGate(a, nextAuto, nextScopes);
  if (b.departmentIds) await checkDepartments(pool, a.workspaceId, b.departmentIds);
  if (b.webhookUrl !== undefined) await checkWebhook(b.webhookUrl);
  let whsec: string | null = null;
  await tx(async (c) => {
    const set: string[] = []; const p: unknown[] = [id]; const add = (col: string, v: unknown) => { p.push(v); set.push(`${col}=$${p.length}`); };
    if (b.scopes) add('scopes', b.scopes); if (b.departmentIds) add('department_ids', b.departmentIds); if (b.autonomy) add('autonomy', b.autonomy);
    if (b.status) add('status', b.status); if (b.rateLimitPerMin) add('rate_limit_per_min', b.rateLimitPerMin);
    if (b.webhookUrl !== undefined) {
      add('webhook_url', b.webhookUrl);
      if (b.webhookUrl && !cur.webhook_secret_enc) { whsec = `whsec_${randomBytes(24).toString('base64url')}`; const e = encryptJson({ secret: whsec }, `svc:${id}`); add('webhook_secret_enc', e.enc); add('key_version', e.keyVersion); }
    }
    if (set.length) await c.query(`UPDATE service_identities SET ${set.join(', ')} WHERE id=$1`, p);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.identity.update', targetType: 'service_identity', targetId: id, meta: { changed: Object.keys(b), autonomy: b.autonomy, status: b.status } });
  });
  return { ok: true, webhookSecret: whsec };
}

export async function rotateWebhookSecret(a: Actor, id: string) {
  adminOnly(a); const cur = await own(pool, a, id); if (!cur.webhook_url) throw new HttpError(409, 'no webhook configured');
  const whsec = `whsec_${randomBytes(24).toString('base64url')}`; const e = encryptJson({ secret: whsec }, `svc:${id}`);
  await pool.query('UPDATE service_identities SET webhook_secret_enc=$2, key_version=$3 WHERE id=$1', [id, e.enc, e.keyVersion]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.webhook_secret.rotate', targetType: 'service_identity', targetId: id });
  return { webhookSecret: whsec };
}
export const webhookSecretOf = (row: { id: string; webhook_secret_enc: string }) => decryptJson<{ secret: string }>(row.webhook_secret_enc, `svc:${row.id}`).secret;

export async function createKey(a: Actor, identityId: string, input: unknown) {
  adminOnly(a); await own(pool, a, identityId);
  const b = z.object({ label: z.string().max(60).default('additional'), expiresInDays: z.number().int().min(1).max(730).optional() }).parse(input ?? {});
  const k = await issueKey(pool, a, identityId, b.label, b.expiresInDays ? new Date(Date.now() + b.expiresInDays * 86400_000) : null);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.key.create', targetType: 'service_identity', targetId: identityId, meta: { keyId: k.id } });
  return { keyId: k.id, apiKey: k.key, note: 'Store this key now — it is shown only once.' };
}
export async function revokeKey(a: Actor, identityId: string, keyId: string) {
  adminOnly(a); await own(pool, a, identityId);
  const r = await pool.query('UPDATE api_keys SET revoked_at=COALESCE(revoked_at, now()) WHERE id=$1 AND identity_id=$2 RETURNING id', [keyId, identityId]);
  if (!r.rowCount) throw new HttpError(404, 'key not found');
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.key.revoke', targetType: 'service_identity', targetId: identityId, meta: { keyId } });
}
/** Emergency stop: disables the identity (every key stops working at once) and suppresses its queued, not-yet-sent customer messages. */
export async function disableIdentity(a: Actor, identityId: string) {
  adminOnly(a); await own(pool, a, identityId);
  await tx(async (c) => {
    await c.query(`UPDATE service_identities SET status='disabled' WHERE id=$1`, [identityId]);
    await c.query(`UPDATE messages SET status='suppressed', status_detail='assistant_disabled' WHERE service_identity_id=$1 AND status='queued'`, [identityId]);
    await audit(c, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.identity.disable', targetType: 'service_identity', targetId: identityId });
  });
}

// ---------- authentication ----------
const KEY_RE = /^rk_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/;
export async function authenticateKey(header: string | undefined): Promise<ServiceContext | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? ''); if (!m) return null;
  const km = KEY_RE.exec(m[1]); if (!km) return null;
  // Always read current state from the DB: revocation, disabling and scope changes take effect on the very next request.
  const r = (await pool.query(
    `SELECT k.id AS key_id, k.secret_hash, k.expires_at, k.revoked_at, k.last_used_at AS key_last, i.*
     FROM api_keys k JOIN service_identities i ON i.id=k.identity_id WHERE k.prefix=$1`, [km[1]])).rows[0];
  const want = Buffer.from(hash(m[1]));
  const got = Buffer.from(r?.secret_hash ?? hash('x'));
  const ok = timingSafeEqual(want, got.length === want.length ? got : Buffer.alloc(want.length)) && !!r;
  if (!ok || r.revoked_at || r.status !== 'active' || (r.expires_at && new Date(r.expires_at) < new Date())) return null;
  if (!r.key_last || Date.now() - new Date(r.key_last).getTime() > 60_000) {   // throttled so a busy client doesn't write on every call
    await pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [r.key_id]);
    await pool.query('UPDATE service_identities SET last_used_at=now() WHERE id=$1', [r.id]);
  }
  return { identityId: r.id, keyId: r.key_id, workspaceId: r.workspace_id, name: r.name, scopes: new Set(r.scopes as string[]), autonomy: r.autonomy, departmentIds: r.department_ids, rateLimitPerMin: r.rate_limit_per_min,
    actor: { userId: r.id, workspaceId: r.workspace_id, role: 'staff', departmentIds: r.department_ids, name: r.name } };
}

// Per-process token bucket (fixed one-minute window). Multi-process deployments get N× the limit; documented in the runbook.
const buckets = new Map<string, { windowStart: number; count: number }>();
export function rateCheck(ctx: ServiceContext, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
  const b = buckets.get(ctx.identityId);
  if (!b || now - b.windowStart >= 60_000) { buckets.set(ctx.identityId, { windowStart: now, count: 1 }); return { ok: true }; }
  if (b.count >= ctx.rateLimitPerMin) return { ok: false, retryAfter: Math.max(1, Math.ceil((b.windowStart + 60_000 - now) / 1000)) };
  b.count++; return { ok: true };
}
export const resetRateBuckets = () => buckets.clear();

// ---------- authority rules ----------
export const DEFAULT_RULES: { topic: string; keywords: string[] }[] = [
  { topic: 'refunds', keywords: ['refund', 'money back', 'reimburse', 'chargeback', 'credit you'] },
  { topic: 'discounts_and_negotiation', keywords: ['discount', '% off', 'percent off', 'price drop', 'lower the price', 'best price', 'lowest price', 'knock off', 'match the price', 'special deal'] },
  { topic: 'financing_terms', keywords: ['apr', 'interest rate', 'monthly payment', 'per month', '/mo', 'down payment', 'pre-approved', 'preapproved', 'you are approved', "you're approved", 'loan term', 'financing terms'] },
];
export async function ensureDefaultRules(db: Db, workspaceId: string) {
  const r = await db.query('UPDATE workspaces SET assistant_rules_seeded=true WHERE id=$1 AND NOT assistant_rules_seeded RETURNING id', [workspaceId]);
  if (!r.rowCount) return;
  for (const d of DEFAULT_RULES) await db.query(`INSERT INTO assistant_rules (workspace_id, topic, keywords, built_in) VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, [workspaceId, d.topic, d.keywords]);
}
export async function listRules(a: Actor) { adminOnly(a); await ensureDefaultRules(pool, a.workspaceId); return (await pool.query('SELECT id, topic, keywords, enabled, built_in, updated_at FROM assistant_rules WHERE workspace_id=$1 ORDER BY topic', [a.workspaceId])).rows; }
const ruleSchema = z.object({ topic: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and underscores'), keywords: z.array(z.string().trim().min(2).max(60)).min(1).max(60), enabled: z.boolean().default(true) });
export async function upsertRule(a: Actor, input: unknown) {
  adminOnly(a); const b = ruleSchema.parse(input); await ensureDefaultRules(pool, a.workspaceId);
  const keywords = [...new Set(b.keywords.map((k) => k.toLowerCase()))];
  const r = await pool.query(`INSERT INTO assistant_rules (workspace_id, topic, keywords, enabled, updated_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (workspace_id, topic) DO UPDATE SET keywords=EXCLUDED.keywords, enabled=EXCLUDED.enabled, updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING id`, [a.workspaceId, b.topic, keywords, b.enabled, a.userId]);
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.rule.upsert', targetType: 'assistant_rule', targetId: r.rows[0].id, meta: { topic: b.topic, enabled: b.enabled, keywords: keywords.length } });
  return { id: r.rows[0].id as string };
}
export async function deleteRule(a: Actor, id: string) {
  adminOnly(a);
  const r = await pool.query('DELETE FROM assistant_rules WHERE id=$1 AND workspace_id=$2 RETURNING topic, built_in', [id, a.workspaceId]);
  if (!r.rowCount) throw new HttpError(404, 'rule not found');
  await audit(pool, { workspaceId: a.workspaceId, actorUserId: a.userId, action: 'assistant.rule.delete', targetType: 'assistant_rule', targetId: id, meta: { topic: r.rows[0].topic } });
}

export type AuthorityVerdict = { ok: true } | { ok: false; topic: string; detail: string };
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');
/** Keyword rules + ungrounded dollar amounts. A dollar figure is "grounded" if it equals an inventory price or a figure the customer themselves wrote in this conversation. */
export async function checkAuthority(db: Db, workspaceId: string, conversationId: string, body: string): Promise<AuthorityVerdict> {
  await ensureDefaultRules(db, workspaceId);
  const text = norm(body);
  const rules = (await db.query('SELECT topic, keywords FROM assistant_rules WHERE workspace_id=$1 AND enabled', [workspaceId])).rows;
  for (const r of rules) for (const k of r.keywords as string[]) {
    const kw = norm(k);
    // Short alphabetic keywords (e.g. "apr") must match as whole words so "caprice"/"april" don't trip them.
    const hit = /^[a-z ]+$/.test(kw) && kw.length <= 4 ? new RegExp(`(^|[^a-z])${kw}([^a-z]|$)`).test(text) : text.includes(kw);
    if (hit) return { ok: false, topic: r.topic, detail: `message mentions “${k}”` };
  }
  const amounts = [...body.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k\b)?/gi)].map((m) => Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1)));
  if (amounts.length) {
    const prices = new Set((await db.query(`SELECT round(price)::bigint AS p FROM inventory_boats WHERE workspace_id=$1 AND price IS NOT NULL`, [workspaceId])).rows.map((r) => Number(r.p)));
    const said = (await db.query(`SELECT body FROM messages WHERE conversation_id=$1 AND direction='inbound' AND redacted_at IS NULL ORDER BY seq DESC LIMIT 30`, [conversationId])).rows.map((r) => r.body as string).join(' ');
    const theirs = new Set([...said.matchAll(/\$?\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k\b)?/gi)].map((m) => Math.round(parseFloat(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1))));
    const bad = amounts.find((n) => !prices.has(n) && !theirs.has(n));
    if (bad !== undefined) return { ok: false, topic: 'ungrounded_price', detail: `$${bad.toLocaleString('en-US')} does not match any inventory price or an amount the customer wrote` };
  }
  return { ok: true };
}
