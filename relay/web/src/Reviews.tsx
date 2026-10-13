import { useCallback, useEffect, useState } from 'react';
import { get, post, api, fmtTime } from './api';
import type { Me } from './App';

const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);
const RSTATE: Record<string, [string, string]> = { draft: ['Draft', ''], approved: ['Approved — not posted yet', 'warn'], posting: ['Posting…', 'warn'], posted: ['Posted', 'good'], failed: ['Failed', 'bad'], unknown: ['Outcome unknown — verify on the platform', 'bad'], rejected: ['Superseded', ''] };

export function Reviews({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[] | null>(null); const [sum, setSum] = useState<any[]>([]); const [f, setF] = useState({ source: '', rating: '', replied: '', search: '' }); const [err, setErr] = useState(''); const [tab, setTab] = useState<'reviews' | 'requests'>('reviews'); const [imp, setImp] = useState(false); const mgr = me.user.role !== 'staff';
  const load = useCallback(() => { const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)); get('/api/reviews?' + q).then(setRows).catch((e) => setErr(e.message)); get('/api/reviews/summary').then(setSum); }, [f]); useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  return (
    <div className="chatshell"><div className="tabs"><button className={tab === 'reviews' ? 'active' : ''} onClick={() => setTab('reviews')}>Reviews</button><button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>Request reviews</button><span className="badge right">Nothing is published without a manager’s approval</span></div>
      {tab === 'requests' ? <Requests mgr={mgr} /> : <div className="page">
        <h2>Reviews</h2>
        {sum.length === 0 && <div className="banner">No review source is connected and no reviews have been imported. Connect a source under Connections (Google Business Profile needs Google’s API access approval — not connected), or import reviews manually.</div>}
        <div className="cards">{sum.map((s) => <div key={s.source} className="card stat"><div className="big">{s.avg_rating ?? '—'} <span className="small">/ 5</span></div><div>{s.source}</div><div className="small muted">{s.count} reviews · {s.unreplied} unreplied · {s.distribution.map((n: number, i: number) => `${i + 1}★ ${n}`).join(' · ')}</div>{s.sourceReported && <div className="small">Platform reports {s.sourceReported.averageRating} from {s.sourceReported.totalReviewCount} reviews</div>}<div className="small muted">{s.note}</div></div>)}</div>
        <div className="filters"><select aria-label="Source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="">All sources</option>{sum.map((s) => <option key={s.source}>{s.source}</option>)}</select><select aria-label="Rating" value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value })}><option value="">Any rating</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} stars</option>)}</select><select aria-label="Replied" value={f.replied} onChange={(e) => setF({ ...f, replied: e.target.value })}><option value="">Replied or not</option><option value="no">Unreplied</option><option value="yes">Replied</option></select><input placeholder="Search…" aria-label="Search reviews" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />{mgr && <button onClick={() => setImp(!imp)}>Import manually</button>}</div>
        {imp && <Import onDone={() => { setImp(false); load(); }} />}{err && <p className="error" role="alert">{err}</p>}
        {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">No reviews match.</p> : rows.map((r) => <Review key={r.id} r={r} mgr={mgr} reload={load} />)}
      </div>}</div>
  );
}

