import { createHash } from 'node:crypto';
import { pool, tx, type Db } from '../db/pool.js';
import { HttpError, canSeeContact, visibilitySql, type Actor } from './authz.js';
import { enqueue } from './queue.js';
import { publish } from './events.js';
import { getSummaryProvider, type Evidence, type SummaryMsg } from '../providers/summarizer.js';

export const CHUNK_SIZE = 40;

/** Customer-visible history for a contact (including contacts merged into it), oldest first. Suppressed/failed/redacted messages never reached the customer. */
export async function loadHistory(db: Db, contactId: string): Promise<SummaryMsg[]> {
  return (await db.query(
    `SELECT m.id, m.conversation_id, m.direction, m.sender_type, m.body, m.created_at, m.seq
     FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN contacts ct ON ct.id=c.contact_id
     WHERE (ct.id=$1 OR ct.merged_into=$1) AND m.redacted_at IS NULL AND m.status NOT IN ('suppressed','failed')
     ORDER BY m.created_at, m.seq`, [contactId])).rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}

const hashChunk = (msgs: SummaryMsg[]) => createHash('sha256').update(msgs.map((m) => `${m.id}|${m.created_at}|${m.direction}|${m.body}`).join('\n')).digest('hex');

/** Called inside messaging transactions. Uses a savepoint so a failure here can never break message delivery. */
export async function touchSummary(c: import('pg').PoolClient, workspaceId: string, contactId: string) {
  await c.query('SAVEPOINT touch_summary');
  try {
    await c.query(`INSERT INTO summary_state (contact_id, workspace_id, status) VALUES ($1,$2,'stale') ON CONFLICT (contact_id) DO UPDATE SET status=CASE WHEN summary_state.status='failed' THEN 'failed' ELSE 'stale' END, updated_at=now()`, [contactId, workspaceId]);
    await enqueue(c, 'summarize_contact', { contactId }, { workspaceId, dedupeKey: contactId });
    await c.query('RELEASE SAVEPOINT touch_summary');
  } catch {
    await c.query('ROLLBACK TO SAVEPOINT touch_summary');
  }
}

export const stats = { providerCalls: 0 };

/** Build/refresh the summary. Incremental by default (unchanged chunks reuse cached evidence); force=true rebuilds from scratch. */
export async function buildSummary(contactId: string, opts: { force?: boolean } = {}): Promise<{ status: string; processedChunks: number; reusedChunks: number; error?: string }> {
  const ct = (await pool.query('SELECT workspace_id FROM contacts WHERE id=$1', [contactId])).rows[0];
  if (!ct) throw new HttpError(404, 'contact not found');
  const ws = ct.workspace_id as string;
  const provider = getSummaryProvider();
  const history = await loadHistory(pool, contactId);
  if (opts.force) await pool.query('DELETE FROM summary_chunks WHERE contact_id=$1', [contactId]);
  const cached = new Map((await pool.query('SELECT * FROM summary_chunks WHERE contact_id=$1', [contactId])).rows.map((r) => [r.chunk_index as number, r]));

  const chunks: SummaryMsg[][] = [];
  for (let i = 0; i < history.length; i += CHUNK_SIZE) chunks.push(history.slice(i, i + CHUNK_SIZE));
  const evidence: Evidence[] = []; let processed = 0, reused = 0, covered = 0; let error: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    const h = hashChunk(chunks[i]); const hit = cached.get(i);
    if (hit && hit.content_hash === h && hit.provider === provider.key && hit.extractor_version === provider.version) {
      evidence.push(...hit.evidence); reused++; covered += chunks[i].length; continue;
    }
    try {
      stats.providerCalls++;
      const out = await provider.extractChunk(chunks[i]);
      // Citations must point at messages inside this chunk; anything else is discarded (never trust extractor output blindly).
      const ids = new Set(chunks[i].map((m) => m.id));
      const valid = out.evidence.filter((e) => ids.has(e.messageId));
      await pool.query(`INSERT INTO ai_usage (workspace_id, provider, model, purpose, input_tokens, output_tokens, cost_usd, ref_id) VALUES ($1,$2,$3,'summary_chunk',$4,$5,$6,$7)`, [ws, provider.key, provider.model, out.usage.inputTokens, out.usage.outputTokens, out.usage.costUsd, `${contactId}:${i}`]);
      await pool.query(
        `INSERT INTO summary_chunks (contact_id, chunk_index, workspace_id, first_message_id, last_message_id, msg_count, content_hash, provider, extractor_version, evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (contact_id, chunk_index) DO UPDATE SET first_message_id=EXCLUDED.first_message_id, last_message_id=EXCLUDED.last_message_id, msg_count=EXCLUDED.msg_count, content_hash=EXCLUDED.content_hash, provider=EXCLUDED.provider, extractor_version=EXCLUDED.extractor_version, evidence=EXCLUDED.evidence, created_at=now()`,
        [contactId, i, ws, chunks[i][0].id, chunks[i].at(-1)!.id, chunks[i].length, h, provider.key, provider.version, JSON.stringify(valid)]);
      evidence.push(...valid); processed++; covered += chunks[i].length;
    } catch (e) { error = (e as Error).message; break; }   // stop at first failure; what we have is a contiguous prefix
  }
  await pool.query('DELETE FROM summary_chunks WHERE contact_id=$1 AND chunk_index >= $2', [contactId, chunks.length]);

  if (error && covered === 0) {   // nothing usable: keep the previous summary, flag it
    await pool.query(`INSERT INTO summary_state (contact_id, workspace_id, status, last_error) VALUES ($1,$2,'failed',$3) ON CONFLICT (contact_id) DO UPDATE SET status='failed', last_error=EXCLUDED.last_error, updated_at=now()`, [contactId, ws, error]);
    await publish(pool, ws, 'summary.updated', { contactId });
    return { status: 'failed', processedChunks: processed, reusedChunks: reused, error };
  }
  const covMsgs = history.slice(0, covered);
  const complete = !error && covered === history.length;
  const status = history.length === 0 ? 'complete' : complete ? 'complete' : 'partial';
  await saveVersion(ws, contactId, provider, status, covMsgs, history.length, chunks.length, processed, reused, evidence, error);
  return { status, processedChunks: processed, reusedChunks: reused, error };
}

