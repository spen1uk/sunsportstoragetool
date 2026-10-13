import { z } from 'zod';
import type { DB } from './db.ts';
import { now } from './db.ts';

/** Modular Workspace: named panel layouts, stored whole. The browser draws them; the server only validates and keeps them. */
export const WIDGETS = ['conversation', 'today', 'calendar', 'tasks', 'approvals', 'review', 'habits', 'people', 'learning', 'links', 'spend', 'systems'] as const;
export const widgetSchema = z.object({ id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/), type: z.enum(WIDGETS), x: z.number().int().min(0).max(11), y: z.number().int().min(0).max(400), w: z.number().int().min(2).max(12), h: z.number().int().min(3).max(24) }).refine((v) => v.x + v.w <= 12, 'panel runs past the right edge');
export const layoutSchema = z.array(widgetSchema).max(24).refine((l) => new Set(l.map((w) => w.id)).size === l.length, 'duplicate panel id');
const nameSchema = z.string().min(1).max(40).regex(/^[A-Za-z0-9 _-]+$/, 'Names can use letters, numbers, spaces, - and _');

export const DEFAULT_LAYOUT: z.infer<typeof layoutSchema> = [
  { id: 'conversation', type: 'conversation', x: 0, y: 0, w: 6, h: 12 }, { id: 'today', type: 'today', x: 6, y: 0, w: 6, h: 6 },
  { id: 'tasks', type: 'tasks', x: 6, y: 6, w: 3, h: 6 }, { id: 'approvals', type: 'approvals', x: 9, y: 6, w: 3, h: 6 },
  { id: 'calendar', type: 'calendar', x: 0, y: 12, w: 6, h: 6 }, { id: 'habits', type: 'habits', x: 6, y: 12, w: 3, h: 6 }, { id: 'spend', type: 'spend', x: 9, y: 12, w: 3, h: 6 },
];
const KEY = (n: string) => `workspace:${n}`;
export function getWorkspaces(db: DB) {
  const all = db.prepare("SELECT key,json FROM layouts WHERE key LIKE 'workspace:%'").all() as { key: string; json: string }[];
  const layouts: Record<string, unknown> = {}; let active = 'Main';
  for (const r of all) { const n = r.key.slice(10); if (n === '@active') { try { active = String(JSON.parse(r.json)); } catch { /* keep default */ } continue; } try { layouts[n] = layoutSchema.parse(JSON.parse(r.json)); } catch { /* skip a corrupt layout */ } }
  if (!layouts.Main) layouts.Main = DEFAULT_LAYOUT;
  if (!layouts[active]) active = 'Main';
  return { active, layouts, default: DEFAULT_LAYOUT };
}
export function saveLayout(db: DB, name: string, layout: unknown) {
  const n = nameSchema.parse(name.trim()), l = layoutSchema.parse(layout);
  if (n === '@active') throw new Error('reserved name');
  const count = (db.prepare("SELECT COUNT(*) c FROM layouts WHERE key LIKE 'workspace:%' AND key!='workspace:@active'").get() as any).c;
  const exists = db.prepare('SELECT 1 FROM layouts WHERE key=?').get(KEY(n));
  if (!exists && count >= 12) throw new Error('You can keep up to 12 saved layouts. Delete one first.');
  db.prepare('INSERT INTO layouts(key,json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at').run(KEY(n), JSON.stringify(l), now());
}
export function setActive(db: DB, name: string) {
  const n = nameSchema.parse(name.trim()); if (!getWorkspaces(db).layouts[n]) throw new Error('no such layout');
  db.prepare("INSERT INTO layouts(key,json,updated_at) VALUES('workspace:@active',?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at").run(JSON.stringify(n), now());
}
export function deleteLayout(db: DB, name: string) {
  if (name === 'Main') throw new Error('The Main layout cannot be deleted; reset it instead.');
  db.prepare('DELETE FROM layouts WHERE key=?').run(KEY(name));
  if (getWorkspaces(db).active === name) setActive(db, 'Main');
}
