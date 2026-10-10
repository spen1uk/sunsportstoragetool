import { type DB, id } from './db.ts';
import { chicagoParts } from './tz.ts';
import { dailyInstants } from './schedule.ts';
import { decideContact, nextStep, type Escalation, type Attempt } from './contact.ts';
import { getMode } from './modes.ts';
import { clients, publish } from './events.ts';
import { isPaused } from './pause.ts';
import { buildBriefing, buildRecap } from './today.ts';
import { audit } from './audit.ts';

const rows = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];
const STALE_MS = 3 * 3600_000;

type NewN = { key: string; kind: string; title: string; body?: string; link?: string; urgency?: 'routine' | 'urgent' | 'emergency'; dueAt: number; state?: 'pending' | 'skipped'; note?: string };
export function enqueue(db: DB, n: NewN, now = Date.now()) {
  const r = db.prepare('INSERT OR IGNORE INTO notifications(id,key,kind,title,body,link,urgency,due_at,created_at,state,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id(), n.key, n.kind, n.title, n.body ?? '', n.link ?? '', n.urgency ?? 'routine', n.dueAt, now, n.state ?? 'pending', n.note ?? '');
  return !!r.changes;
}

function createScheduled(db: DB, now: number) {
  const p = chicagoParts(now), day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const t = dailyInstants(p.y, p.m, p.d);
  const open = rows(db, "SELECT title, priority FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state NOT IN ('completed','canceled') ORDER BY priority");
  const defs: [keyof typeof t, string, () => { title: string; body: string; link: string } | null][] = [
    ['briefing', 'briefing', () => { const b = buildBriefing(db, now); const u = b.sections[0].items.length; return { title: 'Morning briefing is ready', body: `${u} urgent item(s) · ${b.schedule.blocks.length} block(s) proposed · ~${Math.max(1, Math.round(b.estimatedSeconds / 60))} min`, link: '#/briefings' }; }],
    ['noon', 'reminder', () => remind(open, 'Midday')], ['afternoon', 'reminder', () => remind(open, 'Afternoon')], ['evening', 'reminder', () => remind(open, 'Evening')],
    ['recap', 'recap', () => { const r = buildRecap(db, now); return { title: 'Evening recap', body: `${r.completedToday.length} done today · ${r.unfinished.length} unfinished · ${r.overnightCount} overnight item(s)`, link: '#/briefings' }; }],
  ];
  for (const [k, kind, content] of defs) {
    if (now < t[k]) continue;
    const key = `daily:${day}:${k}`;
    if (db.prepare('SELECT 1 FROM notifications WHERE key=?').get(key)) continue;
    if (now - t[k] > STALE_MS) { enqueue(db, { key, kind, title: `${k} (missed)`, dueAt: t[k], state: 'skipped', note: 'missed: Jarvis was not running at the scheduled time' }, now); continue; }
    const c = content();
    if (!c) enqueue(db, { key, kind, title: k, dueAt: t[k], state: 'skipped', note: 'nothing to remind about' }, now);
    else enqueue(db, { key, kind, ...c, dueAt: t[k] }, now);
  }
}
function remind(open: { title: string; priority: number }[], label: string) {
  if (!open.length) return null; // completion cancels reminders: nothing unfinished, nothing sent
  const imp = open.filter((t) => t.priority <= 2), rest = open.length - imp.length;
  return { title: `${label} check-in: ${open.length} unfinished`, body: [imp.length ? `Important: ${imp.map((t) => t.title).join('; ')}` : '', rest ? `${rest} other` : ''].filter(Boolean).join(' · '), link: '#/tasks' };
}

function createEventDriven(db: DB, now: number) {
  for (const a of rows(db, "SELECT * FROM approvals WHERE status='pending'")) enqueue(db, { key: `approval:${a.id}`, kind: 'approval', title: 'Approval needed', body: a.summary, link: '#/approvals', dueAt: now }, now);
  for (const a of rows(db, "SELECT * FROM artifacts WHERE status='in_review' AND is_demo=0")) enqueue(db, { key: `review:${a.id}:${a.current_version}`, kind: 'review', title: 'Ready for review', body: a.title, link: '#/review', dueAt: now }, now);
  // Resolved items stop escalating.
  db.prepare("UPDATE notifications SET state='acked', acked_at=?, note='resolved' WHERE state='pending' AND kind='approval' AND NOT EXISTS (SELECT 1 FROM approvals a WHERE 'approval:'||a.id = notifications.key AND a.status='pending')").run(now);
  db.prepare("UPDATE notifications SET state='acked', acked_at=?, note='resolved' WHERE state='pending' AND kind='review' AND NOT EXISTS (SELECT 1 FROM artifacts a WHERE 'review:'||a.id||':'||a.current_version = notifications.key AND a.status='in_review')").run(now);
}

/** One pass: create due notifications, then advance each one's escalation under the current contact mode. Safe to call repeatedly. */
export function tickNotifications(db: DB, now = Date.now()) {
  createScheduled(db, now); createEventDriven(db, now);
  const delivered: string[] = [];
  if (isPaused(db)) return { delivered }; // pause stops new automated dispatch
  const mode = getMode(db, now).mode, atComputer = clients.n > 0;
  for (const n of rows(db, "SELECT * FROM notifications WHERE state='pending' AND due_at<=? AND (snoozed_until IS NULL OR snoozed_until<=?) ORDER BY CASE urgency WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, CASE kind WHEN 'approval' THEN 0 ELSE 1 END, due_at", now, now)) {
    const attempts: Attempt[] = [];
    if (n.desktop_at) attempts.push({ at: n.desktop_at, channel: 'desktop' }); if (n.text_at) attempts.push({ at: n.text_at, channel: 'text' });
    const e: Escalation = { kind: n.urgency === 'routine' ? 'attention' : 'urgent', startedAt: n.due_at, attempts, acknowledged: false };
    const step = nextStep(e, now, { mode, atComputer, urgency: n.urgency });
    if (step.action === 'send' && step.channel === 'desktop') {
      db.prepare('UPDATE notifications SET desktop_at=? WHERE id=?').run(now, n.id); delivered.push(n.id);
      publish({ type: 'notify', id: n.id, title: n.title, body: n.body, link: n.link });
      // Briefing/recap also text immediately (when allowed). No SMS adapter exists, so this is recorded, never sent.
      if ((n.kind === 'briefing' || n.kind === 'recap') && decideContact(now, { mode, atComputer }).channels.includes('text'))
        db.prepare("UPDATE notifications SET text_at=?, text_note='NOT SENT: no SMS adapter connected' WHERE id=?").run(now, n.id);
    } else if (step.action === 'send') {
      db.prepare('UPDATE notifications SET text_at=?, text_note=? WHERE id=?').run(now, `NOT SENT: no ${step.channel === 'call' ? 'call' : 'SMS'} adapter connected`, n.id);
      publish({ type: 'notifications' });
    } else if (step.action === 'stop') {
      db.prepare("UPDATE notifications SET state='delivered' WHERE id=? AND state='pending'").run(n.id);
    }
  }
  if (delivered.length) { publish({ type: 'notifications' }); audit(db, 'system', 'notify.desktop', '', { count: delivered.length }); }
  return { delivered };
}

export const ack = (db: DB, nid: string, now = Date.now()) => db.prepare("UPDATE notifications SET state='acked', acked_at=? WHERE id=? AND state IN ('pending','delivered')").run(now, nid).changes > 0;
/** Opening it suppresses further escalation but is NOT an acknowledgment of a decision. */
export const seen = (db: DB, nid: string) => db.prepare("UPDATE notifications SET state='delivered' WHERE id=? AND state='pending'").run(nid).changes > 0;
export const snooze = (db: DB, nid: string, minutes: number, now = Date.now()) => db.prepare("UPDATE notifications SET snoozed_until=?, state='pending' WHERE id=? AND state IN ('pending','delivered')").run(now + minutes * 60_000, nid).changes > 0;