async function saveVersion(ws: string, contactId: string, provider: { key: string; model: string; version: string }, status: string, covMsgs: SummaryMsg[], totalMsgs: number, chunkCount: number, processed: number, reused: number, evidence: Evidence[], error?: string) {
  const { facts } = reconcile(evidence, covMsgs);
  await tx(async (c) => {
    const v = ((await c.query('SELECT max(version) v FROM conversation_summaries WHERE contact_id=$1', [contactId])).rows[0].v ?? 0) + 1;
    const channels = (await c.query(`SELECT DISTINCT ch.kind FROM conversations cv JOIN channels ch ON ch.id=cv.channel_id JOIN contacts ct ON ct.id=cv.contact_id WHERE ct.id=$1 OR ct.merged_into=$1`, [contactId])).rows.map((r) => r.kind);
    const conversationIds = [...new Set(covMsgs.map((m) => m.conversation_id))];
    const coverage = {
      historyStart: covMsgs[0]?.created_at ?? null, historyEnd: covMsgs.at(-1)?.created_at ?? null,
      lastProcessedMessageId: covMsgs.at(-1)?.id ?? null, messagesCovered: covMsgs.length, messagesTotal: totalMsgs,
      chunks: chunkCount, chunksProcessed: processed, chunksReused: reused, channels, conversationIds, error: error ?? null,
    };
    const s = (await c.query(`INSERT INTO conversation_summaries (workspace_id, contact_id, version, status, coverage, provider, model, extractor_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ws, contactId, v, status, JSON.stringify(coverage), provider.key, provider.model, provider.version])).rows[0].id;
    const idMap = new Map<number, string>();
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
      const r = await c.query(`INSERT INTO summary_facts (summary_id, field, value, status, origin, stated_at, message_ids, conversation_ids, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [s, f.field, f.value, f.status, f.origin, f.statedAt, f.messageIds, f.conversationIds, f.note ?? null]);
      idMap.set(i, r.rows[0].id);
    }
    for (let i = 0; i < facts.length; i++) if (facts[i].supersededByIndex !== undefined) await c.query('UPDATE summary_facts SET superseded_by=$2 WHERE id=$1', [idMap.get(i), idMap.get(facts[i].supersededByIndex!)]);
    await c.query(`INSERT INTO summary_state (contact_id, workspace_id, status, last_error, current_version) VALUES ($1,$2,$3,$4,$5)
                   ON CONFLICT (contact_id) DO UPDATE SET status=EXCLUDED.status, last_error=EXCLUDED.last_error, current_version=EXCLUDED.current_version, updated_at=now()`, [contactId, ws, status, error ?? null, v]);
    await publish(c, ws, 'summary.updated', { contactId });
  });
}

interface Fact { field: string; value: string; status: 'current' | 'superseded'; origin: 'customer_stated' | 'staff_stated' | 'derived'; statedAt: string | null; messageIds: string[]; conversationIds: string[]; note?: string; supersededByIndex?: number }

/**
 * Deterministic reconciliation of per-chunk evidence into the summary. No model involved, so it cannot invent anything:
 * single-valued fields (budget) keep the latest value as current and mark earlier different values superseded (change of mind);
 * multi-valued fields dedupe; questions are 'unanswered' only if no staff message followed; derived fields cite the messages they come from.
 */
export function reconcile(evidence: Evidence[], history: SummaryMsg[]): { facts: Fact[] } {
  const convOf = new Map(history.map((m) => [m.id, m.conversation_id]));
  const byTime = [...evidence].sort((a, b) => a.at.localeCompare(b.at));
  const facts: Fact[] = [];
  const mk = (e: Evidence, extra: Partial<Fact> = {}): Fact => ({ field: e.field, value: e.value, status: 'current', origin: e.origin, statedAt: e.at, messageIds: [e.messageId], conversationIds: [convOf.get(e.messageId)!].filter(Boolean), ...extra });

  // budget: single-valued. The latest statement is current; earlier ones are superseded (change of mind) or marked repeated.
  const budgets = byTime.filter((e) => e.field === 'budget');
  if (budgets.length) {
    const first = facts.length;
    const finalIdx = first + budgets.length - 1;
    budgets.forEach((e, i) => {
      const f = mk(e);
      if (i < budgets.length - 1) {
        f.status = 'superseded'; f.supersededByIndex = finalIdx;
        f.note = e.normalized !== budgets[budgets.length - 1].normalized ? 'Superseded: customer later stated a different budget' : 'Repeated; latest statement is shown';
      }
      facts.push(f);
    });
  }

  // multi-valued, deduplicated
  for (const field of ['boat', 'trade', 'date', 'decision', 'promise', 'preference']) {
    const seen = new Map<string, Fact>();
    for (const e of byTime.filter((x) => x.field === field)) {
      const key = (e.normalized ?? e.value).toString().toLowerCase();
      const ex = seen.get(key);
      if (ex) { ex.messageIds.push(e.messageId); const cv = convOf.get(e.messageId); if (cv && !ex.conversationIds.includes(cv)) ex.conversationIds.push(cv); }
      else { const f = mk(e); seen.set(key, f); facts.push(f); }
    }
  }
  // questions: unanswered only if no outbound (staff/sandra/automation) message came after
  const lastOutbound = [...history].reverse().find((m) => m.direction === 'outbound')?.created_at ?? '';
  for (const e of byTime.filter((x) => x.field === 'question')) {
    const answered = lastOutbound > e.at;
    facts.push(mk(e, { field: answered ? 'question_answered' : 'question_unanswered', note: answered ? 'A staff message followed (the reply may not address this question)' : 'No staff message has followed' }));
  }
  // goal: earliest customer statement of intent
  const goal = byTime.find((e) => e.field === 'goal');
  if (goal) facts.push(mk(goal, { note: 'Earliest customer message stating an intent' }));

  // derived state from the most recent messages
  const last = history.at(-1);
  if (last) {
    const lastIn = [...history].reverse().find((m) => m.direction === 'inbound');
    const owes = last.direction === 'inbound' ? 'Sun Sport Marine (customer wrote last)' : 'Customer (we wrote last)';
    facts.push({ field: 'owes_next', value: owes, status: 'current', origin: 'derived', statedAt: last.created_at, messageIds: [last.id], conversationIds: [last.conversation_id], note: 'Derived from who sent the latest message, not from conversation tags' });
    facts.push({ field: 'current_situation', value: `${history.length} messages from ${history[0].created_at.slice(0, 10)} to ${last.created_at.slice(0, 10)}. Latest message (${last.direction}): “${last.body.slice(0, 140)}”`, status: 'current', origin: 'derived', statedAt: last.created_at, messageIds: [last.id], conversationIds: [last.conversation_id] });
    if (last.direction === 'inbound' && lastIn) facts.push({ field: 'next_action', value: `Reply to the customer's latest message: “${lastIn.body.slice(0, 120)}”`, status: 'current', origin: 'derived', statedAt: lastIn.created_at, messageIds: [lastIn.id], conversationIds: [lastIn.conversation_id] });
    else {
      const open = facts.filter((f) => f.field === 'promise');
      if (open.length) facts.push({ field: 'next_action', value: `Follow through on staff promise: “${open[open.length - 1].value.slice(0, 120)}” (completion not verified)`, status: 'current', origin: 'derived', statedAt: open[open.length - 1].statedAt, messageIds: open[open.length - 1].messageIds, conversationIds: open[open.length - 1].conversationIds });
      else facts.push({ field: 'next_action', value: 'Waiting for the customer to reply.', status: 'current', origin: 'derived', statedAt: last.created_at, messageIds: [last.id], conversationIds: [last.conversation_id] });
    }
  }
  return { facts };
}

// ---------- permission-scoped retrieval ----------
/** Honest coverage disclosure for imported customers: what the summary can and cannot have seen. */
async function importNote(contactId: string): Promise<string | null> {
  const m = (await pool.query(`SELECT count(*)::int n, min(m.created_at) a, max(m.created_at) b FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.contact_id=$1 AND m.imported_batch_id IS NOT NULL`, [contactId])).rows[0];
  if (m.n > 0) return `Includes ${m.n} imported message${m.n === 1 ? '' : 's'} dated ${new Date(m.a).toISOString().slice(0, 10)} to ${new Date(m.b).toISOString().slice(0, 10)}. Anything said outside the imported export (other channels, calls, media) is not covered.`;
  const c = (await pool.query('SELECT import_batch_id FROM contacts WHERE id=$1', [contactId])).rows[0];
  return c?.import_batch_id ? 'This customer came from an imported contact list. Their earlier text history was not imported, so this summary covers only messages since Relay began handling them.' : null;
}

export async function getSummary(a: Actor, contactId: string) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  const importCoverage = await importNote(contactId);
  const st = (await pool.query('SELECT * FROM summary_state WHERE contact_id=$1', [contactId])).rows[0];
  if (!st || !st.current_version) return { importCoverage, status: st?.status ?? 'none', lastError: st?.last_error ?? null, coverage: null, fields: {} as Record<string, any[]>, version: null, provider: null, restricted: false };
  const sum = (await pool.query('SELECT * FROM conversation_summaries WHERE contact_id=$1 AND version=$2', [contactId, st.current_version])).rows[0];
  const v = visibilitySql(a, 'c', 2);
  const visible = new Set((await pool.query(`SELECT c.id FROM conversations c JOIN contacts ct ON ct.id=c.contact_id WHERE (ct.id=$1 OR ct.merged_into=$1) AND ${v.sql}`, [contactId, ...v.params])).rows.map((r) => r.id as string));
  const all = (await pool.query('SELECT * FROM summary_facts WHERE summary_id=$1 ORDER BY stated_at NULLS LAST', [sum.id])).rows;
  // A fact is shown only if EVERY conversation it cites is visible to the viewer.
  const shown = all.filter((f) => f.conversation_ids.every((id: string) => visible.has(id)));
  const msgIds = [...new Set(shown.flatMap((f) => f.message_ids as string[]))];
  const msgs = new Map((await pool.query('SELECT id, seq, direction, body, created_at FROM messages WHERE id = ANY($1::uuid[]) AND redacted_at IS NULL', [msgIds])).rows.map((m) => [m.id, m]));
  const fields: Record<string, any[]> = {};
  for (const f of shown) (fields[f.field] ??= []).push({ id: f.id, value: f.value, status: f.status, origin: f.origin, note: f.note, statedAt: f.stated_at, supersededBy: f.superseded_by,
    citations: (f.message_ids as string[]).map((id) => msgs.get(id)).filter(Boolean).map((m: any) => ({ messageId: m.id, direction: m.direction, at: m.created_at, snippet: m.body.slice(0, 160) })) });
  const hidden = (sum.coverage.conversationIds as string[]).filter((id) => !visible.has(id)).length;
  const cov = { ...sum.coverage, conversationIds: undefined, conversationsCovered: (sum.coverage.conversationIds as string[]).length - hidden };
  return { importCoverage, status: st.status, lastError: st.last_error, coverage: cov, fields, version: sum.version, provider: { key: sum.provider, model: sum.model, label: sum.provider === 'heuristic' ? 'Rule-based extractor (no AI model)' : sum.provider }, createdAt: sum.created_at,
    restricted: hidden > 0, restrictedNote: hidden > 0 ? `${hidden} linked conversation(s) are not accessible to you; facts that cite them are hidden.` : null };
}

