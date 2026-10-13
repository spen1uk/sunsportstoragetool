import { pool, tx } from '../db/pool.js';
import { HttpError, atLeastManager, requireConversation, isAdmin, type Actor } from './authz.js';

export const TEMPLATE_CATEGORIES = ['sales', 'inventory_status', 'price_change', 'appointment', 'brokerage', 'parts', 'service_progress', 'service_pickup', 'storage', 'invoice_reminder', 'review_request', 'general'] as const;

const VAR_RE = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;
export const extractVariables = (body: string) => [...new Set([...body.matchAll(VAR_RE)].map((m) => m[1].toLowerCase()))];

/** Values come only from data the business entered (contact record, boats, workspace settings) — never invented. */
export async function resolveVariables(a: Actor, conversationId?: string): Promise<Record<string, string>> {
  const v: Record<string, string> = {};
  const ws = (await pool.query('SELECT name FROM workspaces WHERE id=$1', [a.workspaceId])).rows[0];
  v.business_name = 'Sun Sport Marine';           // business name is fixed by the handoff; other facts come from settings
  void ws;
  for (const r of (await pool.query('SELECT key, value FROM workspace_settings WHERE workspace_id=$1', [a.workspaceId])).rows) v[r.key] = r.value;
  v.staff_name = a.name ?? '';
  if (conversationId) {
    await requireConversation(pool, a, conversationId);
    const c = (await pool.query(`SELECT ct.id, ct.first_name, ct.last_name, ct.company FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id WHERE cv.id=$1`, [conversationId])).rows[0];
    // A bare phone number stored as first_name (auto-created lead) is not a name.
    const first = c.first_name && !/^\+?\d[\d\s()-]*$/.test(c.first_name) ? c.first_name : '';
    v.first_name = first; v.last_name = c.last_name ?? ''; v.full_name = [first, c.last_name].filter(Boolean).join(' '); v.company = c.company ?? '';
    const boat = (await pool.query(`SELECT year, make, model FROM customer_boats WHERE contact_id=$1 AND relation='interested' ORDER BY created_at DESC LIMIT 1`, [c.id])).rows[0];
    if (boat) { v.boat_year = boat.year ? String(boat.year) : ''; v.boat_make = boat.make ?? ''; v.boat_model = boat.model ?? ''; v.boat_description = [boat.year, boat.make, boat.model].filter(Boolean).join(' '); }
  }
  return v;
}

/** Render; `missing` lists every variable that has no value so callers can refuse to send half-filled text. */
export function render(body: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(VAR_RE, (_m, name: string) => {
    const k = name.toLowerCase(); const val = vars[k];
    if (val === undefined || val.trim() === '') { if (!missing.includes(k)) missing.push(k); return `{{${k}}}`; }
    return val;
  });
  return { text, missing };
}

export async function createTemplate(a: Actor, t: { category: string; name: string; body: string; departmentId?: string | null }) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to manage templates');
  if (!TEMPLATE_CATEGORIES.includes(t.category as never)) throw new HttpError(400, 'unknown category');
  return tx(async (c) => {
    const r = await c.query(`INSERT INTO templates (workspace_id, category, name, department_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [a.workspaceId, t.category, t.name, t.departmentId ?? null, a.userId])
      .catch((e) => { if (e.code === '23505') throw new HttpError(409, 'a template with that name exists'); throw e; });
    await c.query(`INSERT INTO template_versions (template_id, version, body, created_by) VALUES ($1,1,$2,$3)`, [r.rows[0].id, t.body, a.userId]);
    return r.rows[0].id as string;
  });
}

export async function updateTemplate(a: Actor, id: string, body: string) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to manage templates');
  return tx(async (c) => {
    const t = (await c.query('SELECT current_version FROM templates WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [id, a.workspaceId])).rows[0];
    if (!t) throw new HttpError(404, 'template not found');
    const v = t.current_version + 1;
    await c.query('INSERT INTO template_versions (template_id, version, body, created_by) VALUES ($1,$2,$3,$4)', [id, v, body, a.userId]);
    await c.query('UPDATE templates SET current_version=$2 WHERE id=$1', [id, v]);
    return v;
  });
}
export async function revertTemplate(a: Actor, id: string, version: number) {
  const old = (await pool.query('SELECT body FROM template_versions tv JOIN templates t ON t.id=tv.template_id WHERE tv.template_id=$1 AND tv.version=$2 AND t.workspace_id=$3', [id, version, a.workspaceId])).rows[0];
  if (!old) throw new HttpError(404, 'version not found');
  return updateTemplate(a, id, old.body);     // revert creates a NEW version; history is never rewritten
}
export async function setTemplateActive(a: Actor, id: string, active: boolean) {
  if (!atLeastManager(a)) throw new HttpError(403, 'manager role required to manage templates');
  await pool.query('UPDATE templates SET is_active=$3 WHERE id=$1 AND workspace_id=$2', [id, a.workspaceId, active]);
}
export async function toggleFavorite(a: Actor, id: string, fav: boolean) {
  await getTemplate(a, id);
  if (fav) await pool.query('INSERT INTO template_favorites VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, a.userId]);
  else await pool.query('DELETE FROM template_favorites WHERE template_id=$1 AND user_id=$2', [id, a.userId]);
}

export async function listTemplates(a: Actor, q: { search?: string; category?: string; favoritesOnly?: boolean; includeInactive?: boolean }) {
  const params: unknown[] = [a.workspaceId, a.userId, a.departmentIds];
  const where = ['t.workspace_id=$1'];
  where.push(isAdmin(a) ? '$3::uuid[] IS NOT NULL' : '(t.department_id IS NULL OR t.department_id = ANY($3::uuid[]))');
  if (!(q.includeInactive && atLeastManager(a))) where.push('t.is_active');
  if (q.category) { params.push(q.category); where.push(`t.category=$${params.length}`); }
  if (q.search) { params.push(`%${q.search}%`); where.push(`(t.name ILIKE $${params.length} OR tv.body ILIKE $${params.length})`); }
  if (q.favoritesOnly) where.push('f.user_id IS NOT NULL');
  return (await pool.query(
    `SELECT t.id, t.category, t.name, t.department_id, t.current_version, t.is_active, tv.body, (f.user_id IS NOT NULL) AS favorite
     FROM templates t JOIN template_versions tv ON tv.template_id=t.id AND tv.version=t.current_version
     LEFT JOIN template_favorites f ON f.template_id=t.id AND f.user_id=$2 WHERE ${where.join(' AND ')} ORDER BY (f.user_id IS NOT NULL) DESC, t.category, t.name`, params)).rows;
}
export async function getTemplate(a: Actor, id: string) {
  const r = (await listTemplates(a, { includeInactive: true })).find((t) => t.id === id);
  if (!r) throw new HttpError(404, 'template not found');
  return r;
}
export async function templateVersions(a: Actor, id: string) {
  await getTemplate(a, id);
  return (await pool.query('SELECT version, body, created_at, created_by FROM template_versions WHERE template_id=$1 ORDER BY version DESC', [id])).rows;
}
export async function renderTemplate(a: Actor, id: string, conversationId?: string) {
  const t = await getTemplate(a, id);
  return { ...render(t.body, await resolveVariables(a, conversationId)), templateId: id, version: t.current_version };
}
