import { z } from 'zod';
import type { DB } from '../db.ts';
import { manifestSchema, type Manifest, type Capability } from './manifest.ts';
import { htmlToText } from '../extract.ts';
import * as memory from '../memory.ts';
import * as knowledge from '../knowledge.ts';
import * as decisions from '../decisions.ts';
import * as usearch from '../search.ts';
import * as src from '../sources.ts';

export type Ctx = { db: DB; principal: string; now: number };
export type Entry = { manifest: Manifest; input?: z.ZodType; run?: (input: any, ctx: Ctx) => unknown | Promise<unknown> };

type Raw = Omit<Partial<Manifest>, 'id' | 'title' | 'purpose' | 'owner' | 'permissions' | 'dataSensitivity' | 'sideEffects' | 'trust' | 'runPath' | 'outputDescription' | 'version'> & Pick<Manifest, 'id' | 'title' | 'purpose' | 'owner' | 'permissions' | 'dataSensitivity' | 'sideEffects' | 'runPath' | 'outputDescription'> & { version?: string; trust?: Manifest['trust'] };
export const define = (r: Raw, input?: z.ZodType, run?: Entry['run']): Entry => ({ manifest: manifestSchema.parse({ version: '1.0.0', trust: 'builtin', ...r }), input, run });

const P = (id: string, title: string, purpose: string, permissions: Capability[], legacyKey: string, extra: Partial<Manifest> = {}) => define({ id, title, purpose, owner: 'jarvis', permissions, dataSensitivity: 'private', sideEffects: 'internal_write', runPath: 'proposal', legacyKey, modelProposable: true, outputDescription: 'A Confirm card; nothing happens until you click it.', tests: ['proposals.test.ts', 'phase3.test.ts'], docs: 'Chat suggestion: the model may propose it; it runs only after your Confirm click (or a standing permission where allowed).', ...extra });
const A = (id: string, title: string, purpose: string, permissions: Capability[], legacyKey: string, sideEffects: Manifest['sideEffects'] = 'internal_write', extra: Partial<Manifest> = {}) => define({ id, title, purpose, owner: 'jarvis', permissions, dataSensitivity: 'private', sideEffects, runPath: 'approval', legacyKey, outputDescription: 'An approval request bound to the exact action.', tests: ['approvals.test.ts', 'phase3.test.ts'], docs: 'Protected action: always needs your explicit approval (and step-up for the decision).', ...extra });

/**
 * THE catalog. Entries for existing features describe them (their behaviour still runs on the existing, tested path: dual-run) and are pinned to the
 * old tables by parity tests, so a new proposal or protected action cannot exist without an entry here. 'direct' entries run through the registry.
 */
