import { z } from 'zod';
import type { DB } from './db.ts';
import { id, now } from './db.ts';
import { publish } from './events.ts';

const clean = (s: string, n: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Turn what Luke typed into a safe web address, or explain why not. Only plain http(s) links; never a login embedded in the address; never script/file/other schemes. */
export function normalizeUrl(raw: string): string {
  let t = raw.trim(); if (!t) throw new Error('Paste a web address.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = 'https://' + t;
  let u: URL; try { u = new URL(t); } catch { throw new Error('That does not look like a web address.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https links are allowed.');
  if (u.username || u.password) throw new Error('Links with a username or password inside are not allowed (they leak your login).');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new Error('That does not look like a web address.');
  return u.href.slice(0, 500);
}

export const linkInput = z.object({ title: z.string().min(1).max(60), url: z.string().min(1).max(500) });
export function addLink(db: DB, raw: unknown) {
  const l = linkInput.parse(raw), title = clean(l.title, 60); if (!title) throw new Error('A link needs a name.');
  if ((db.prepare('SELECT COUNT(*) c FROM links').get() as any).c >= 40) throw new Error('That is a lot of links. Remove one first.');
  const lid = id(); db.prepare('INSERT INTO links(id,title,url,created_at) VALUES(?,?,?,?)').run(lid, title, normalizeUrl(l.url), now()); publish({ type: 'life' }); return lid;
}
export const listLinks = (db: DB) => (db.prepare('SELECT id,title,url FROM links ORDER BY created_at').all() as { id: string; title: string; url: string }[]).map((l) => ({ ...l, host: new URL(l.url).hostname.replace(/^www\./, '') }));
export function removeLink(db: DB, lid: string) { const r = db.prepare('DELETE FROM links WHERE id=?').run(lid); publish({ type: 'life' }); return r.changes > 0; }