function Review({ r, mgr, reload }: { r: any; mgr: boolean; reload: () => void }) {
  const [text, setText] = useState(r.latest_reply?.body ?? ''); const [msg, setMsg] = useState(''); const lr = r.latest_reply; const live = lr && ['draft', 'approved', 'posting', 'unknown', 'failed'].includes(lr.status);
  const run = async (fn: () => Promise<any>) => { setMsg(''); try { const x = await fn(); if (x?.note) setMsg(x.note); if (x?.error) setMsg(x.error); reload(); } catch (e: any) { setMsg(e.message); } };
  return (
    <div className="card section"><div className="rowtop"><span><b>{stars(r.rating)}</b> {r.author_name ?? 'Anonymous'}</span><span className="small muted">{r.source}{r.imported_manually ? ' (manually imported)' : ''} · {fmtTime(r.reviewed_at)}</span></div>
      <p className="pre">{r.body || <i className="muted">No text</i>}</p>
      {r.reply_text ? <div className="card pad small"><b>Reply{r.reply_origin === 'relay' ? ' (posted from Relay)' : ''}:</b> {r.reply_text}</div> : <>
        {!live && <button onClick={() => run(async () => { const d = await post(`/api/reviews/${r.id}/drafts`); setText(d.body); })}>Draft a reply (rule-based, no AI)</button>}
        {live && <div><label>Reply draft — {lr.draftMethod}<textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} disabled={lr.status === 'posting'} /></label>
          <div className="small"><span className={`chip ${RSTATE[lr.status][1]}`}>{RSTATE[lr.status][0]}</span> {lr.error && <span className="muted">{lr.error}</span>}</div>
          <div className="btns">
            {text !== lr.body && <button onClick={() => run(() => api('PATCH', `/api/review-replies/${lr.id}`, { body: text }))}>Save edits (voids any approval)</button>}
            {lr.status === 'draft' && mgr && text === lr.body && <button className="primary" onClick={() => run(() => post(`/api/review-replies/${lr.id}/approve`))}>Approve this exact text</button>}
            {lr.status === 'draft' && !mgr && <span className="small muted">A manager must approve it.</span>}
            {lr.status === 'approved' && mgr && <button className="primary" onClick={() => { if (confirm('Publish this reply publicly on the review platform now?')) run(() => post(`/api/review-replies/${lr.id}/post`)); }}>Post publicly…</button>}
            {r.imported_manually && lr.status === 'approved' && mgr && <button onClick={() => { const t = prompt('Paste the reply you posted on the platform:', lr.body); if (t) run(() => post(`/api/reviews/${r.id}/mark-replied`, { text: t })); }}>I posted it on the platform</button>}
            {lr.status === 'failed' && <button onClick={() => run(() => post(`/api/reviews/${r.id}/drafts`, { body: text }))}>Start a new draft</button>}
          </div></div>}</>}
      {msg && <p className="small banner warn" role="alert">{msg}</p>}</div>
  );
}

function Import({ onDone }: { onDone: () => void }) {
  const [t, setT] = useState(''); const [msg, setMsg] = useState('');
  return <div className="card section"><p className="small muted">Paste JSON: [{`{"source":"google","rating":5,"authorName":"…","body":"…","reviewedAt":"2026-05-01T12:00:00Z"}`}]. These are marked as manually imported and not verified against the platform.</p><textarea rows={4} aria-label="Reviews JSON" value={t} onChange={(e) => setT(e.target.value)} /><div className="btns"><button className="primary" onClick={async () => { try { const r = await post('/api/reviews/import', { reviews: JSON.parse(t) }); setMsg(`Imported ${r.created}, skipped ${r.skipped} duplicates.`); onDone(); } catch (e: any) { setMsg(e.message); } }}>Import</button><span className="small">{msg}</span></div></div>;
}

function Requests({ mgr }: { mgr: boolean }) {
  const [f, setF] = useState({ name: '', tags: '', body: 'Hi {{first_name}}, thank you for choosing Sun Sport Marine! If you have a minute, we would appreciate your review: {{review_link}} Prefer to tell us privately? Just reply to this text.' }); const [msg, setMsg] = useState(''); const [made, setMade] = useState<any>(null);
  if (!mgr) return <div className="page"><p className="muted">Managers can create review requests.</p></div>;
  return (
    <div className="page"><h2>Request reviews</h2>
      <div className="banner">Fair-asking rule: <b>everyone</b> in the group who can be texted is asked — you cannot filter by how happy a customer seems. People asked in the last 90 days are skipped. Replies come back as private feedback in the inbox; they are never published for you. Requests use the same safeguards as broadcasts (approval, opt-outs, quiet hours). Marketing consent rules apply — confirm what your provider and counsel require.</div>
      <div className="card section"><div className="formgrid"><label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label><label>Customer group (tags, comma separated)<input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="e.g. purchased, serviced" /></label>
        <label className="wide">Message (must include {'{{review_link}}'}; set the link in Settings → Business facts)<textarea rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label></div>
        <button className="primary" disabled={!f.name || !f.tags} onClick={async () => { setMsg(''); try { setMade(await post('/api/review-requests', { name: f.name, body: f.body, audienceTags: f.tags.split(',').map((x) => x.trim()).filter(Boolean) })); } catch (e: any) { setMsg(e.message); } }}>Create draft request</button> <span className="error small">{msg}</span>
        {made && <p className="small">Draft created. {made.policy} Open it under <b>Broadcasts</b> to preview recipients and approve.</p>}</div></div>
  );
}
