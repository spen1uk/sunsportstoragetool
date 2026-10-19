import { useEffect, useState } from 'react';
import { api, useLive, usd } from './api.ts';

/** Plain-language status for a research job, and what (if anything) you can do about it. */
function describe(j: any): { label: string; tone: 'ok' | 'busy' | 'warn' | 'bad'; help: string; retry: boolean } {
  const n = String(j.note || '');
  if (j.state === 'completed' && j.hasResults) return { label: 'Results ready', tone: 'ok', help: '', retry: false };
  if (j.state === 'ready') return { label: 'Waiting to start', tone: 'busy', help: 'It starts on its own in a few seconds.', retry: false };
  if (j.state === 'running' || j.state === 'verifying') return { label: 'Researching…', tone: 'busy', help: 'This can take a minute or two. You can leave this page.', retry: false };
  if (j.state === 'failed') return { label: 'Something went wrong', tone: 'bad', help: n ? n.slice(0, 160) : 'Please try again.', retry: true };
  if (j.state === 'canceled') return { label: 'Canceled', tone: 'warn', help: '', retry: false };
  if (/switched off|not enabled/i.test(n)) return { label: 'Paused: web search is off', tone: 'warn', help: 'Turn it on in Settings → Web search, then press Try again.', retry: true };
  if (/limit of/i.test(n)) return { label: 'Paused: daily search limit reached', tone: 'warn', help: 'Raise the limit in Settings → Web search, or press Try again tomorrow.', retry: true };
  if (/budget/i.test(n)) return { label: 'Stopped at its spending limit', tone: 'warn', help: 'Nothing more is spent. You can ask again with a narrower question.', retry: false };
  if (/nothing usable|rephras/i.test(n)) return { label: 'Found nothing usable', tone: 'warn', help: 'Try asking the question a different way.', retry: true };
  return { label: 'Paused', tone: 'warn', help: n.slice(0, 160) || 'Press Try again.', retry: true };
}
const initial = (host: string) => (host.replace(/^www\./, '')[0] ?? '?').toUpperCase();
const TYPE: Record<string, string> = { fact: 'Reported fact', estimate: 'Estimate', hypothesis: 'Inference' };