export const BUILTIN: Entry[] = [
  P('tasks.add', 'Add a task', 'Add one task to your list.', ['tasks.write'], 'add_task', { standingEligible: true }),
  P('tasks.complete', 'Mark a task done', 'Complete one named task.', ['tasks.write'], 'complete_task'),
  P('research.queue', 'Queue research from pages', 'Queue research on pages you name; new websites still ask you first.', ['research.queue'], 'queue_research', { sideEffects: 'external_read', externalServices: ['approved websites'] }),
  P('memory.remember', 'Remember a fact', 'Save one fact to long-term memory.', ['memory.write'], 'remember'),
  P('life.add_habit', 'Add a habit', 'Create a habit to track.', ['habits.write'], 'add_habit'),
  P('life.log_habit', 'Check off a habit', 'Check off one habit for today.', ['habits.write'], 'log_habit', { standingEligible: true }),
  P('life.add_person', 'Add a person', 'Add someone you want to stay in touch with.', ['people.write'], 'add_person'),
  P('life.mark_contacted', 'Note contact', 'Note that you were in touch with someone today.', ['people.write'], 'mark_contacted', { standingEligible: true }),
  P('life.add_goal', 'Add a learning goal', 'Create a weekly learning goal.', ['goals.write'], 'add_goal'),
  P('life.log_learning', 'Log learning', 'Log progress toward a learning goal.', ['goals.write'], 'log_learning', { standingEligible: true }),
  P('links.add', 'Add a quick link', 'Add a bookmark to your quick links.', ['links.write'], 'add_link'),
  A('domains.allow', 'Allow a website', 'Let research fetch pages from one more website.', ['domains.allow'], 'allow_domain', 'external_read'),
  A('artifacts.publish', 'Publish a draft internally', 'Mark a reviewed draft as published (internal only; sends nothing).', ['artifacts.publish'], 'publish_artifact'),
  A('artifacts.delete', 'Delete a draft permanently', 'Permanently delete a draft and its versions.', ['artifacts.delete'], 'delete_artifact_permanent'),
  A('budget.raise_cap', 'Raise the monthly cap', 'Raise the monthly spending cap.', ['budget.raise'], 'budget_increase'),
  A('budget.raise_daily', 'Raise the daily ceiling', 'Raise the daily model-spend ceiling.', ['budget.raise'], 'raise_daily_ceiling'),
  A('messages.send', 'Send a message', 'Send a text or email. Not connected: nothing can be sent.', ['messages.send'], 'send_message', 'external_write', { docs: 'Permanently unavailable until a messaging policy is designed and approved (open questions F8–F16).' }),
  A('finance.trade_or_transfer', 'Trade or transfer money', 'Trade or transfer funds. Not connected; permanently unavailable in this build.', ['money.move'], 'trade_or_transfer', 'money', { docs: 'Requires its own approved trading policy, a human security review and a separate control system.' }),
  define({ id: 'research.deep', title: 'Prometheus deep research', purpose: 'Multi-angle web research with cited evidence, cross-checking and a reviewable report.', owner: 'prometheus', permissions: ['web.search', 'catalog.read', 'catalog.write'], dataSensitivity: 'public', sideEffects: 'external_read', untrustedOutput: true, externalServices: ['Anthropic web search'], cost: { perCallMicroUsd: 0, note: 'About $0.01 per search plus model use, capped per job ($2 default)' }, runPath: 'job', outputDescription: 'A draft report in Ready for Review plus evidence rows.', tests: ['research2.test.ts'], docs: 'docs/STATUS.md, Phase 2' }),
  define({ id: 'research.web_answer', title: 'Ask the web', purpose: 'Answer one question from the internet with sources; walled off from private data.', owner: 'jarvis', permissions: ['web.search'], dataSensitivity: 'public', sideEffects: 'external_read', untrustedOutput: true, externalServices: ['Anthropic web search'], cost: { perCallMicroUsd: 10_000, note: '$0.01 per search plus model use' }, runPath: 'turn', outputDescription: 'A short unverified answer with sources.', tests: ['websearch.test.ts'], docs: 'Start a message with "search:"' }),
  define({ id: 'research.fetch_pages', title: 'Read approved pages', purpose: 'Fetch pages from websites you approved, honouring robots.txt and rate limits, and summarise with citations.', owner: 'prometheus', permissions: ['web.fetch'], dataSensitivity: 'public', sideEffects: 'external_read', untrustedOutput: true, externalServices: ['approved websites'], runPath: 'job', outputDescription: 'A cited draft in Ready for Review.', tests: ['research.test.ts', 'research2.test.ts'], docs: '"research <question> from <https url>"' }),
];

