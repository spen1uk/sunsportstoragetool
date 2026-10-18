import crypto from 'node:crypto';
import { z } from 'zod';
import { type DB, id } from '../db.ts';
import { audit } from '../audit.ts';
import { publish } from '../events.ts';
import { looksSecret } from '../memory.ts';
import { isExcluded } from '../exclusions.ts';

/**
 * Gaps: places where Jarvis demonstrably fell short. Found by counting real failures (free, no model), or filed by Luke or an agent.
 * A gap is only a note. Filing or finding one never changes anything.
 */
const WINDOW = 14 * 86_400_000, MAX_OPEN = 30;
const h = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const norm = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
export type Gap = { id: string; kind: string; key: string; title: string; detail: string; evidence: any; severity: number; status: string; count: number; filed_by: string; first_seen: number; last_seen: number };
const hydrate = (r: any): Gap => ({ ...r, evidence: JSON.parse(r.evidence) });
export const get = (db: DB, gid: string) => { const r = db.prepare('SELECT * FROM gaps WHERE id=?').get(gid); return r ? hydrate(r) : null; };
export const list = (db: DB) => (db.prepare("SELECT * FROM gaps ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, severity DESC, last_seen DESC LIMIT 100").all() as any[]).map(hydrate);

function upsert(db: DB, g: { kind: string; key: string; title: string; detail: string; evidence: unknown; severity: number; count: number }, by: string, now: number) {
  const cur = db.prepare('SELECT id,status FROM gaps WHERE key=?').get(g.key) as { id: string; status: string } | undefined;
  if (cur) { db.prepare('UPDATE gaps SET count=?, last_seen=?, evidence=?, detail=? WHERE id=?').run(g.count, now, JSON.stringify(g.evidence), g.detail, cur.id); return null; }   // a dismissed gap stays dismissed
  if ((db.prepare("SELECT COUNT(*) c FROM gaps WHERE status='open'").get() as any).c >= MAX_OPEN) return null;
  const gid = id(); db.prepare('INSERT INTO gaps(id,kind,key,title,detail,evidence,severity,count,filed_by,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(gid, g.kind, g.key, g.title, g.detail, JSON.stringify(g.evidence), g.severity, g.count, by, now, now);
  audit(db, by === 'system' ? 'system' : by, 'improve.gap_found', gid, { kind: g.kind }); return gid;
}

/** Looks at the last two weeks of real use. Cheap, deterministic, safe to run daily. Returns how many NEW gaps appeared. */
export function scan(db: DB, now = Date.now()): number {
  let fresh = 0; const since = now - WINDOW;
  const fails = db.prepare("SELECT skill_id, COALESCE(refused, error, '') why, COUNT(*) c FROM skill_runs WHERE ok=0 AND at>? AND COALESCE(refused,'')<>'Jarvis is paused' GROUP BY skill_id, why").all(since) as { skill_id: string; why: string; c: number }[];
  const grouped = new Map<string, { skill: string; why: string; c: number }>();
  for (const f of fails) { const k = `${f.skill_id}|${norm(f.why)}`; const e = grouped.get(k); if (e) e.c += f.c; else grouped.set(k, { skill: f.skill_id, why: f.why, c: f.c }); }
  for (const [k, g] of grouped) if (g.c >= 3) if (upsert(db, { kind: 'failing_skill', key: `skill:${h(k)}`, title: `The skill "${g.skill}" keeps failing`, detail: `${g.c} failed or refused runs in 14 days. Typical reason: ${g.why.slice(0, 150) || 'unknown'}.`, evidence: { skill: g.skill, reason: g.why.slice(0, 150), count: g.c }, severity: g.c >= 8 ? 3 : 2, count: g.c }, 'system', now)) fresh++;
  const wf = db.prepare("SELECT r.workflow_id, w.name, COUNT(*) c, COALESCE(MAX(r.error),'') err FROM workflow_runs r JOIN skill_workflows w ON w.id=r.workflow_id WHERE r.ok=0 AND r.at>? GROUP BY r.workflow_id").all(since) as { workflow_id: string; name: string; c: number; err: string }[];
  for (const w of wf) if (w.c >= 3) if (upsert(db, { kind: 'failing_workflow', key: `wf:${w.workflow_id}`, title: `The workflow "${w.name}" keeps failing`, detail: `${w.c} failed runs in 14 days. Latest: ${w.err.slice(0, 150)}`, evidence: { workflowId: w.workflow_id, count: w.c }, severity: 2, count: w.c }, 'system', now)) fresh++;
  const ms = db.prepare("SELECT COALESCE(NULLIF(blockers,''), stop_reason, '') why, COUNT(*) c FROM missions WHERE status IN ('blocked','failed') AND updated_at>? GROUP BY why").all(now - 30 * 86_400_000) as { why: string; c: number }[];
  for (const m of ms) if (m.c >= 2 && m.why) if (upsert(db, { kind: 'failing_missions', key: `mission:${h(norm(m.why))}`, title: 'Research missions keep getting stuck the same way', detail: `${m.c} missions in 30 days stopped with: ${m.why.slice(0, 150)}`, evidence: { reason: m.why.slice(0, 150), count: m.c }, severity: 1, count: m.c }, 'system', now)) fresh++;
  if (fresh) publish({ type: 'improve' }); return fresh;
}

const requestIn = z.object({ title: z.string().min(6).max(120), detail: z.string().max(1000).default('') }).strict();
/** Luke (or an agent) says "I wish it could…". */
export function file(db: DB, raw: unknown, by: 'luke' | 'jarvis' | 'prometheus' = 'luke', now = Date.now()): string {
  const v = requestIn.parse(raw); if (looksSecret(`${v.title}\n${v.detail}`) || isExcluded(db, `${v.title} ${v.detail}`)) throw new Error('That looks like a secret or mentions something you asked me never to store.');
  const gid = upsert(db, { kind: 'request', key: `req:${h(v.title.toLowerCase())}`, title: v.title, detail: v.detail, evidence: {}, severity: 2, count: 1 }, by, now);
  if (!gid) throw new Error('That is already on the list, or the list is full (30 open gaps). Dismiss some first.'); publish({ type: 'improve' }); return gid;
}
export function setStatus(db: DB, gid: string, status: 'dismissed' | 'addressed' | 'open') {
  const r = db.prepare('UPDATE gaps SET status=? WHERE id=?').run(status, gid); if (r.changes) { audit(db, 'luke', `improve.gap_${status}`, gid); publish({ type: 'improve' }); } return r.changes > 0;
}
