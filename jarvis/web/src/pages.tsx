import { useMemo, useRef, useState } from 'react';
import { api, ago, usd, useLive, type AppState } from './api.ts';

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
  const { data: projects, reload: reloadP } = useLive<any[]>(() => api('/api/projects'), []);
  const [title, setTitle] = useState(''), [q, setQ] = useState(''), [urls, setUrls] = useState(''), [open, setOpen] = useState<string | null>(null);
  const [events, setEvents] = useState<any[]>([]), [pTitle, setPTitle] = useState('');
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
        <form className="glass pad" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/tasks', 'POST', { title }); setTitle(''); reload(); }); }}>
          <h2>New task</h2>
          <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label>
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
                  <div className="muted small"><span className={`state ${t.state}`}>{t.state.replace('_', ' ')}</span>{t.waiting_reason ? ` · ${t.waiting_reason}` : ''}{t.last_error ? ` · last error: ${t.last_error}` : ''}{t.attempts ? ` · attempt ${t.attempts}/${t.max_attempts}` : ''}</div>
                  {open === t.id && <ol className="events">{events.map((e) => <li key={e.id}><time>{ago(e.at)}</time> {e.kind} {e.detail}</li>)}</ol>}
                </div>
                {!['completed', 'canceled'].includes(t.state) && <button onClick={() => a.run(() => api(`/api/tasks/${t.id}/cancel`, 'POST', {}).then(reload))}>Cancel</button>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="glass pad section">
        <h2>Projects</h2>
        <ul className="plain">{(projects ?? []).map((p) => <li key={p.id}>{p.title} <span className="muted small">{p.scope}</span> {p.is_demo ? <span className="badge demo sm">DEMO</span> : null}</li>)}{(projects ?? []).length === 0 && <li className="muted">No projects yet.</li>}</ul>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/projects', 'POST', { title: pTitle }); setPTitle(''); reloadP(); }); }}>
          <input value={pTitle} onChange={(e) => setPTitle(e.target.value)} placeholder="New project" maxLength={200} /><button disabled={!pTitle.trim()}>Add</button>
        </form>
        <p className="muted small">Progress will be shown from milestones and evidence, never invented percentages. Milestones arrive with the project model in the next iteration.</p>
      </div>
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
              {art.status === 'approved' && <button onClick={() => a.run(async () => { await api(`/api/artifacts/${art.id}/request-publish`, 'POST', {}); location.hash = '#/approvals'; })}>Request publish approval…</button>}
              <button className="danger" onClick={() => a.run(async () => { await api(`/api/artifacts/${art.id}/request-delete`, 'POST', {}); location.hash = '#/approvals'; })}>Request permanent delete…</button>
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
export function ApprovalsPage() {
  const { data, reload } = useLive<any>(() => api('/api/approvals'), ['approvals']);
  const a = useAction(); const [pw, setPw] = useState(''); const [stepped, setStepped] = useState(false);
  const items: any[] = data?.items ?? [];
  const pending = items.filter((i) => i.status === 'pending'), hist = items.filter((i) => i.status !== 'pending');
  const decide = (i: any, decision: 'approve' | 'deny') => a.run(async () => {
    if (decision === 'approve' && i.risk === 'high' && !stepped) {
      if (!pw) throw new Error('Enter your passphrase to confirm a high-risk approval.');
      await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); setStepped(true); setTimeout(() => setStepped(false), 4.5 * 60_000);
    }
    const r = await api(`/api/approvals/${i.id}/decide`, 'POST', { decision, digest: i.digest }); if (r.executed === false) throw new Error(`Approved, but not executed: ${r.outcome}`); reload();
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
            {i.risk === 'high' && !stepped && <label>Passphrase (step-up)<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>}
            {data.actions.find((x: any) => x.type === i.action_type && !x.available) && <p className="warn">Executor unavailable: {data.actions.find((x: any) => x.type === i.action_type).reason} Approving records your decision but nothing will run.</p>}
            <div className="row"><button className="primary" onClick={() => decide(i, 'approve')}>Approve this exact action</button><button onClick={() => decide(i, 'deny')}>Deny</button></div>
          </article>
        ))}
      </div>
      <div className="glass pad section"><h2>Standing permissions</h2>
        {(data?.standing ?? []).length === 0 ? <p className="muted">None granted. A standing permission is separate from any one-time approval and is never inferred from one. Granting them is not available yet.</p> :
          <ul className="plain">{data.standing.map((s: any) => <li key={s.id}>{s.category} {s.revoked_at ? '(revoked)' : <button onClick={() => a.run(() => api(`/api/standing/${s.id}/revoke`, 'POST', {}).then(reload))}>Revoke</button>}</li>)}</ul>}
      </div>
      <div className="glass pad section"><h2>History</h2>
        <table><thead><tr><th>When</th><th>Action</th><th>Status</th><th>Channel</th><th>Outcome</th></tr></thead>
          <tbody>{hist.map((i) => <tr key={i.id}><td>{ago(i.created_at)}</td><td>{i.summary}</td><td><span className={`state ${i.status}`}>{i.status}</span></td><td>{i.source_channel ?? '—'}</td><td>{i.outcome ?? ''}</td></tr>)}</tbody></table>
      </div>
      <div className="glass pad section"><h2>Protected actions</h2>
        <table><thead><tr><th>Action</th><th>Risk</th><th>Executor</th></tr></thead><tbody>{(data?.actions ?? []).map((x: any) => <tr key={x.type}><td>{x.type}</td><td>{x.risk}</td><td>{x.available ? 'available' : `unavailable — ${x.reason}`}</td></tr>)}</tbody></table>
      </div>
    </section>
  );
}