const none = z.object({}).strict();
/** New skills that run through the registry's own invoke (read-only or pure). */
export const DIRECT: Entry[] = [
  define({ id: 'research.catalog_lookup', title: 'Look up sources', purpose: 'Find catalog sources by status or topic (names and your own notes only).', owner: 'prometheus', permissions: ['catalog.read'], dataSensitivity: 'public', sideEffects: 'none', runPath: 'direct', autoShare: true, outputDescription: 'Up to 30 catalog rows.', tests: ['phase3.test.ts', 'research2.test.ts'] },
    z.object({ status: z.enum(['suggested', 'trusted', 'watch', 'blocked']).optional(), topic: z.string().max(40).optional() }).strict(),
    (i, c) => src.list(c.db).filter((s) => (!i.status || s.status === i.status) && (!i.topic || s.topics.includes(String(i.topic).toLowerCase()))).slice(0, 30).map((s) => ({ host: s.host, class: s.class, status: s.status, reliability: s.reliability, topics: s.topics, note: s.terms_note }))),
  define({ id: 'docs.extract_text', title: 'Extract text from HTML', purpose: 'Turn an HTML string into readable text. Pure: no network, no files.', owner: 'jarvis', permissions: ['docs.process'], dataSensitivity: 'public', sideEffects: 'none', runPath: 'direct', autoShare: true, outputDescription: 'Title and plain text (≤ 20,000 characters).', tests: ['phase3.test.ts'] },
    z.object({ html: z.string().max(400_000) }).strict(), (i) => { const r = htmlToText(i.html); return { title: r.title.slice(0, 200), text: r.text.slice(0, 20_000) }; }),
  define({ id: 'memory.search', title: 'Search memory', purpose: 'Search your stored memories (private data; Jarvis only).', owner: 'jarvis', permissions: ['memory.read'], dataSensitivity: 'private', sideEffects: 'none', runPath: 'direct', outputDescription: 'Up to 10 memory snippets.', tests: ['phase3.test.ts'] },
    z.object({ query: z.string().min(2).max(100) }).strict(), (i, c) => (memory.search(c.db, i.query) as { id: string; content: string }[]).slice(0, 10).map((m) => ({ id: m.id, content: m.content.slice(0, 300) }))),
  define({ id: 'search.everything', title: 'Search everything', purpose: 'Search your memory, tasks, notes, calendar, research, decisions, missions, reports and conversations by words (private data; Jarvis only; imported chats are never included).', owner: 'jarvis', permissions: ['search.read'], dataSensitivity: 'private', sideEffects: 'none', runPath: 'direct', outputDescription: 'Up to 24 matches with where each came from.', tests: ['search.test.ts'] },
    z.object({ query: z.string().min(2).max(120) }).strict(), (i, c) => usearch.search(c.db, i.query, { perKind: 3 }).groups.flatMap((g) => g.items.slice(0, 3).map((h) => ({ source: g.label, title: h.title.slice(0, 120), snippet: h.snippet.slice(0, 200), link: h.link }))).slice(0, 24)),
  define({ id: 'knowledge.lookup', title: 'What do we know about…', purpose: 'Look up a person, project, topic or decision in your knowledge graph (private data; Jarvis only).', owner: 'jarvis', permissions: ['knowledge.read'], dataSensitivity: 'private', sideEffects: 'none', runPath: 'direct', outputDescription: 'A short plain-text summary.', tests: ['phase5.test.ts'] },
    z.object({ query: z.string().min(2).max(80) }).strict(), (i, c) => ({ summary: knowledge.describe(c.db, i.query).slice(0, 4000) })),
  define({ id: 'decisions.due', title: 'Decisions due for review', purpose: 'Decisions you made whose expected date has passed (private data; Jarvis only).', owner: 'jarvis', permissions: ['knowledge.read'], dataSensitivity: 'private', sideEffects: 'none', runPath: 'direct', outputDescription: 'Up to 10 decision titles.', tests: ['phase5.test.ts'] }, none,
    (_i, c) => decisions.due(c.db, c.now).slice(0, 10).map((d: any) => ({ id: d.id, title: d.title, expectedBy: d.expected_by }))),
  define({ id: 'tasks.list_open', title: 'List open tasks', purpose: 'Titles and priorities of your open tasks (private data; Jarvis only).', owner: 'jarvis', permissions: ['tasks.read'], dataSensitivity: 'private', sideEffects: 'none', runPath: 'direct', outputDescription: 'Up to 25 task titles.', tests: ['phase3.test.ts'] }, none,
    (_i, c) => c.db.prepare("SELECT title, priority FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state NOT IN ('completed','canceled') ORDER BY priority, created_at LIMIT 25").all()),
];
export const ALL_BUILTIN: Entry[] = [...BUILTIN, ...DIRECT];
