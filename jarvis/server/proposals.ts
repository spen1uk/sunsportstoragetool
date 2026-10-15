import { z } from 'zod';
import type { DB } from './db.ts';
import { id, tx } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import { chicagoInstant } from './tz.ts';
import { isPaused } from './pause.ts';
import { createTask, completeTask } from './tasks.ts';
import { researchInput } from './research.ts';
import * as memory from './memory.ts';
import * as life from './life.ts';
import { addLink, normalizeUrl } from './links.ts';

/**
 * The chat model can only write text. When it thinks an action would help, it may PROPOSE one of the small, internal,
 * reversible actions below. A proposal is just a row; it does nothing until Luke clicks Confirm. The card he sees is built here
 * from the validated fields (never from the model's wording), nothing risky is on the list (no sending, spending, deleting,
 * publishing, trading, settings or permissions), and anything outside the list or with unknown fields is dropped.
 */
const s = (min: number, max: number) => z.string().min(min).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_task'), title: s(1, 200), minutes: z.number().int().min(5).max(480).optional(), priority: z.number().int().min(1).max(5).optional(), deadline: date.optional() }).strict(),
  z.object({ type: z.literal('complete_task'), title: s(1, 200), taskId: z.string().max(60).optional() }).strict(),
  z.object({ type: z.literal('queue_research'), question: s(3, 500), urls: z.array(z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), 'Only http(s) links')).min(1).max(8) }).strict(),
  z.object({ type: z.literal('remember'), content: s(3, 500) }).strict(),
  z.object({ type: z.literal('add_habit'), name: s(1, 60), perWeek: z.number().int().min(1).max(7).optional() }).strict(),
  z.object({ type: z.literal('log_habit'), name: s(1, 60) }).strict(),
  z.object({ type: z.literal('add_person'), name: s(1, 80), relationship: s(0, 60).optional(), everyDays: z.number().int().min(1).max(365).optional() }).strict(),
  z.object({ type: z.literal('mark_contacted'), person: s(1, 80) }).strict(),
  z.object({ type: z.literal('add_goal'), name: s(1, 60), unit: s(1, 20).optional(), perWeek: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({ type: z.literal('log_learning'), goal: s(1, 60), amount: z.number().int().min(1).max(20).optional() }).strict(),
  z.object({ type: z.literal('add_link'), title: s(1, 60), url: s(3, 500) }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export const ACTION_TYPES = ['add_task', 'complete_task', 'queue_research', 'remember', 'add_habit', 'log_habit', 'add_person', 'mark_contacted', 'add_goal', 'log_learning', 'add_link'] as const;

/** Added to the system prompt (never in private mode). Describes the proposal format; the rules above it still say the model cannot act. */
export const PROPOSAL_PROMPT = [
  'PROPOSING ACTIONS (optional): you still cannot do anything yourself. But when Luke clearly asks for one of the small actions below, or one is plainly useful, you may PROPOSE it. He will see a card with a Confirm button; nothing happens unless he clicks it.',
  'After your normal reply, add ONE final line, exactly: ACTIONS: followed by a JSON array of at most 3 objects. Say in your reply, in plain words, what you are proposing. Do not mention the JSON.',
  'Allowed objects and their fields (anything else is discarded):',
  '- {"type":"add_task","title":"...","minutes":30,"priority":1-5,"deadline":"YYYY-MM-DD"} (minutes, priority, deadline optional)',
  '- {"type":"complete_task","title":"words from an existing open task"}',
  '- {"type":"queue_research","question":"...","urls":["https://..."]} (only URLs Luke gave you)',
  '- {"type":"remember","content":"a short fact or preference worth keeping"} (never secrets)',
  '- {"type":"add_habit","name":"...","perWeek":7} / {"type":"log_habit","name":"existing habit"}',
  '- {"type":"add_person","name":"...","relationship":"...","everyDays":30} / {"type":"mark_contacted","person":"existing name"}',
  '- {"type":"add_goal","name":"...","unit":"lessons","perWeek":5} / {"type":"log_learning","goal":"existing goal","amount":1}',
  '- {"type":"add_link","title":"...","url":"https://..."}',
  'Only propose when the request is clear; if details are missing, ask instead. Never propose sending, spending, deleting, publishing, trading, settings, permissions or anything not listed.',
].join('\n');

/** Characters that make text look different from what it is (zero-width, bidi overrides, soft hyphen, BOM, control codes). A proposal containing any is dropped, so a card can never show something other than what will run. */
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/;
function normalise(v: unknown): unknown | undefined {
  if (typeof v === 'string') { if (HIDDEN.test(v)) return undefined; return v.replace(/\s+/g, ' ').trim(); }
  if (Array.isArray(v)) { const o = v.map(normalise); return o.some((x) => x === undefined) ? undefined : o; }
  return v;
}
const clean = (x: string, n = 200) => x.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const fmtDay = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); };
export function summarize(a: Action): string {
  switch (a.type) {
    case 'add_task': return `Add task: "${clean(a.title)}"${a.minutes ? ` · ${a.minutes} min` : ''}${a.priority ? ` · priority ${a.priority}` : ''}${a.deadline ? ` · due ${fmtDay(a.deadline)}` : ''}`;
    case 'complete_task': return `Mark done: task "${clean(a.title, 200)}"`;
    case 'queue_research': return `Research: "${clean(a.question, 500)}" — will fetch: ${a.urls.join('  ·  ')} (new websites will still ask for your approval)`;
    case 'remember': return `Remember: "${clean(a.content, 500)}"`;
    case 'add_habit': return `Add habit: "${clean(a.name)}"${a.perWeek ? ` · ${a.perWeek}/week` : ''}`;
    case 'log_habit': return `Check off today: habit "${clean(a.name)}"`;
    case 'add_person': return `Add person: ${clean(a.name)}${a.relationship ? ` (${clean(a.relationship)})` : ''}${a.everyDays ? ` · remind every ${a.everyDays} days` : ''}`;
    case 'mark_contacted': return `Note you were in touch with ${clean(a.person)} today`;
    case 'add_goal': return `Add learning goal: "${clean(a.name)}" · ${a.perWeek ?? 3} ${clean(a.unit ?? 'sessions', 20)}/week`;
    case 'log_learning': return `Log ${a.amount ?? 1} toward learning goal "${clean(a.goal)}"`;
    case 'add_link': { let host = ''; try { host = new URL(normalizeUrl(a.url)).hostname; } catch { host = 'an invalid address'; } return `Add quick link: "${clean(a.title, 60)}" → ${host}`; }
  }
}

/** Split a model reply into its visible text and any proposed actions. The ACTIONS line is always removed from what Luke reads. */
export function extractProposals(reply: string): { text: string; actions: Action[]; dropped: number } {
  const m = reply.match(/(?:^|\n)[ \t]*ACTIONS:[ \t]*([\s\S]*)$/);
  if (!m) return { text: reply, actions: [], dropped: 0 };
  const text = reply.slice(0, m.index).trimEnd() || '…';
  let raw: unknown; try { raw = JSON.parse(m[1].trim().replace(/^```(?:json)?|```$/g, '').trim()); } catch { return { text, actions: [], dropped: 1 }; }
  if (!Array.isArray(raw)) return { text, actions: [], dropped: 1 };
  const actions: Action[] = []; let dropped = 0;
  for (const x0 of raw.slice(0, 6)) { const x = x0 && typeof x0 === 'object' && !Array.isArray(x0) ? Object.fromEntries(Object.entries(x0 as object).map(([k, v]) => [k, normalise(v)])) : x0; if (x && typeof x === 'object' && Object.values(x).some((v) => v === undefined)) { dropped++; continue; } const r = actionSchema.safeParse(x); if (r.success && actions.length < 3) actions.push(r.data); else dropped++; }
  return { text, actions, dropped };
}

const TTL = 24 * 3_600_000, MAX_PENDING = 10;
export function createProposals(db: DB, actions: Action[], nowMs = Date.now()): { id: string; kind: string; summary: string }[] {
  expireOld(db, nowMs);
  const out: { id: string; kind: string; summary: string }[] = [];
  for (const a0 of actions) {
    if ((db.prepare("SELECT COUNT(*) c FROM proposals WHERE status='pending'").get() as any).c >= MAX_PENDING) break;
    let a: Action = a0;
    if (a0.type === 'complete_task') {   // decide WHICH task now, show its exact title, and remember its id (it must still be that task when you click)
      const hits = db.prepare("SELECT id,title FROM tasks WHERE kind='manual' AND state NOT IN ('completed','canceled') AND is_demo=0 AND lower(title) LIKE ? ESCAPE '\\'").all(`%${a0.title.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c)}%`) as { id: string; title: string }[];
      if (hits.length !== 1) continue;
      a = { type: 'complete_task', title: hits[0].title, taskId: hits[0].id };
    }
    const summary = summarize(a), pid = id();
    db.prepare('INSERT INTO proposals(id,kind,params,summary,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(pid, a.type, JSON.stringify(a), summary, nowMs, nowMs + TTL);
    out.push({ id: pid, kind: a.type, summary });
  }
  if (out.length) publish({ type: 'proposals' });
  return out;
}
export function expireOld(db: DB, nowMs = Date.now()) { db.prepare("UPDATE proposals SET status='expired', decided_at=? WHERE status='pending' AND expires_at<=?").run(nowMs, nowMs); }
export function listPending(db: DB, nowMs = Date.now()) {
  expireOld(db, nowMs);
  return db.prepare("SELECT id,kind,summary,created_at,expires_at FROM proposals WHERE status='pending' ORDER BY created_at").all() as { id: string; kind: string; summary: string; created_at: number; expires_at: number }[];
}
export function dismiss(db: DB, pid: string, nowMs = Date.now()) {
  const r = db.prepare("UPDATE proposals SET status='dismissed', decided_at=? WHERE id=? AND status='pending'").run(nowMs, pid); if (r.changes) publish({ type: 'proposals' }); return r.changes > 0;
}

function execute(db: DB, a: Action, nowMs: number): string {
  switch (a.type) {
    case 'add_task': {
      const dl = a.deadline ? (() => { const [y, m, d] = a.deadline.split('-').map(Number); return chicagoInstant(y, m, d, 17, 0); })() : null;
      createTask(db, { title: clean(a.title), kind: 'manual', minutes: a.minutes ?? 30, priority: a.priority ?? 3, deadline: dl }); return 'Task added.';
    }
    case 'complete_task': {
      const t = a.taskId ? db.prepare("SELECT id,title FROM tasks WHERE id=? AND kind='manual' AND state NOT IN ('completed','canceled')").get(a.taskId) as { id: string; title: string } | undefined : undefined;
      if (!t) throw new Error('That task is no longer open, so nothing was changed.');
      completeTask(db, t.id, 'luke', 'confirmed from a chat proposal'); return `Marked "${t.title}" done.`;
    }
    case 'queue_research': {
      if (isPaused(db)) throw new Error('Jarvis is paused. Resume first, then confirm again.');
      const p = researchInput.safeParse({ question: a.question, urls: a.urls }); if (!p.success) throw new Error('That research request is not valid (question or links).');
      createTask(db, { title: `Research: ${p.data.question.slice(0, 80)}`, kind: 'research', priority: 2, input: p.data }); return 'Research queued. It will ask for approval before visiting any new website.';
    }
    case 'remember': { const r = memory.remember(db, a.content, { source: 'chat proposal (confirmed)' }); if (!r.ok) throw new Error(r.error); return 'Remembered. You can review it on the Memory page.'; }
    case 'add_habit': life.createHabit(db, { name: a.name, perWeek: a.perWeek ?? 7 }); return 'Habit added.';
    case 'log_habit': { const h = life.findHabit(db, a.name); if (!h) throw new Error('I could not match exactly one habit.'); if (h.doneToday) return 'Already checked off today.'; life.toggleHabit(db, h.id, nowMs); return `Checked off "${h.name}".`; }
    case 'add_person': life.createPerson(db, { name: a.name, relationship: a.relationship ?? '', everyDays: a.everyDays ?? null }); return 'Person added.';
    case 'mark_contacted': { const p = life.findPerson(db, a.person); if (!p) throw new Error('I could not match exactly one person.'); life.markContacted(db, p.id, nowMs); return `Noted: in touch with ${p.name} today.`; }
    case 'add_goal': life.createGoal(db, { name: a.name, unit: a.unit ?? 'sessions', perWeek: a.perWeek ?? 3 }); return 'Learning goal added.';
    case 'log_learning': { const g = life.findGoal(db, a.goal); if (!g) throw new Error('I could not match exactly one learning goal.'); life.logLearning(db, g.id, a.amount ?? 1, nowMs); return `Logged toward "${g.name}".`; }
    case 'add_link': addLink(db, { title: a.title, url: a.url }); return 'Link added.';
  }
}

/** Luke clicked Confirm. Runs once (the status flip is atomic), re-validates everything, records the outcome, and never throws to the caller. */
export function confirm(db: DB, pid: string, nowMs = Date.now(), by = 'luke'): { ok: boolean; message: string } {
  expireOld(db, nowMs);
  const row = tx(db, () => {
    const r = db.prepare("SELECT * FROM proposals WHERE id=? AND status='pending'").get(pid) as any; if (!r) return null;
    db.prepare("UPDATE proposals SET status='confirmed', decided_at=? WHERE id=?").run(nowMs, pid); return r;
  });
  if (!row) return { ok: false, message: 'That proposal is no longer pending (already handled or expired).' };
  const parsed = actionSchema.safeParse(JSON.parse(row.params));
  if (!parsed.success) { db.prepare("UPDATE proposals SET status='failed', result=? WHERE id=?").run('invalid', pid); return { ok: false, message: 'That proposal was not valid, so nothing was done.' }; }
  try {
    const message = execute(db, parsed.data, nowMs);
    db.prepare('UPDATE proposals SET result=? WHERE id=?').run(message, pid);
    audit(db, by, 'proposal.confirmed', pid, { kind: row.kind }); publish({ type: 'proposals' }); publish({ type: 'tasks' }); publish({ type: 'life' });
    return { ok: true, message };
  } catch (e) {
    const message = e instanceof z.ZodError ? (e.issues[0]?.message ?? 'invalid') : (e as Error).message;
    db.prepare("UPDATE proposals SET status='failed', result=? WHERE id=?").run(message.slice(0, 300), pid);
    audit(db, by, 'proposal.failed', pid, { kind: row.kind }); publish({ type: 'proposals' });
    return { ok: false, message };
  }
}