// ---------------- Memory ----------------
export function MemoryPage() {
  const { data, reload } = useLive<any[]>(() => api('/api/memory'), ['memory']);
  const [text, setText] = useState(''), [edit, setEdit] = useState<{ id: string; v: string } | null>(null); const a = useAction();
  return (
    <section className="page"><h1>Memory</h1><Err m={a.err} />
      <form className="glass pad row" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/memory', 'POST', { content: text }); setText(''); reload(); }); }}>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Remember…" maxLength={1000} /><button className="primary" disabled={!text.trim()}>Remember</button>
      </form>
      <p className="muted small">Secrets, passwords and codes are refused. “Forget” deletes the record outright; database backups age out per the retention note in docs/THREAT_MODEL.md. Conversation archive and derived-memory extraction arrive with the language-model provider.</p>
      <div className="glass pad section"><ul className="plain">
        {(data ?? []).map((m) => (
          <li key={m.id} className={m.superseded_by ? 'dim' : ''}>
            {edit && edit.id === m.id ? <form className="row" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api(`/api/memory/${m.id}`, 'PATCH', { content: edit.v }); setEdit(null); reload(); }); }}><input className="grow" value={edit.v} onChange={(e) => setEdit({ id: m.id, v: e.target.value })} /><button className="primary">Save correction</button><button type="button" onClick={() => setEdit(null)}>Cancel</button></form> : (
              <div className="row wrap"><div className="grow">{m.content}<div className="muted small">{m.scope} · source: {m.source} · confidence {m.confidence} · {ago(m.created_at)}{m.superseded_by ? ' · superseded by a correction' : ''}</div></div>
                {!m.superseded_by && <button onClick={() => setEdit({ id: m.id, v: m.content })}>Correct</button>}<button className="danger" onClick={() => a.run(() => api(`/api/memory/${m.id}`, 'DELETE').then(reload))}>Forget</button></div>)}
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
      <div className="glass pad section"><h2>Research allow-list</h2>
        {(data?.domains ?? []).length === 0 ? <p className="muted">No domains approved. The first research task naming a domain will ask for your approval.</p> : <ul className="plain">{data.domains.map((d: any) => <li key={d.host}>{d.host} <span className="muted small">added {ago(d.added_at)}</span></li>)}</ul>}</div>
    </section>
  );
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
