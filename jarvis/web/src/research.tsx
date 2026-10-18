import { Fragment, useState } from 'react';
import { api, useLive, usd } from './api.ts';

const STATE_LABEL: Record<string, string> = { ready: 'queued', running: 'researching…', waiting_input: 'needs you', waiting_approval: 'waiting for approval', failed: 'failed', completed: 'done', canceled: 'canceled', verifying: 'checking' };

/** Prometheus: start research, watch jobs and budgets, inspect the evidence behind every claim, and manage the source catalog. */
export function ResearchPage() {
  const { data, reload } = useLive<any>(() => api('/api/research'), ['tasks', 'artifacts', 'chat']);
  const { data: cat, reload: reloadCat } = useLive<any>(() => api('/api/sources'), ['approvals']);
  const [q, setQ] = useState(''), [tier, setTier] = useState('deep'), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [open, setOpen] = useState<string | null>(null), [evid, setEvid] = useState<any[] | null>(null);
  const [host, setHost] = useState(''), [cls, setCls] = useState('unknown'), [status, setStatus] = useState('trusted'), [topics, setTopics] = useState(''), [rel, setRel] = useState(''), [cad, setCad] = useState(''), [note, setNote] = useState('');
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { reload(); reloadCat(); } };
  if (!data) return <section className="page"><h1>Prometheus</h1><p className="muted">Loading…</p></section>;
  const showEvidence = async (id: string) => { if (open === id) { setOpen(null); return; } setOpen(id); setEvid(null); const r = await api(`/api/research/${id}/evidence`); setEvid(r.items); };
  return (
    <section className="page"><h1>Prometheus <span className="muted small">research agent</span></h1>
      <p className="muted">Ask a question and Prometheus searches the web from several angles, keeps every cited claim as evidence, cross-checks the findings, and leaves a draft for you to review. It never acts on what it reads. Chat shortcut: <code>deep research: your question</code>.</p>
      <div className="glass pad section"><h2>New research</h2>
        {!data.webSearch.enabled && <p className="warn small">Web search is off. Turn it on in <a href="#/settings">Settings → Web search</a> to use Prometheus.</p>}
        <textarea value={q} onChange={(e) => setQ(e.target.value)} rows={3} maxLength={500} placeholder="e.g. What are the best-supported ways to reduce winter storage costs for a small marine business?" aria-label="Research question" style={{ width: '100%' }} />
        <div className="row wrap section">
          <select value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Depth" style={{ width: "auto" }}><option value="deep">Deep (up to {usd(data.budgets.deepMicro)}; several angles, cross-checked)</option><option value="quick">Quick (up to {usd(data.budgets.quickMicro)}; one search)</option></select>
          <button className="primary" disabled={!data.webSearch.enabled || q.trim().length < 5} onClick={() => void run(async () => { await api('/api/research', 'POST', { question: q, tier }); setQ(''); }, 'Queued. It will appear below and in Ready for Review when done.')}>Start research</button>
        </div>
        <p className="muted small">The job has its own spending cap and stops (keeping what it found) if it reaches it. Budgets are on the <a href="#/permissions">Permissions</a> page.</p>
        {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      </div>
      <div className="glass pad section"><h2>Research jobs</h2>
        {data.jobs.length === 0 ? <p className="muted small">None yet.</p> : <table className="small"><thead><tr><th>Question</th><th>Depth</th><th>Status</th><th>Spent</th><th>Evidence</th><th></th></tr></thead><tbody>{data.jobs.map((j: any) => (<Fragment key={j.id}>
          <tr><td>{j.question}</td><td>{j.tier}</td><td>{STATE_LABEL[j.state] ?? j.state}{j.note ? <div className="muted">{j.note.slice(0, 120)}</div> : null}</td><td>{usd(j.spentMicroUsd)} of {usd(j.capMicroUsd)}</td><td>{j.evidence}</td>
            <td>{j.artifactId && <a href="#/review">Review draft ›</a>} <button onClick={() => void showEvidence(j.id)} disabled={!j.evidence}>{open === j.id ? 'Hide' : 'Evidence'}</button></td></tr>
          {open === j.id && <tr><td colSpan={6}>{!evid ? 'Loading…' : <ul className="plain small">{evid.map((e: any) => <li key={e.id}><b>{e.source_host}</b> · {e.page_age ?? 'age unknown'} — {e.claim}{e.cited_text ? <div className="muted">“{e.cited_text}”</div> : null}<div className="muted">{e.source_url}</div></li>)}</ul>}</td></tr>}
        </Fragment>))}</tbody></table>}
      </div>
      <div className="glass pad section"><h2>Source catalog <span className="muted small">{cat?.items.length ?? 0} sites</span></h2>
        <p className="muted small">Sites Prometheus knows about. <b>Trusted</b> sites get a focused extra search in deep research; <b>blocked</b> sites are excluded; new sites found while researching appear as <b>suggested</b> for you to judge. Scores are only ever yours. Trusting a site does <u>not</u> let Jarvis fetch its pages; that is a separate approval ("Allow fetching").</p>
        {data.dueForReview.length > 0 && <p className="warn small">Due for your review: {data.dueForReview.join(', ')}</p>}
        <div className="row wrap">
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" aria-label="Site" style={{ width: 160 }} />
          <select value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Class" style={{ width: "auto" }}>{(cat?.classes ?? []).map((c: string) => <option key={c}>{c}</option>)}</select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={{ width: "auto" }}>{(cat?.statuses ?? []).map((c: string) => <option key={c}>{c}</option>)}</select>
          <input value={rel} onChange={(e) => setRel(e.target.value)} placeholder="reliability 0–100 (yours)" aria-label="Reliability" style={{ width: 150 }} />
          <input value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="topics, comma separated" aria-label="Topics" style={{ width: 170 }} />
          <input value={cad} onChange={(e) => setCad(e.target.value)} placeholder="review every N days" aria-label="Review cadence" style={{ width: 130 }} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="terms / access note" aria-label="Terms note" className="grow" />
          <button className="primary" disabled={!host.trim()} onClick={() => void run(async () => { await api('/api/sources', 'POST', { host, class: cls, status, reliability: rel ? Number(rel) : null, topics: topics.split(',').map((t) => t.trim()).filter(Boolean), cadence_days: cad ? Number(cad) : null, terms_note: note }); setHost(''); setRel(''); setTopics(''); setCad(''); setNote(''); }, 'Saved.')}>Add / update</button>
        </div>
        {cat && cat.items.length > 0 && <table className="small section"><thead><tr><th>Site</th><th>Class</th><th>Status</th><th>Yours</th><th>Cited</th><th>Topics</th><th></th></tr></thead><tbody>{cat.items.map((s: any) => (
          <tr key={s.host}><td>{s.host}{s.added_by === 'prometheus' && <span className="muted"> (found by Prometheus)</span>}{s.terms_note && <div className="muted">{s.terms_note}</div>}</td><td>{s.class}</td>
            <td><select value={s.status} onChange={(e) => void run(() => api('/api/sources', 'POST', { host: s.host, status: e.target.value }), 'Updated.')} aria-label={`Status of ${s.host}`}>{cat.statuses.map((c: string) => <option key={c}>{c}</option>)}</select></td>
            <td>{s.reliability ?? '—'}</td><td>{s.times_cited}</td><td>{s.topics.join(', ')}</td>
            <td>{cat.fetchable.includes(s.host) ? <span className="ok">fetch allowed</span> : <button onClick={() => void run(async () => { await api(`/api/sources/${encodeURIComponent(s.host)}/allow-fetch`, 'POST', {}); }, 'Approval requested: decide it on the Approvals page.')}>Allow fetching…</button>} <button onClick={() => { if (confirm(`Remove ${s.host} from the catalog?`)) void run(() => api(`/api/sources/${encodeURIComponent(s.host)}`, 'DELETE'), 'Removed.'); }}>Remove</button></td></tr>))}</tbody></table>}
      </div>
      <div className="glass pad section"><h2>Settings</h2>
        <label className="check"><input type="checkbox" checked={data.legalFooter} onChange={(e) => void run(() => api('/api/research/settings', 'PUT', { legalFooter: e.target.checked }), 'Saved.')} /> Add a "research only, not legal advice" note to reports about patents, contracts, licences and similar topics</label>
      </div>
    </section>
  );
}
