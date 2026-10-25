import { useMemo, useRef, useState } from 'react';
import { api, ago, usd, useLive, type AppState } from './api.ts';
import { PersonaCard, ModelsCard } from './ai.tsx';
import { ProjectsPanel } from './projects.tsx';
import { MemorySuggestions } from './memsug.tsx';
import { PasskeyCard, BackupCard, HealthCard, DevicesCard, StandingCard, WebSearchCard } from './passkeycard.tsx';
import { BreakdownBox } from './goals.tsx';
import { passkeySupported, stepUpWithPasskey } from './passkey.ts';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function useAction() {
  const [err, setErr] = useState('');
  const run = async (f: () => Promise<unknown>) => { try { setErr(''); await f(); } catch (e) { setErr(errMsg(e)); } };
  return { err, run, clear: () => setErr('') };
}
const Err = ({ m }: { m: string }) => (m ? <p className="err" role="alert">{m}</p> : null);

export function PlannedPage({ title, text }: { title: string; text: string }) {
  return <section className="page"><h1>{title} <span className="badge planned">Planned</span></h1><div className="glass pad"><p>{text}</p><p className="muted">Nothing on this page is live. It is listed so the roadmap stays visible; see docs/STATUS.md.</p></div></section>;
}

// ---------------- Tasks ----------------
export function TasksPage() {
  const { data: tasks, reload } = useLive<any[]>(() => api('/api/tasks'), ['tasks']);
  const { data: projects } = useLive<any[]>(() => api('/api/projects'), ['projects']);
  const [taskProj, setTaskProj] = useState(''), [taskMs, setTaskMs] = useState(''), [title, setTitle] = useState(''), [mins, setMins] = useState('30'), [due, setDue] = useState(''), [q, setQ] = useState(''), [urls, setUrls] = useState(''), [open, setOpen] = useState<string | null>(null);
  const { data: pdet } = useLive<any>(() => (taskProj ? api(`/api/projects/${taskProj}`) : Promise.resolve(null)), ['projects'], [taskProj]);
  const [events, setEvents] = useState<any[]>([]), [bdTask, setBdTask] = useState<any>(null);
  const a = useAction();
  const groups = useMemo(() => {
    const g: Record<string, any[]> = { 'Needs you': [], 'In progress': [], Done: [] };
    for (const t of tasks ?? []) {
      if (['completed', 'canceled'].includes(t.state)) g.Done.push(t);
      else if (['waiting_input', 'waiting_approval', 'failed'].includes(t.state) || t.kind === 'manual') g['Needs you'].push(t);
      else g['In progress'].push(t);
    }
    return g;
  }, [tasks]);
  return (
    <section className="page">
      <h1>Tasks &amp; Projects</h1>
      <Err m={a.err} />
      <div className="grid2">
        <form className="glass pad" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/tasks', 'POST', { title, minutes: Number(mins) || 30, deadline: due ? new Date(due).getTime() : null, projectId: taskProj || null, milestoneId: taskMs || null }); setTitle(''); setDue(''); reload(); }); }}>
          <h2>New task</h2>
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
          <div className="row"><label className="grow">Minutes<input type="number" min={5} max={480} step={5} value={mins} onChange={(e) => setMins(e.target.value)} /></label>
            <label className="grow">Deadline (your local time, optional)<input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label></div>
          <div className="row"><label className="grow">Project (optional)<select value={taskProj} onChange={(e) => { setTaskProj(e.target.value); setTaskMs(''); }}><option value="">None</option>{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
            <label className="grow">Milestone<select value={taskMs} disabled={!taskProj} onChange={(e) => setTaskMs(e.target.value)}><option value="">None</option>{(pdet?.milestones ?? []).filter((m: any) => m.state === 'open').map((m: any) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label></div>
          <button className="primary" disabled={!title.trim()}>Add task</button>
        </form>
        <form className="glass pad" onSubmit={(e) => { e.preventDefault(); void a.run(async () => {
          await api('/api/tasks', 'POST', { title: `Research: ${q.slice(0, 80)}`, kind: 'research', priority: 2, research: { question: q, urls: urls.split(/\s+/).filter(Boolean) } }); setQ(''); setUrls(''); reload(); }); }}>
          <h2>Assign research</h2>
          <label>Question<input value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} /></label>
          <label>Source URLs (https, one per line)<textarea rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} /></label>
          <p className="muted small">New domains need your approval before anything is fetched. The worker quotes passages with sources; it does not summarise (no language model connected).</p>
          <button className="primary" disabled={q.trim().length < 3 || !urls.trim()}>Queue research</button>
        </form>
      </div>
      {bdTask && <BreakdownBox title={bdTask.title} detail={bdTask.description} projectId={bdTask.project_id} onDone={reload} onClose={() => setBdTask(null)} />}
      {Object.entries(groups).map(([name, list]) => (
        <div key={name} className="glass pad section">
          <h2>{name} <span className="muted">{list.length}</span></h2>
          {list.length === 0 && <p className="muted">Nothing here.</p>}
          <ul className="tasks">
            {list.map((t) => (
              <li key={t.id} className={t.state === 'completed' ? 'done' : ''}>
                {t.kind === 'manual' ? (
                  <input type="checkbox" checked={t.state === 'completed'} aria-label={`Complete ${t.title}`}
                    onChange={(e) => a.run(() => api(`/api/tasks/${t.id}/${e.target.checked ? 'complete' : 'reopen'}`, 'POST', {}).then(reload))} />
                ) : <span className="kind">{t.kind}</span>}
                <div className="grow">
                  <button className="link" onClick={async () => { if (open === t.id) setOpen(null); else { setOpen(t.id); setEvents((await api(`/api/tasks/${t.id}`)).events); } }}>{t.title}</button>
                  {t.is_demo ? <span className="badge demo sm">DEMO</span> : null}
                  {t.kind === 'manual' && t.category ? <span className="badge sm" title="Category (worked out from the words in the task)">{t.category}</span> : null}
                  {t.kind === 'manual' && t.state !== 'completed' && t.state !== 'canceled' ? <button className="link small" onClick={() => setBdTask(t)}>Break down</button> : null}
                  <div className="muted small"><span className={`state ${t.state}`}>{t.state.replace('_', ' ')}</span>{t.waiting_reason ? ` · ${t.waiting_reason}` : ''}{t.last_error ? ` · last error: ${t.last_error}` : ''}{t.attempts ? ` · attempt ${t.attempts}/${t.max_attempts}` : ''}</div>
                  {open === t.id && <ol className="events">{events.map((e) => <li key={e.id}><time>{ago(e.at)}</time> {e.kind} {e.detail}</li>)}</ol>}
                </div>
                {!['completed', 'canceled'].includes(t.state) && <button onClick={() => a.run(() => api(`/api/tasks/${t.id}/cancel`, 'POST', {}).then(reload))}>Cancel</button>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <ProjectsPanel />
    </section>
  );
}

// ---------------- Review ----------------
function lineDiff(a: string, b: string) {
  const A = a.split('\n'), B = b.split('\n'), m = A.length, n = B.length;
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { t: ' ' | '-' | '+'; s: string }[] = []; let i = 0, j = 0;
  while (i < m && j < n) { if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: '-', s: A[i++] }); else out.push({ t: '+', s: B[j++] }); }
  while (i < m) out.push({ t: '-', s: A[i++] }); while (j < n) out.push({ t: '+', s: B[j++] });
  return out;
}

/** Untrusted document text is rendered only as React text nodes (never HTML); URLs become links only for http(s). */
function Doc({ text }: { text: string }) {
  return <div className="doc" data-doc>{text.split('\n').map((ln, i) => {
    const h = ln.match(/^(#{1,3})\s+(.*)/);
    const parts = (h ? h[2] : ln.replace(/^>\s?/, '')).split(/(https?:\/\/[^\s)]+)/g).map((p, k) => /^https?:\/\//.test(p) ? <a key={k} href={p} target="_blank" rel="noopener noreferrer nofollow">{p}</a> : p);
    if (h) return <div key={i} className={`h${h[1].length}`}>{parts}</div>;
    return <div key={i} className={ln.startsWith('>') ? 'quote' : ''}>{parts.length ? parts : ' '}</div>;
  })}</div>;
}

export function ReviewPage() {
  const { data: list, reload } = useLive<any[]>(() => api('/api/artifacts'), ['artifacts', 'tasks']);
  const [sel, setSel] = useState<string | null>(null);
  const id = sel ?? list?.[0]?.id ?? null;
  const { data: d, reload: reloadD } = useLive<any>(() => (id ? api(`/api/artifacts/${id}`) : Promise.resolve(null)), ['artifacts'], [id]);
  const [ver, setVer] = useState<number | null>(null), [cmp, setCmp] = useState<number | null>(null);
  const [anchor, setAnchor] = useState(''), [instr, setInstr] = useState('');
  const a = useAction(); const box = useRef<HTMLDivElement>(null);
  const versions: any[] = d?.versions ?? []; const art = d?.artifact;
  const cur = versions.find((v) => v.version === (ver ?? art?.current_version)); const other = cmp ? versions.find((v) => v.version === cmp) : null;
  const diff = useMemo(() => (cur && other ? lineDiff(other.content, cur.content) : null), [cur, other]);
  const grab = () => { const s = window.getSelection(); const t = s?.toString().trim() ?? ''; if (t && box.current?.contains(s!.anchorNode)) setAnchor(t.slice(0, 4000)); };
  return (
    <section className="page">
      <h1>Ready for Review</h1><Err m={a.err} />
      <div className="review">
        <ul className="glass pad plain list">
          {(list ?? []).map((x) => <li key={x.id}><button className={`link ${x.id === id ? 'cur' : ''}`} onClick={() => { setSel(x.id); setVer(null); setCmp(null); setAnchor(''); }}>{x.title}</button><div className="muted small">v{x.current_version} · {x.status.replace('_', ' ')} {x.is_demo ? '· DEMO' : ''}</div></li>)}
          {(list ?? []).length === 0 && <li className="muted">Nothing to review. Assign a research task from Tasks &amp; Projects.</li>}
        </ul>
        {art && cur && (
          <div className="glass pad grow">
            <div className="row wrap">
              <h2 className="grow">{art.title}</h2>
              <label className="inline">Version <select value={cur.version} onChange={(e) => { setVer(+e.target.value); setAnchor(''); }}>{versions.map((v) => <option key={v.version} value={v.version}>v{v.version}{v.version === art.current_version ? ' (current)' : ''}</option>)}</select></label>
              <label className="inline">Compare with <select value={cmp ?? ''} onChange={(e) => setCmp(e.target.value ? +e.target.value : null)}><option value="">—</option>{versions.filter((v) => v.version !== cur.version).map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}</select></label>
            </div>
            <p className="muted small">v{cur.version} · by {cur.created_by} · {ago(cur.created_at)} · {cur.note} · sha256 {cur.content_sha256.slice(0, 12)}…</p>
            {diff ? <pre className="diff">{diff.map((l, i) => <div key={i} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}>{l.t} {l.s}</div>)}</pre> : <div ref={box} onMouseUp={grab} onKeyUp={grab}><Doc text={cur.content} /></div>}
            {cur.version === art.current_version && !diff && (
              <div className="revise">
                <h3>Request a change</h3>
                <p className="muted small">Select text in the document to anchor your request. {anchor ? <>Anchored: <q>{anchor.slice(0, 120)}{anchor.length > 120 ? '…' : ''}</q> <button className="link" onClick={() => setAnchor('')}>clear</button></> : 'No passage selected (applies to the whole document).'}</p>
                <input value={instr} onChange={(e) => setInstr(e.target.value)} placeholder='e.g. "remove", "replace: new text", "note: check this"' maxLength={2000} />
                <p className="muted small">Without a language model I can only apply <b>remove</b>, <b>replace: …</b> and <b>note: …</b>. Anything else is declined, not faked. The original version is always kept.</p>
                <button disabled={!instr.trim()} onClick={() => a.run(async () => { await api(`/api/artifacts/${art.id}/revise`, 'POST', { anchor, instruction: instr }); setInstr(''); setAnchor(''); reloadD(); })}>Request revision</button>
              </div>
            )}
            <div className="row wrap actions">
              {cur.version === art.current_version && art.status === 'in_review' && <button className="primary" onClick={() => a.run(async () => { await api(`/api/artifacts/${art.id}/accept`, 'POST', { version: cur.version }); reload(); reloadD(); })}>Accept draft v{cur.version}</button>}
              {cur.version !== art.current_version && <button onClick={() => a.run(async () => { await api(`/api/artifacts/${art.id}/restore`, 'POST', { version: cur.version }); setVer(null); reloadD(); })}>Restore v{cur.version} as new version</button>}
              {art.status === 'approved' && <button onClick={() => a.run(async () => { const r = await api(`/api/artifacts/${art.id}/request-publish`, 'POST', {}); if (!r.direct) location.hash = '#/approvals'; })}>Request publish approval…</button>}
              <button className="danger" onClick={() => a.run(async () => { if (!confirm(`Permanently delete “${art.title}” and all its versions? This cannot be undone.`)) return; const r = await api(`/api/artifacts/${art.id}/request-delete`, 'POST', {}); if (!r.direct) location.hash = '#/approvals'; })}>Delete permanently…</button>
            </div>
            <p className="muted small">Accepting a draft is not publishing. Publishing and deleting each require their own approval.</p>
            {d.requests.length > 0 && <details><summary>Revision requests ({d.requests.length})</summary><ul className="plain">{d.requests.map((r: any) => <li key={r.id}>v{r.base_version}: {r.instruction} <span className="muted small">({r.status})</span></li>)}</ul></details>}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------- Approvals ----------------
const ASKS: Record<string, string> = { never: 'nothing', request: 'your request is the go-ahead', approve: 'an approval card', always: 'always waits for you', cannot: 'cannot happen: not connected' };
function PolicyTable() {
  const { data } = useLive<any>(() => api('/api/policy/actions'), []);
  if (!data) return null;
  return (
    <div className="glass pad section"><h2>What Jarvis can do, and what asks you</h2>
      <p className="muted small">Agents can only propose; they never act on their own. Work handed between agents stops at {data.limits.maxDepth} levels deep and {data.limits.maxConsults} consults. Temporary and Foundry agents are limited to public, read-only skills.</p>
      <table><thead><tr><th>What</th><th>Risk</th><th>Asks you</th><th>Agents</th></tr></thead>
        <tbody>{data.items.map((r: any) => <tr key={r.id}><td>{r.what}</td><td>{r.risk}</td><td>{ASKS[r.asks]}</td><td>{r.agents}</td></tr>)}</tbody></table></div>);
}
export function ApprovalsPage() {
  const { data, reload } = useLive<any>(() => api('/api/approvals'), ['approvals']);
  const a = useAction(); const [pw, setPw] = useState(''); const [stepped, setStepped] = useState(false);
  const { data: pks } = useLive<any>(() => api('/api/passkeys'), []); const usePasskey = passkeySupported() && (pks?.items?.length ?? 0) > 0;
  const items: any[] = data?.items ?? [];
  const pending = items.filter((i) => i.status === 'pending'), hist = items.filter((i) => i.status !== 'pending');
  const decide = (i: any, decision: 'approve' | 'deny') => a.run(async () => {
    if (decision === 'approve' && i.risk === 'high' && !stepped) {
      if (!pw || pks?.required) { if (!usePasskey) throw new Error('Enter your passphrase (or use your passkey) to confirm a high-risk approval.'); await stepUpWithPasskey(); }
      else { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } setStepped(true);
    }
    let r: any; try { r = await api(`/api/approvals/${i.id}/decide`, 'POST', { decision, digest: i.digest }); } finally { setStepped(false); }   // each confirmation pays for exactly one decision
    if (r.executed === false) throw new Error(`Approved, but not executed: ${r.outcome}`); reload();
  });
  return (
    <section className="page">
      <h1>Approvals</h1><Err m={a.err} />
      <div className="glass pad section"><h2>Pending <span className="muted">{pending.length}</span></h2>
        {pending.length === 0 && <p className="muted">Nothing awaiting your decision.</p>}
        {pending.map((i) => (
          <article key={i.id} className="approval">
            <div className="row wrap"><strong className="grow">{i.summary}</strong><span className={`badge ${i.risk === 'high' ? 'bad' : ''}`}>{i.risk} risk</span></div>
            <p className="muted small">{i.action_type} · requested by {i.requested_by} · expires {ago(new Date(i.expires_at).toISOString())} · digest <code>{i.digest.slice(0, 16)}…</code></p>
            <pre className="payload">{JSON.stringify(JSON.parse(i.payload), null, 2)}</pre>
            <p className="muted small">Approving binds to this exact payload. If anything changes, the approval is void.</p>
            {i.risk === 'high' && !stepped && <label>{usePasskey ? 'Passphrase (step-up), or leave blank to use your passkey' : 'Passphrase (step-up)'}<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>}
            {data.actions.find((x: any) => x.type === i.action_type && !x.available) && <p className="warn">Executor unavailable: {data.actions.find((x: any) => x.type === i.action_type).reason} Approving records your decision but nothing will run.</p>}
            <div className="row"><button className="primary" onClick={() => decide(i, 'approve')}>Approve this exact action</button><button onClick={() => decide(i, 'deny')}>Deny</button></div>
          </article>
        ))}
      </div>
      <StandingCard />
      <div className="glass pad section"><h2>History</h2>
        <table><thead><tr><th>When</th><th>Action</th><th>Status</th><th>Channel</th><th>Outcome</th></tr></thead>
          <tbody>{hist.map((i) => <tr key={i.id}><td>{ago(i.created_at)}</td><td>{i.summary}</td><td><span className={`state ${i.status}`}>{i.status}</span></td><td>{i.source_channel ?? '—'}</td><td>{i.outcome ?? ''}</td></tr>)}</tbody></table>
      </div>
      <PolicyTable />
      <div className="glass pad section"><h2>Protected actions</h2>
        <table><thead><tr><th>Action</th><th>Risk</th><th>Executor</th></tr></thead><tbody>{(data?.actions ?? []).map((x: any) => <tr key={x.type}><td>{x.type}</td><td>{x.risk}</td><td>{x.available ? 'available' : `unavailable — ${x.reason}`}</td></tr>)}</tbody></table>
      </div>
    </section>
  );
}

// ---------------- Memory ----------------
const STATUS_LABEL: Record<string, string> = { stated: 'you said it', confirmed: 'confirmed by you', preference: 'a preference', unverified: 'unconfirmed', historical: 'out of date (not used)', disproven: 'wrong (not used)' };
/** Memories that may contradict each other: only you can say which is right. */
function MemoryReviews() {
  const { data, reload } = useLive<any>(() => api('/api/memory/reviews'), ['memory']); const a = useAction(); const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="glass pad section"><h2>Needs your decision</h2><Err m={a.err} />
      <p className="muted small">A new memory may disagree with an older one. Until you decide, both are used.</p>
      <ul className="plain">{items.map((r: any) => (
        <li key={r.id}><div><b>Newer:</b> {r.newer.content}</div><div><b>Earlier:</b> {r.earlier.content}</div><div className="muted small">Why I flagged it: {r.reason}</div>
          <div className="row wrap"><button className="primary" onClick={() => a.run(() => api(`/api/memory/reviews/${r.id}/resolve`, 'POST', { action: 'replace' }).then(reload))}>Newer is right (replace the earlier)</button>
            <button onClick={() => a.run(() => api(`/api/memory/reviews/${r.id}/resolve`, 'POST', { action: 'keep_both' }).then(reload))}>Both are true</button>
            <button className="danger" onClick={() => a.run(() => api(`/api/memory/reviews/${r.id}/resolve`, 'POST', { action: 'drop_new' }).then(reload))}>Earlier is right (forget the newer)</button></div></li>))}</ul>
    </div>
  );
}
function RecentlyLearned() {
  const { data, reload } = useLive<any>(() => api('/api/memory/learned'), ['memory']); const a = useAction();
  if (!data) return null;
  return (
    <div className="glass pad section"><h2>Recently learned</h2><Err m={a.err} />
      <p className="muted small">Lasting things you told me in chat that I wrote down myself. Never from private mode, web answers or pasted text, and never secrets. <label><input type="checkbox" checked={data.on} onChange={(e) => a.run(() => api('/api/memory/autolearn', 'PUT', { on: e.target.checked }).then(reload))} /> Learn automatically</label></p>
      {data.items.length === 0 ? <p className="muted small">Nothing yet.</p> : <ul className="plain">{data.items.map((m: any) => (
        <li key={m.id} className="row wrap"><div className="grow">{m.content}<div className="muted small">{m.kind} · {ago(m.created_at)}{m.status === 'confirmed' ? ' · you confirmed it' : ''}</div></div>
          {m.status !== 'confirmed' && <button onClick={() => a.run(() => api(`/api/memory/${m.id}/status`, 'PUT', { status: 'confirmed' }).then(reload))}>Keep</button>}
          <button className="danger" onClick={() => a.run(() => api(`/api/memory/${m.id}`, 'DELETE').then(reload))}>Forget</button></li>))}</ul>}
    </div>
  );
}
function DocumentsCard() {
  const { data, reload } = useLive<any>(() => api('/api/documents'), ['documents']); const a = useAction(); const [msg, setMsg] = useState('');
  const pick = (f: File | undefined) => { if (!f) return; setMsg(''); void a.run(async () => { const buf = new Uint8Array(await f.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000)); const r = await api('/api/documents', 'POST', { name: f.name, data: btoa(bin) }); setMsg(r.message); reload(); }); };
  return (
    <div className="glass pad section"><h2>Documents</h2><Err m={a.err} />
      <p className="muted small">Give me a PDF, Word, Excel, PowerPoint, text or CSV file (up to 10 MB), then ask in chat: “summarise the service guide” or “what does the service guide say about heated storage”. I keep only the text, never the file, and it never goes to a web search. Scans and screenshots (pictures of text) can't be read yet.</p>
      <input type="file" aria-label="Add a document" accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.html,.htm" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {msg && <p className="ok small" role="status">{msg}</p>}
      {(data?.items ?? []).length > 0 && <ul className="plain">{data.items.map((d: any) => <li key={d.id} className="row wrap"><span className="grow">{d.name} <span className="muted small">{d.kind.toUpperCase()} · {d.units} {d.units === 1 ? 'part' : 'parts'} · {ago(new Date(d.created_at).toISOString())}</span></span><button className="danger" onClick={() => a.run(() => api(`/api/documents/${d.id}`, 'DELETE').then(reload))}>Forget</button></li>)}</ul>}
    </div>
  );
}
export function MemoryPage() {
  const { data, reload } = useLive<any[]>(() => api('/api/memory'), ['memory']);
  const [text, setText] = useState(''), [edit, setEdit] = useState<{ id: string; v: string } | null>(null); const a = useAction();
  return (
    <section className="page"><h1>Memory</h1><Err m={a.err} />
      <form className="glass pad row" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/memory', 'POST', { content: text }); setText(''); reload(); }); }}>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Remember…" maxLength={1000} /><button className="primary" disabled={!text.trim()}>Remember</button>
      </form>
      <p className="muted small">Secrets, passwords and codes are refused. “Forget” deletes the record outright; database backups age out per the retention note in docs/THREAT_MODEL.md. Suggested memories below come from your saved chats and only become memories when you accept them.</p>
      <MemoryReviews />
      <RecentlyLearned />
      <DocumentsCard />
      <MemorySuggestions />
      <div className="glass pad section"><ul className="plain">
        {(data ?? []).map((m) => (
          <li key={m.id} className={m.superseded_by ? 'dim' : ''}>
            {edit && edit.id === m.id ? <form className="row" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api(`/api/memory/${m.id}`, 'PATCH', { content: edit.v }); setEdit(null); reload(); }); }}><input className="grow" value={edit.v} onChange={(e) => setEdit({ id: m.id, v: e.target.value })} /><button className="primary">Save correction</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></form> : (
              <div className="row wrap"><div className="grow">{m.content}<div className="muted small">{m.scope} · source: {m.source} · {STATUS_LABEL[m.status] ?? m.status} · confidence {m.confidence} · {ago(m.created_at)}{m.superseded_by ? ' · superseded by a correction' : ''}</div></div>
                {!m.superseded_by && m.status !== 'historical' && m.status !== 'disproven' && <><button onClick={() => a.run(() => api(`/api/memory/${m.id}/status`, 'PUT', { status: 'confirmed' }).then(reload))}>Still true</button><button onClick={() => a.run(() => api(`/api/memory/${m.id}/status`, 'PUT', { status: 'historical' }).then(reload))}>Out of date</button><button onClick={() => a.run(() => api(`/api/memory/${m.id}/status`, 'PUT', { status: 'disproven' }).then(reload))}>Wrong</button></>}{!m.superseded_by && <button onClick={() => setEdit({ id: m.id, v: m.content })}>Correct</button>}<button className="danger" onClick={() => a.run(() => api(`/api/memory/${m.id}`, 'DELETE').then(reload))}>Forget</button></div>)}
          </li>))}
        {(data ?? []).length === 0 && <li className="muted">Nothing remembered yet.</li>}
      </ul></div>
    </section>
  );
}

// ---------------- Connections ----------------
export function ConnectionsPage() {
  const { data } = useLive<any>(() => api('/api/connections'), []);
  return (
    <section className="page"><h1>Connections</h1>
      <div className="glass pad"><table><thead><tr><th>Connection</th><th>Status</th><th>Scopes</th><th>Last sync</th><th>Notes</th></tr></thead>
        <tbody>{(data?.items ?? []).map((c: any) => <tr key={c.id}><td>{c.name}</td><td><span className={`badge ${c.status}`}>{c.status}</span></td><td>{c.scopes || '—'}</td><td>{c.last_sync ? ago(c.last_sync) : '—'}</td><td>{c.note}</td></tr>)}</tbody></table>
        <p className="muted small">Disconnect/reconnect controls arrive with the first real external connection. Nothing here holds credentials today.</p></div>
      <SandraCard />
      <div className="glass pad section"><h2>Research allow-list</h2>
        {(data?.domains ?? []).length === 0 ? <p className="muted">No domains approved. The first research task naming a domain will ask for your approval.</p> : <ul className="plain">{data.domains.map((d: any) => <li key={d.host}>{d.host} <span className="muted small">added {ago(d.added_at)}</span></li>)}</ul>}</div>
    </section>
  );
}


function SandraCard() {
  const { data, reload } = useLive<any>(() => api('/api/sandra'), ['connections']);
  const [url, setUrl] = useState(''), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [busy, setBusy] = useState(false);
  if (!data) return null;
  const run = async (fn: () => Promise<string>) => { setBusy(true); setMsg(null); try { setMsg({ ok: true, t: await fn() }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } setBusy(false); };
  return (
    <div className="glass pad section"><h2>Sandra (Sun Sport Marine)</h2>
      <p className="muted small">Read-only. Jarvis reads one counts-only summary from Sandra and nothing else; he can't change anything in the hub. Address: {data.url ?? 'not set'}. Token: {data.tokenSaved ? 'saved' : 'not saved'}.{data.daysLeft !== null && data.daysLeft <= 14 ? ` Token expires in ${Math.max(data.daysLeft, 0)} days.` : ''}</p>
      <div className="row wrap"><input className="grow" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:5290" aria-label="Sandra address" maxLength={200} />
        <button disabled={busy} onClick={() => void run(async () => { await api('/api/sandra/url', 'PUT', { url }); return url ? 'Saved.' : 'Cleared.'; })}>Save address</button>
        <button className="primary" disabled={busy || !data.url || !data.tokenSaved} onClick={() => void run(async () => (await api('/api/sandra/check', 'POST')).text)}>Check connection</button></div>
      {!data.tokenSaved && <p className="small warn">Save the token in your terminal (never in this page): <span className="mono">npm run secret:set -- sandra</span></p>}
      {msg && <pre className={msg.ok ? 'ok small' : 'err small'} role="status" style={{ whiteSpace: 'pre-wrap' }}>{msg.t}</pre>}</div>);
}

// ---------------- Activity ----------------
export function ActivityPage() {
  const { data } = useLive<any>(() => api('/api/activity'), ['activity']);
  return (
    <section className="page"><h1>Activity</h1>
      <p className={data?.chain.ok ? 'ok' : 'err'}>{data ? (data.chain.ok ? 'Audit chain verified: no tampering detected.' : `Audit chain BROKEN at record ${data.chain.brokenAt}.`) : ''}</p>
      <div className="glass pad"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
        <tbody>{(data?.items ?? []).map((r: any) => <tr key={r.id}><td>{ago(r.at)}</td><td>{r.actor}</td><td>{r.action}</td><td className="mono">{r.target.slice(0, 12)}</td><td className="mono small">{r.detail === '{}' ? '' : r.detail}</td></tr>)}</tbody></table></div>
    </section>
  );
}

// ---------------- Settings ----------------
export function SettingsPage(p: { st: AppState; reload: () => void; quality: string; setQuality: (q: any) => void; reduced: boolean; setReduced: (b: boolean) => void; osReduced: boolean; resetLayout: () => void }) {
  const b = p.st.budget; const a = useAction(); const [cat, setCat] = useState('hosting'), [amt, setAmt] = useState('0'), [cap, setCap] = useState(''); const [msg, setMsg] = useState('');
  const { data: led, reload } = useLive<any>(() => api('/api/budget'), ['budget']);
  return (
    <section className="page"><h1>Settings</h1><Err m={a.err} />{msg && <p className="ok">{msg}</p>}
      <div className="grid2">
        <div className="glass pad"><h2>Safety</h2>
          <p>{p.st.pause.paused ? <b className="warn">Paused since {p.st.pause.since ? ago(p.st.pause.since) : ''}.</b> : 'Running.'} Pause stops new automated work and blocks execution of approved actions. {p.st.pause.inflight} task(s) in flight cannot be recalled instantly.</p>
          <button className={p.st.pause.paused ? 'primary' : 'danger'} onClick={() => api('/api/pause', 'POST', { paused: !p.st.pause.paused }).then(p.reload)}>{p.st.pause.paused ? 'Resume' : 'Pause Jarvis'}</button>
        </div>
        <div className="glass pad"><h2>Display</h2>
          <label>Graphics quality<select value={p.quality} onChange={(e) => p.setQuality(e.target.value)}><option value="low">Low (fewest particles)</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <label className="check"><input type="checkbox" checked={p.reduced} onChange={(e) => p.setReduced(e.target.checked)} /> Reduced motion {p.osReduced ? '(your system asks for this)' : ''}</label>
          <p className="muted small">Hidden windows stop rendering. These two settings are remembered on this browser only; the universe layout is saved to your account.</p>
          <button onClick={p.resetLayout}>Reset universe layout</button>
        </div>
      </div>
      <PasskeyCard />
      <DevicesCard />
      <HealthCard />
      <WebSearchCard />
      <BackupCard />
      <PersonaCard />
      <ModelsCard />
      <div className="glass pad section"><h2>Budget — {b.period}</h2>
        <div className="meter" role="img" aria-label={`${Math.round(b.pctCommitted * 100)} percent committed`}><div style={{ width: `${Math.min(100, b.pctCommitted * 100)}%` }} className={b.level} /></div>
        <p>{usd(b.committedMicroUsd)} committed of {usd(b.capMicroUsd)} cap ({Math.round(b.pctCommitted * 100)}%) — fixed {usd(b.fixedMicroUsd)}, used {usd(b.usageMicroUsd)}, reserved {usd(b.reservedMicroUsd)}. Level: <b>{b.level}</b>.</p>
        <p className="muted small">{b.note} Thresholds: 75% review burn rate · 90% optional work paused · cap blocks billable work. Claude Code development usage is a separate expense not counted here (to be confirmed with you).</p>
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/budget/fixed', 'POST', { category: cat, usd: Number(amt), note: 'manual entry' }); p.reload(); reload(); }); }}>
          <input value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Fixed cost category" /><input type="number" min="0" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Monthly USD" /><button>Add fixed monthly cost</button>
        </form>
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/budget/cap-increase', 'POST', { usd: Number(cap) }); location.hash = '#/approvals'; }); }}>
          <input type="number" min="1" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="New cap USD" aria-label="New cap" /><button disabled={!cap}>Request cap increase (needs approval)</button>
        </form>
        <details><summary>Ledger</summary><table><thead><tr><th>When</th><th>Kind</th><th>Category</th><th>Amount</th><th>Status</th></tr></thead><tbody>{(led?.ledger ?? []).map((l: any) => <tr key={l.id}><td>{ago(l.at)}</td><td>{l.kind}</td><td>{l.category}</td><td>{usd(l.micro_usd)}</td><td>{l.status}</td></tr>)}</tbody></table></details>
      </div>
      <div className="glass pad section"><h2>Backup</h2>
        <button onClick={() => a.run(async () => { const r = await api('/api/backup', 'POST', {}); setMsg(`Snapshot written: ${r.file}. ${r.note}`); })}>Create local snapshot</button>
        <p className="muted small">Verify a snapshot with <code>npm run backup:verify -- &lt;file&gt;</code>.</p></div>
    </section>
  );
}
