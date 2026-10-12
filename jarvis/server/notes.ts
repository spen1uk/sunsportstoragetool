import { z } from 'zod';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { audit } from './audit.ts';
import { getRunner, MacError } from './mac.ts';
import { rememberSources, sources, recordSync } from './calendar.ts';

const MAX_PER_FOLDER = 300, MAX_BODY = 8000;
const LIST_JS = `function run(){ const N = Application('Notes'); return JSON.stringify(Array.from(new Set(N.folders().map(f => f.name())))); }`;
const NOTES_JS = `function run(argv){
  const want = JSON.parse(argv[0]), max = Number(argv[1]), N = Application('Notes'), out = [];
  for (const f of N.folders()) {
    const fn = f.name(); if (want.indexOf(fn) < 0) continue;
    const ns = f.notes, n = Math.min(ns.length, max); if (!n) continue;
    const id = ns.id(), name = ns.name(), body = ns.plaintext(), mod = ns.modificationDate();
    for (let i = 0; i < n; i++) out.push({ id: String(id[i]), folder: fn, title: String(name[i] || ''), body: String(body[i] || ''), modified: mod[i].getTime() });
  }
  return JSON.stringify(out);
}`;
const Row = z.object({ id: z.string().min(1).max(500), folder: z.string().min(1).max(200), title: z.string().max(2000), body: z.string(), modified: z.number().int() });
const ctl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export function parseNotes(raw: string) {
  const out: { id: string; folder: string; title: string; body: string; modified: number }[] = [];
  for (const x of z.array(z.unknown()).parse(JSON.parse(raw))) {
    const r = Row.safeParse(x); if (!r.success) continue;
    out.push({ ...r.data, title: r.data.title.replace(ctl, ' ').trim().slice(0, 200) || '(untitled)', body: r.data.body.replace(ctl, ' ').slice(0, MAX_BODY) });
  }
  return out;
}

export async function detectFolders(db: DB): Promise<string[]> {
  const names = z.array(z.string()).parse(JSON.parse(await getRunner()(LIST_JS, [], 30_000)));
  rememberSources(db, 'notes', names); return names;
}

let syncing = false;
export async function syncNotes(db: DB, now = Date.now()): Promise<{ ok: boolean; count?: number; error?: string }> {
  const want = sources(db, 'notes').filter((s) => s.enabled).map((s) => s.name);
  if (!want.length) return { ok: false, error: 'Choose at least one Notes folder first.' };
  if (syncing) return { ok: false, error: 'A sync is already running.' };
  syncing = true;
  try {
    const notes = parseNotes(await getRunner()(NOTES_JS, [JSON.stringify(want), String(MAX_PER_FOLDER)], 180_000)).filter((n) => want.includes(n.folder));
    tx(db, () => {
      db.prepare('DELETE FROM notes_cache').run();
      const ins = db.prepare('INSERT OR REPLACE INTO notes_cache(id,folder,title,body,modified_ms) VALUES(?,?,?,?,?)');
      for (const n of notes) ins.run(n.id, n.folder, n.title, n.body, n.modified);
    });
    recordSync(db, 'notes', true, notes.length, null, now);
    audit(db, 'jarvis', 'notes.sync', '', { count: notes.length });
    return { ok: true, count: notes.length };
  } catch (e) {
    const msg = e instanceof MacError ? e.message : 'Notes sync failed.';
    recordSync(db, 'notes', false, 0, msg, now); audit(db, 'jarvis', 'notes.sync_failed', '', { kind: (e as any)?.kind ?? 'failed' });
    return { ok: false, error: msg };
  } finally { syncing = false; }
}

export type NoteSummary = { id: string; folder: string; title: string; snippet: string; modified: number };
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);
export function listNotes(db: DB, q = '', limit = 60): NoteSummary[] {
  const rows = (q.trim()
    ? db.prepare("SELECT * FROM notes_cache WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY modified_ms DESC LIMIT ?").all(`%${esc(q.trim())}%`, `%${esc(q.trim())}%`, limit)
    : db.prepare('SELECT * FROM notes_cache ORDER BY modified_ms DESC LIMIT ?').all(limit)) as any[];
  return rows.map((r) => ({ id: r.id, folder: r.folder, title: r.title, snippet: r.body.replace(/\s+/g, ' ').trim().slice(0, 200), modified: r.modified_ms }));
}
export const getNote = (db: DB, id: string) => { const r = db.prepare('SELECT * FROM notes_cache WHERE id=?').get(id) as any; return r ? { id: r.id, folder: r.folder, title: r.title, body: r.body, modified: r.modified_ms } : null; };
