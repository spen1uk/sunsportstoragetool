import { useCallback, useEffect, useState } from 'react';
import { get, post, put, fmtTime } from './api';
import type { Me } from './App';

const STATUS_TEXT: Record<string, string> = { provider_accepted: 'Accepted by provider', delivered: 'Delivered', failed: 'Failed', unknown: 'Unknown — verify', queued: 'Queued', sending: 'Sending', suppressed: 'Not sent (blocked)', skipped: 'Skipped', pending: 'Waiting to send' };
const REASONS: Record<string, string> = { sms_opted_out: 'opted out (STOP)', do_not_text: 'do-not-text', outbound_blocked: 'outbound blocked', no_marketing_consent: 'no marketing opt-in', duplicate_number: 'duplicate number', missing_details: 'missing details for the message', no_phone: 'no phone number', broadcast_cancelled: 'broadcast cancelled' };

export function Broadcasts({ me }: { me: Me }) {
  const [list, setList] = useState<any[] | null>(null); const [sel, setSel] = useState<string | null>(null); const [form, setForm] = useState<any | null>(null); const mgr = me.user.role !== 'staff';
  const load = useCallback(() => get('/api/broadcasts').then(setList).catch(() => setList([])), []); useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <h2>Broadcasts</h2>
      <p className="muted small">A broadcast is a set of <b>individual</b> texts — never a group thread. Recipients are re-checked at the moment each text goes out, so anyone who opts out (or replies STOP) after you approve is skipped. Replies land in the shared inbox. Nothing is sent without a manager’s approval.</p>
      {mgr && !form && <button className="primary" onClick={() => setForm({ name: '', purpose: 'marketing', body: '', audience: { tags: [] }, batchSize: 25, intervalSeconds: 60 })}>+ New broadcast</button>}
      {form && <Form initial={form} onDone={(id) => { setForm(null); load(); if (id) setSel(id); }} />}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 && !form ? <p className="muted">No broadcasts yet.</p> : list.map((b) => (
        <div key={b.id} className="card section"><div className="rowtop"><b>{b.name}</b><span className={`chip ${b.status === 'completed' ? 'good' : b.status === 'cancelled' ? 'bad' : 'warn'}`}>{b.status}</span></div>
          <div className="small muted">{b.purpose} · {b.recipients} recipient row(s){b.scheduled_for ? ` · starts ${fmtTime(b.scheduled_for)}` : ''}</div>
          <div className="btns"><button onClick={() => setSel(sel === b.id ? null : b.id)}>{sel === b.id ? 'Hide' : 'Open'}</button></div>
          {sel === b.id && <Detail id={b.id} me={me} onChange={load} />}</div>))}
    </div>
  );
}

function Form({ initial, onDone }: { initial: any; onDone: (id?: string) => void }) {
  const [f, setF] = useState(initial); const [tags, setTags] = useState((initial.audience.tags ?? []).join(', ')); const [err, setErr] = useState('');
  return (
    <div className="card section"><h3>New broadcast (saved as a draft)</h3>
      <div className="formgrid"><label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label>Type<select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}><option value="marketing">Marketing (needs each customer’s marketing opt-in; respects quiet hours)</option><option value="transactional">Service notice (opt-outs still honored)</option></select></label>
        <label>Audience: customers with any of these tags (comma separated)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. vip, pontoon-buyers" /></label>
        <label>Texts per batch<input type="number" min="1" max="500" value={f.batchSize} onChange={(e) => setF({ ...f, batchSize: Number(e.target.value) })} /></label>
        <label>Seconds between batches<input type="number" min="1" value={f.intervalSeconds} onChange={(e) => setF({ ...f, intervalSeconds: Number(e.target.value) })} /></label>
        <label className="wide">Message (use {'{{first_name}}'} to personalize; customers without a name are excluded rather than sent “Hi ,”)<textarea rows={3} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} maxLength={1600} /></label></div>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="btns"><button className="primary" disabled={!f.name.trim() || !f.body.trim()} onClick={async () => { setErr(''); try { const r = await post('/api/broadcasts', { ...f, audience: { tags: tags.split(',').map((t: string) => t.trim()).filter(Boolean), contactIds: [] } }); onDone(r.id); } catch (e: any) { setErr(e.message + (e.body?.issues ? ': ' + e.body.issues.join('; ') : '')); } }}>Save draft</button><button onClick={() => onDone()}>Cancel</button></div></div>
  );
}