export async function requestRebuild(a: Actor, contactId: string, force: boolean) {
  if (!(await canSeeContact(pool, a, contactId))) throw new HttpError(404, 'contact not found');
  await pool.query(`INSERT INTO summary_state (contact_id, workspace_id, status) VALUES ($1,$2,'stale') ON CONFLICT (contact_id) DO UPDATE SET status=CASE WHEN summary_state.status='failed' THEN 'failed' ELSE 'stale' END`, [contactId, a.workspaceId]);
  await enqueue(pool, 'summarize_contact', { contactId, force }, { workspaceId: a.workspaceId, dedupeKey: contactId });
}

/** Soft-delete a message from history (privacy/edit). Summaries notice via changed chunk hashes. */
export async function redactMessage(a: Actor, messageId: string) {
  const m = (await pool.query(`SELECT m.conversation_id, c.contact_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=$1 AND m.workspace_id=$2`, [messageId, a.workspaceId])).rows[0];
  if (!m) throw new HttpError(404, 'message not found');
  if (a.role !== 'owner' && a.role !== 'admin') throw new HttpError(403, 'admin required');
  await tx(async (c) => { await c.query(`UPDATE messages SET redacted_at=now(), body='' WHERE id=$1`, [messageId]); await touchSummary(c, a.workspaceId, m.contact_id); });
}
