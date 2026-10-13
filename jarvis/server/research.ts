import { z } from 'zod';
import type { DB } from './db.ts';
import { audit } from './audit.ts';
import { authorizeTool } from './policy.ts';
import { isHostAllowed } from './policy.ts';
import { fetchSource, type FetchOpts } from './fetch.ts';
import { htmlToText, topSentences } from './extract.ts';
import { addVersion, createArtifact, type Source } from './artifacts.ts';
import { requestApproval } from './approvals.ts';
import { setState, logEvent, completeTask, type TaskRow } from './tasks.ts';
import { summarizeResearch, reviseWithModel, type SourceForModel } from './synth.ts';

export const researchInput = z.object({ question: z.string().min(3).max(500), urls: z.array(z.string().url().max(2048)).min(1).max(8) });

// Text in a fetched page that tries to instruct the agent. It is never obeyed; we only flag it for Luke.
const INJECTION_RE = /(ignore (all |any |the )?(previous|prior|above) (instructions|rules)|disregard (your|the) (rules|instructions|polic)|reveal .{0,40}(api key|password|secret|token|credential)|send .{0,40}(api key|password|secret|token)|disable .{0,30}(approval|polic|safety)|you are now|system prompt|add .{0,30}(to the )?allow-?list)/i;

export type Deps = { fetchOpts?: Partial<FetchOpts>; allowInsecureHttp?: boolean };

/** Run a research task with the extractive provider (no language model). Returns after saving a reviewable draft or parking the task. */
export async function runResearch(db: DB, task: TaskRow, deps: Deps = {}): Promise<void> {
  const input = researchInput.parse(JSON.parse(task.input));
  const sources: Source[] = [], notes: string[] = [], blocks: string[] = [], forModel: SourceForModel[] = [];
  for (const url of input.urls) {
    const auth = authorizeTool(db, { taskKind: 'research', allowInsecureHttp: deps.allowInsecureHttp }, 'fetch_source', { url });
    if (!auth.ok) {
      if (auth.needsApproval) {
        const existing = db.prepare("SELECT id FROM approvals WHERE action_type='allow_domain' AND status IN ('pending','approved') AND task_id=? AND payload=?")
          .get(task.id, JSON.stringify(auth.needsApproval.payload)) as { id: string } | undefined;
        const aid = existing?.id ?? requestApproval(db, { ...auth.needsApproval, requestedBy: 'jarvis', taskId: task.id });
        setState(db, task.id, 'waiting_approval', { reason: `approval:${aid}` });
        return;
      }
      notes.push(`Skipped ${url}: ${auth.reason}`); logEvent(db, task.id, 'tool_denied', auth.reason); continue;
    }
    try {
      const f = await fetchSource(auth.args.url, { isHostAllowed: (h) => isHostAllowed(db, h), ...deps.fetchOpts });
      const { title, text } = f.contentType.includes('html') ? htmlToText(f.body) : { title: '', text: f.body };
      const flagged = INJECTION_RE.test(text);
      if (flagged) { audit(db, 'system', 'research.untrusted_instruction_ignored', task.id, { url }); }
      const picks = topSentences(text, input.question);
      sources.push({ url, finalUrl: f.finalUrl, title: title || url, retrievedAt: f.retrievedAt, sha256: f.sha256, flagged });
      const n = sources.length;
      if (!flagged) forModel.push({ n, title: title || url, passages: picks });   // a page that tried to instruct an AI is never shown to the model
      blocks.push(`### [${n}] ${title || url}\n${picks.length ? picks.map((p) => `> ${p.replace(/\n/g, ' ')}`).join('\n>\n') : '_No passages matched the question._'}\n\n` +
        `Source: ${f.finalUrl} · retrieved ${f.retrievedAt} · sha256 ${f.sha256.slice(0, 16)}…` +
        (flagged ? '\n\n⚠ This page contained text that reads like instructions to an AI agent. It was treated as data only and had no effect.' : ''));
    } catch (e) { notes.push(`Could not retrieve ${url}: ${(e as Error).message}`); logEvent(db, task.id, 'fetch_failed', `${url}: ${(e as Error).message}`); }
  }
  setState(db, task.id, 'verifying');
  if (!sources.length) throw new Error(`No sources could be retrieved. ${notes.join(' ')}`);
  const sum = await summarizeResearch(db, { question: input.question, sources: forModel, taskId: task.id });
  if (!sum.ok) logEvent(db, task.id, 'summary_skipped', sum.reason);
  const flaggedCount = sources.filter((x) => x.flagged).length;
  const method = sum.ok
    ? `> **Method:** the quoted passages below are verbatim from the sources, ranked by keyword overlap with the question. The **Summary** was written by a language model (${sum.model}, about $${(sum.costMicroUsd / 1e6).toFixed(4)}) from those passages only, and every claim should carry a [number] pointing at a source. Check it against the quotes before relying on it.${flaggedCount ? ` ${flaggedCount} page(s) that contained instruction-like text were kept out of what the model saw.` : ''}`
    : `> **Method:** extractive. Passages are quoted verbatim from the sources below, ranked by keyword overlap with the question. ${sum.reason}`;
  const report = [
    `# ${input.question}`, '', method, '',
    ...(sum.ok ? ['## Summary', '', sum.text, '', ...(sum.notes.length ? [`_Checks applied: ${sum.notes.join('; ')}._`, ''] : [])] : []),
    '## Quoted findings', '', blocks.join('\n\n'), '',
    ...(notes.length ? ['## Not retrieved', '', ...notes.map((n) => `- ${n}`), ''] : []),
    '## Sources', '', ...sources.map((s, i) => `${i + 1}. ${s.title} — ${s.finalUrl}`),
  ].join('\n');
  const aid = createArtifact(db, { taskId: task.id, projectId: task.project_id, title: `Research: ${input.question.slice(0, 80)}`, content: report, sources, createdBy: 'jarvis-worker', isDemo: !!task.is_demo });
  setState(db, task.id, 'waiting_input', { reason: `Draft ready for review (artifact ${aid})` });
}