function Detail({ id, me, onChange }: { id: string; me: Me; onChange: () => void }) {
  const [d, setD] = useState<any>(null); const [pv, setPv] = useState<any>(null); const [when, setWhen] = useState(''); const [err, setErr] = useState(''); const mgr = me.user.role !== 'staff';
  const load = useCallback(() => get(`/api/broadcasts/${id}`).then(setD), [id]); useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
  if (!d) return <p className="muted">Loading…</p>; const b = d.broadcast;
  const act = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); load(); onChange(); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="pad">
      <p className="pre card pad">{b.body}</p>
      {b.status === 'draft' && mgr && <div className="section">
        <button onClick={() => act(async () => setPv(await post(`/api/broadcasts/${id}/preview`)))}>Preview recipients &amp; cost</button>
        {pv && <div className="card pad"><b>{pv.eligibleCount} will receive it</b>, {pv.excludedCount} excluded.
          {Object.keys(pv.excludedByReason).length > 0 && <ul className="small">{Object.entries(pv.excludedByReason).map(([k, n]) => <li key={k}>{n as number} — {REASONS[k] ?? k}</li>)}</ul>}
          <p className="small">Estimated {pv.usage.totalSegments} text segment(s){pv.usage.estimatedCostUsd != null ? ` ≈ $${pv.usage.estimatedCostUsd}` : ''}. <span className="muted">{pv.usage.note}</span></p>
          <b className="small">Samples:</b>{pv.samples.map((s: any, i: number) => <div key={i} className="small pre">→ {s.name}: “{s.text}”</div>)}<p className="small muted">{pv.safeguards}</p></div>}
        <div className="formgrid"><label>Send at (workspace timezone) — or leave blank to send now<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label></div>
        <button className="primary" disabled={!pv || pv.eligibleCount === 0} onClick={() => { if (confirm(`Approve and ${when ? 'schedule' : 'start sending'} this broadcast to ${pv.eligibleCount} people?`)) act(() => post(`/api/broadcasts/${id}/approve`, when ? { localTime: when } : { sendNow: true })); }}>Approve &amp; {when ? 'schedule' : 'send now'}</button> <span className="small muted">{pv ? '' : 'Preview first.'}</span>
        <button onClick={() => act(() => post(`/api/broadcasts/${id}/cancel`))}>Discard</button></div>}
      {['scheduled', 'sending', 'paused'].includes(b.status) && mgr && <div className="btns">{b.status !== 'paused' ? <button onClick={() => act(() => post(`/api/broadcasts/${id}/pause`))}>Pause</button> : <button className="primary" onClick={() => act(() => post(`/api/broadcasts/${id}/resume`))}>Resume</button>}<button onClick={() => { if (confirm('Cancel? Unsent recipients will be skipped.')) act(() => post(`/api/broadcasts/${id}/cancel`)); }}>Cancel</button></div>}
      {err && <p className="error" role="alert">{err}</p>}
      {d.progress.total > 0 && <><h4>Progress</h4><div className="chips">{Object.entries(d.progress.counts).map(([k, n]) => <span key={k} className="chip">{STATUS_TEXT[k] ?? k}: {n as number}</span>)}<span className="chip info">Replied within 48h: {d.progress.replies48h}</span></div>
        <p className="small muted">“Accepted by provider” is not delivery; “Delivered” appears only when the provider confirms.</p>
        <table className="tbl"><thead><tr><th>Recipient</th><th>Status</th><th>Detail</th></tr></thead><tbody>{d.recipients.map((r: any) => <tr key={r.contactId}><td>{r.name}<div className="small muted">{r.phone}</div></td><td>{STATUS_TEXT[r.status] ?? r.status}{r.replied && ' ↩ replied'}</td><td className="small">{REASONS[r.detail] ?? r.detail ?? ''}</td></tr>)}</tbody></table></>}
    </div>
  );
}
void put;