/** A tiny dependency-free chart (bars or a line) drawn from numbers the sources quoted. */
function Chart({ chart }: { chart: any }) {
  const pts: { label: string; value: number }[] = chart.points, max = Math.max(...pts.map((p) => p.value), 0), min = Math.min(...pts.map((p) => p.value), 0), span = max - min || 1;
  const W = 560, rowH = 30, H = chart.kind === 'line' ? 200 : pts.length * rowH + 10, fmt = (v: number) => `${chart.unit === '$' ? '$' : ''}${Number.isInteger(v) ? v : v.toFixed(2)}${chart.unit && chart.unit !== '$' ? ' ' + chart.unit : ''}`;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H + 24}`} role="img" aria-label={`${chart.title}: ${pts.map((p) => `${p.label} ${fmt(p.value)}`).join(', ')}`} style={{ width: '100%', maxWidth: 640 }}>
        {chart.kind === 'line' ? (<>
          <polyline fill="none" stroke="#4db8ff" strokeWidth="2.5" points={pts.map((p, i) => `${30 + (i * (W - 60)) / Math.max(1, pts.length - 1)},${H - 20 - ((p.value - min) / span) * (H - 50)}`).join(' ')} />
          {pts.map((p, i) => { const x = 30 + (i * (W - 60)) / Math.max(1, pts.length - 1), y = H - 20 - ((p.value - min) / span) * (H - 50); return <g key={i}><circle cx={x} cy={y} r="4" fill="#4db8ff" /><text x={x} y={y - 9} fontSize="11" textAnchor="middle" fill="currentColor">{fmt(p.value)}</text><text x={x} y={H + 6} fontSize="11" textAnchor="middle" fill="currentColor" opacity=".7">{p.label}</text></g>; })}
        </>) : pts.map((p, i) => { const w = Math.max(2, ((p.value - Math.min(min, 0)) / (max - Math.min(min, 0) || 1)) * (W - 200)); return <g key={i}><text x="0" y={i * rowH + 18} fontSize="12" fill="currentColor">{p.label}</text><rect x="130" y={i * rowH + 4} width={w} height="18" rx="3" fill="#4db8ff" opacity=".85" /><text x={136 + w} y={i * rowH + 18} fontSize="12" fill="currentColor">{fmt(p.value)}</text></g>; })}
      </svg>
      <figcaption className="muted small">{chart.title}. Drawn from numbers quoted in the sources: open "Evidence & sources" to check each one.</figcaption>
    </figure>
  );
}

function Results({ id, onBack }: { id: string; onBack: () => void }) {
  const { data: r } = useLive<any>(() => api(`/api/research/${id}/results`), ['tasks'], [id]);
  const [evid, setEvid] = useState<any[] | null>(null);
  if (!r) return <p className="muted">Loading results…</p>;
  const loadEvidence = async (open: boolean) => { if (open && !evid) setEvid((await api(`/api/research/${id}/evidence`)).items); };
  return (
    <div>
      <p><a href="#/research" onClick={(e) => { e.preventDefault(); onBack(); }}>‹ All research</a></p>
      <h2 style={{ marginTop: 0 }}>{r.question}</h2>
      {r.stats.partial && <p className="warn small">This is a partial result: it stopped early ({r.stats.stoppedEarly}).</p>}
      <div className="glass pad section"><h3 style={{ marginTop: 0 }}>The short answer</h3><p style={{ fontSize: 17, lineHeight: 1.5 }}>{r.summary || 'No summary was produced.'}</p>
        <p className="muted small">{r.stats.crossChecked ? 'Checked across several sources.' : 'One quick search; not cross-checked.'} Worth verifying anything important at the original articles below.</p></div>
      {r.options.length > 0 && <div className="section"><h3>Best options found</h3>
        <div className="rcards">{r.options.map((o: any, i: number) => <div key={i} className="glass pad rcard"><div className="muted small">#{i + 1}</div><b style={{ fontSize: 16 }}>{o.name}</b><p className="small">{o.why}</p>
          {o.pros.length > 0 && <ul className="small rlist ok">{o.pros.map((p: string, k: number) => <li key={k}>＋ {p}</li>)}</ul>}{o.cons.length > 0 && <ul className="small rlist warn">{o.cons.map((p: string, k: number) => <li key={k}>－ {p}</li>)}</ul>}
          <span className="badge">{o.support}</span></div>)}</div></div>}
      {r.bestFinds.length > 0 && <div className="section"><h3>Best articles and pages</h3>
        <div className="rcards">{r.bestFinds.map((b: any) => <div key={b.url} className="glass pad rcard"><div className="row" style={{ alignItems: 'center' }}><span className="avatar" aria-hidden>{initial(b.host)}</span><span className="muted small grow">{b.host} · {b.age}</span></div>
          <b>{b.title}</b>{b.why && <p className="small muted">“{b.why}”</p>}
          <div className="row wrap">{b.corroborated && <span className="badge connected">backed up by other sites</span>}<a className="primary-link" href={b.url} target="_blank" rel="noopener noreferrer">Open article ↗</a></div></div>)}</div></div>}
      {r.findings.length > 0 && <div className="glass pad section"><h3 style={{ marginTop: 0 }}>Key findings</h3>
        <ul className="plain">{r.findings.map((f: any, i: number) => <li key={i} style={{ marginBottom: 8 }}>{f.statement} <span className="badge">{TYPE[f.type] ?? f.type}</span> <span className={`badge ${f.support.includes('agree') ? 'connected' : 'planned'}`}>{f.support}</span></li>)}</ul></div>}
      {r.chart && <div className="glass pad section"><h3 style={{ marginTop: 0 }}>Chart</h3><Chart chart={r.chart} /></div>}
      {(r.contradictions.length > 0 || r.gaps.length > 0) && <details className="glass pad section"><summary>Where sources disagree, and what's missing</summary>
        {r.contradictions.length > 0 && <><b className="small">Disagreements</b><ul className="small">{r.contradictions.map((c: any, i: number) => <li key={i}>{c.note}</li>)}</ul></>}
        {r.gaps.length > 0 && <><b className="small">Not established</b><ul className="small">{r.gaps.map((g: string, i: number) => <li key={i}>{g}</li>)}</ul></>}</details>}
      <details className="glass pad section" onToggle={(e) => void loadEvidence((e.target as HTMLDetailsElement).open)}><summary>Evidence &amp; sources ({r.stats.evidenceCount}) — for checking, not for reading</summary>
        <p className="muted small">{r.stats.searches} search(es) · {usd(r.stats.spentMicro)} of {usd(r.stats.capMicro)} budget{r.stats.model ? ` · cross-checked by ${r.stats.model}` : ''}. {r.artifactId && <a href="#/review">The full written report is in Ready for Review ›</a>} Confidence labels are counted from how many independent sites say the same thing; "agree" does not mean proven.</p>
        {r.notes.length > 0 && <ul className="small muted">{r.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>}
        {!evid ? <p className="muted small">Loading…</p> : <ul className="plain small">{evid.map((e: any) => <li key={e.id} style={{ marginBottom: 6 }}><b>{e.source_host.replace(/^www\./, '')}</b> · {e.page_age ?? 'age unknown'} — {e.claim}{e.cited_text ? <div className="muted">“{e.cited_text}”</div> : null}<a className="muted" href={e.source_url} target="_blank" rel="noopener noreferrer">{e.source_url}</a></li>)}</ul>}</details>
      {r.legalNote && <p className="muted small">Research only, not legal advice. For patents, contracts, filings or infringement questions, have a qualified professional review before relying on this.</p>}
    </div>
  );
}

/** Prometheus: ask a question, see clear results; the checking material and the source catalog are tucked away but there. */
export function ResearchPage({ jobId }: { jobId?: string }) {
  const { data, reload } = useLive<any>(() => api('/api/research'), ['tasks', 'artifacts', 'chat']);
  const { data: cat, reload: reloadCat } = useLive<any>(() => api('/api/sources'), ['approvals']);
  const [q, setQ] = useState(''), [tier, setTier] = useState('deep'), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [view, setView] = useState<string | null>(jobId ?? null);
  useEffect(() => { setView(jobId ?? null); }, [jobId]);
  const [host, setHost] = useState(''), [cls, setCls] = useState('unknown'), [status, setStatus] = useState('trusted'), [topics, setTopics] = useState(''), [rel, setRel] = useState(''), [cad, setCad] = useState(''), [note, setNote] = useState('');
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { reload(); reloadCat(); } };
  if (!data) return <section className="page"><h1>Prometheus</h1><p className="muted">Loading…</p></section>;
  if (view) return <section className="page"><h1>Prometheus <span className="muted small">research</span></h1><Results id={view} onBack={() => { setView(null); location.hash = '#/research'; }} /></section>;
  return (
    <section className="page"><h1>Prometheus <span className="muted small">research agent</span></h1>
      <p className="muted">Ask a question. Prometheus searches the web from several angles and gives you the best options, articles and key facts in plain language. The checking material (every source and quote) is kept one click away. Chat shortcut: <code>deep research: your question</code>.</p>
      <div className="glass pad section"><h2>Ask Prometheus</h2>
        {!data.webSearch.enabled && <p className="warn small">Web search is off. Turn it on in <a href="#/settings">Settings → Web search</a> first.</p>}
        <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={3} maxLength={500} placeholder="e.g. What are the best ways to reduce winter storage costs for a small marine business?" aria-label="Research question" style={{ width: '100%' }} />
        <div className="row wrap section">
          <select value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Depth" style={{ width: 'auto' }}><option value="deep">Thorough (up to {usd(data.budgets.deepMicro)})</option><option value="quick">Quick (up to {usd(data.budgets.quickMicro)})</option></select>
          <button className="primary" disabled={!data.webSearch.enabled || q.trim().length < 5} onClick={() => void run(async () => { await api('/api/research', 'POST', { question: q, tier }); setQ(''); }, 'On it. It will appear below in a moment.')}>Start research</button>
        </div>
        {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      </div>
      <div className="section"><h2>Your research</h2>
        {data.jobs.length === 0 ? <p className="muted small">Nothing yet. Ask a question above.</p> : <div className="rcards">{data.jobs.map((j: any) => { const d = describe(j); return (
          <div key={j.id} className="glass pad rcard"><b>{j.question}</b>
            <div><span className={`badge ${d.tone === 'ok' ? 'connected' : 'planned'}`}>{d.label}</span> <span className="muted small">{j.tier === 'quick' ? 'Quick' : 'Thorough'} · {usd(j.spentMicroUsd)}</span></div>
            {d.help && <p className="small muted">{d.help}</p>}
            <div className="row wrap">{d.tone === 'ok' && <button className="primary" onClick={() => setView(j.id)}>View results</button>}{d.retry && <button onClick={() => void run(() => api(`/api/research/${j.id}/retry`, 'POST', {}), 'Trying again.')}>Try again</button>}</div></div>); })}</div>}
      </div>
      <details className="glass pad section"><summary><b>Source catalog</b> <span className="muted small">(advanced: {cat?.items.length ?? 0} sites)</span></summary>
        <p className="muted small">Sites Prometheus knows about. <b>Trusted</b> sites get a focused extra search; <b>blocked</b> sites are left out; new sites it finds appear as <b>suggested</b> for you to judge. Scores are only ever yours. Trusting a site does <u>not</u> let Jarvis fetch its pages; that is a separate approval ("Allow fetching").</p>
        {data.dueForReview.length > 0 && <p className="warn small">Due for your review: {data.dueForReview.join(', ')}</p>}
        <div className="row wrap">
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" aria-label="Site" style={{ width: 160 }} />
          <select value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Class" style={{ width: 'auto' }}>{(cat?.classes ?? []).map((c: string) => <option key={c}>{c}</option>)}</select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={{ width: 'auto' }}>{(cat?.statuses ?? []).map((c: string) => <option key={c}>{c}</option>)}</select>
          <input value={rel} onChange={(e) => setRel(e.target.value)} placeholder="reliability 0–100 (yours)" aria-label="Reliability" style={{ width: 150 }} />
          <input value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="topics, comma separated" aria-label="Topics" style={{ width: 170 }} />
          <input value={cad} onChange={(e) => setCad(e.target.value)} placeholder="review every N days" aria-label="Review cadence" style={{ width: 130 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="terms / access note" aria-label="Terms note" className="grow" />
          <button className="primary" disabled={!host.trim()} onClick={() => void run(async () => { await api('/api/sources', 'POST', { host, class: cls, status, reliability: rel ? Number(rel) : null, topics: topics.split(',').map((t) => t.trim()).filter(Boolean), cadence_days: cad ? Number(cad) : null, terms_note: note }); setHost(''); setRel(''); setTopics(''); setCad(''); setNote(''); }, 'Saved.')}>Add / update</button>
        </div>
        {cat && cat.items.length > 0 && <table className="small section"><thead><tr><th>Site</th><th>Class</th><th>Status</th><th>Yours</th><th>Cited</th><th>Topics</th><th></th></tr></thead><tbody>{cat.items.map((s: any) => (
          <tr key={s.host}><td>{s.host}{s.added_by === 'prometheus' && <span className="muted"> (found by Prometheus)</span>}{s.terms_note && <div className="muted">{s.terms_note}</div>}</td><td>{s.class}</td>
            <td><select value={s.status} onChange={(e) => void run(() => api('/api/sources', 'POST', { host: s.host, status: e.target.value }), 'Updated.')} aria-label={`Status of ${s.host}`} style={{ width: 'auto' }}>{cat.statuses.map((c: string) => <option key={c}>{c}</option>)}</select></td>
            <td>{s.reliability ?? '—'}</td><td>{s.times_cited}</td><td>{s.topics.join(', ')}</td>
            <td>{cat.fetchable.includes(s.host) ? <span className="ok">fetch allowed</span> : <button onClick={() => void run(async () => { await api(`/api/sources/${encodeURIComponent(s.host)}/allow-fetch`, 'POST', {}); }, 'Fetching from this site is now allowed.')}>Allow fetching…</button>} <button onClick={() => { if (confirm(`Remove ${s.host} from the catalog?`)) void run(() => api(`/api/sources/${encodeURIComponent(s.host)}`, 'DELETE'), 'Removed.'); }}>Remove</button></td></tr>))}</tbody></table>}
      </details>
      <details className="glass pad section"><summary><b>Settings</b></summary>
        <label className="check"><input type="checkbox" checked={data.legalFooter} onChange={(e) => void run(() => api('/api/research/settings', 'PUT', { legalFooter: e.target.checked }), 'Saved.')} /> Add a "research only, not legal advice" note to reports about patents, contracts, licences and similar topics</label>
        <p className="muted small">Budgets and what Prometheus may do are on the <a href="#/permissions">Permissions</a> page.</p>
      </details>
    </section>
  );
}