/** Revision with the extractive provider: supports deterministic edits only, and says so when it cannot do what was asked. */
export async function runRevision(db: DB, task: TaskRow): Promise<void> {
  const input = JSON.parse(task.input) as { artifactId: string; baseVersion: number; anchor: string; instruction: string };
  const art = db.prepare('SELECT * FROM artifacts WHERE id=?').get(input.artifactId) as any;
  if (!art) throw new Error('artifact missing');
  if (art.current_version !== input.baseVersion) { setState(db, task.id, 'waiting_input', { reason: 'The document changed since this request; re-submit against the latest version.' }); return; }
  const base = db.prepare('SELECT content FROM artifact_versions WHERE artifact_id=? AND version=?').get(input.artifactId, input.baseVersion) as { content: string };
  const ins = input.instruction.trim();
  let out: string | null = null;
  if (/^remove\b/i.test(ins) && input.anchor && base.content.includes(input.anchor)) out = base.content.replace(input.anchor, '').replace(/\n{3,}/g, '\n\n');
  else if (/^replace(?: with)?:/i.test(ins) && input.anchor && base.content.includes(input.anchor)) out = base.content.replace(input.anchor, ins.replace(/^replace(?: with)?:\s*/i, '').trim());
  else if (/^note:/i.test(ins)) {
    const note = `\n\n> **Note (Luke):** ${ins.replace(/^note:\s*/i, '').trim()}`;
    out = input.anchor && base.content.includes(input.anchor) ? base.content.replace(input.anchor, input.anchor + note) : base.content + note;
  }
  let note = `revision: ${ins.slice(0, 120)}`;
  if (out === null) {   // not a simple command: ask the model, with safeguards on what it may change
    const r = await reviseWithModel(db, { content: base.content, anchor: input.anchor, instruction: ins, taskId: task.id });
    if (r.ok) { out = r.content; note = `revision (${r.model}): ${ins.slice(0, 100)}`; }
    else { setState(db, task.id, 'waiting_input', { reason: `${r.reason} Without a model I can only: "remove" the highlighted passage, "replace: <your text>", or "note: <your text>". The highlighted text must match exactly.` }); return; }
  }
  if (out === base.content) { setState(db, task.id, 'waiting_input', { reason: 'That would not change the document.' }); return; }
  const v = addVersion(db, input.artifactId, { content: out, createdBy: 'jarvis-worker', note, basedOn: input.baseVersion });
  db.prepare("UPDATE review_requests SET status='done' WHERE id=?").run((input as any).requestId ?? '');
  completeTask(db, task.id, 'jarvis-worker', `produced v${v} for review`);
}
