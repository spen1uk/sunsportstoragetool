import { useCallback, useEffect, useState } from 'react';
import { get, post, fmtTime, nameOf } from './api';
import type { Me } from './App';

const money = (c: number, cur = 'usd') => `${cur.toUpperCase() === 'USD' ? '$' : cur.toUpperCase() + ' '}${(Number(c) / 100).toFixed(2)}`;
const LABEL: Record<string, [string, string]> = { draft: ['Draft — no link yet', ''], open: ['Open — awaiting payment', 'warn'], partially_paid: ['Partially paid (verified)', 'info'], paid: ['Paid (verified by provider)', 'good'], failed: ['Failed', 'bad'], expired: ['Expired', 'bad'], cancelled: ['Cancelled in Relay', ''], partially_refunded: ['Partially refunded', 'info'], refunded: ['Refunded', 'info'] };

export function Payments({ me, onCompose }: { me: Me; onCompose: (c: { conversationId: string; body: string; mediaIds: string[]; packageId: string }) => void }) {
  const [list, setList] = useState<any[] | null>(null); const [sel, setSel] = useState<string | null>(null); const [form, setForm] = useState<any | null>(null); const [contacts, setContacts] = useState<any[]>([]); const [err, setErr] = useState(''); const mgr = me.user.role !== 'staff'; const admin = me.user.role === 'owner' || me.user.role === 'admin';
  const load = useCallback(() => get('/api/payments').then(setList).catch((e) => setErr(e.message)), []); useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (form) get('/api/contacts').then(setContacts); }, [form]);
  const run = async (fn: () => Promise<any>) => { setErr(''); try { const r = await fn(); load(); return r; } catch (x: any) { setErr(x.message); } };
  return (
    <div className="page">
      <h2>Payments</h2>
      <p className="muted small">Payment links are created and hosted by the payment provider — Relay never sees or stores card details. A request shows <b>Paid</b> only when the provider reports it (signed webhook, or Relay asks the provider directly). Opening a “thank you” page proves nothing. <b>“Paid” in Relay does not change any invoice balance in your accounting system</b> — that is not connected.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {mgr && !form && <button className="primary" onClick={() => setForm({ contactId: '', amount: '', description: '', reference: '' })}>+ New payment request</button>}
      {form && <div className="card section"><h3>New payment request</h3><div className="formgrid">
        <label>Customer<select value={form.contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}><option value="">Choose…</option>{contacts.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}</select></label>
        <label>Amount (USD)<input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="500.00" /></label>
        <label>What is it for?<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Deposit on 2019 Sea Ray" /></label>
        <label>Invoice / reference (optional)<input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></label></div>
        <div className="btns"><button className="primary" disabled={!form.contactId || !form.description || !(Number(form.amount) > 0)} onClick={async () => { const r = await run(() => post('/api/payments', { contactId: form.contactId, amountCents: Math.round(Number(form.amount) * 100), description: form.description, reference: form.reference || undefined })); if (r) { setForm(null); setSel(r.id); } }}>Create draft</button><button onClick={() => setForm(null)}>Cancel</button></div></div>}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 && !form ? <p className="muted">No payment requests yet. {mgr ? 'Connect a payments provider under Connections (a sandbox demo is available), then create a request.' : ''}</p> : list.map((p) => (
        <div key={p.id} className="card section">
          <div className="rowtop"><b>{money(p.amount_cents, p.currency)} — {p.description}</b><span className={`chip ${LABEL[p.status]?.[1]}`}>{LABEL[p.status]?.[0] ?? p.status}</span></div>
          <div className="small muted">{nameOf(p)}{p.reference ? ` · ref ${p.reference}` : ''}{p.provider ? ` · ${p.provider}${p.provider.startsWith('demo_') ? ' (SANDBOX — no real money)' : ''}` : ''} · created {fmtTime(p.created_at)}</div>
          {(p.paid_cents > 0 || p.refunded_cents > 0) && <div className="small">Paid {money(p.paid_cents, p.currency)}{p.refunded_cents > 0 ? ` · refunded ${money(p.refunded_cents, p.currency)}` : ''}{p.receipt_url ? <> · <a href={p.receipt_url} target="_blank" rel="noreferrer">receipt</a></> : ''}</div>}
          {p.status_detail && p.status_detail !== 'creating' && <div className={`banner ${/MISMATCH|unknown/i.test(p.status_detail) ? 'bad' : 'warn'} small`}>{p.status_detail}</div>}
          <div className="small muted">Accounting: {p.accounting}</div>
          {mgr && <div className="btns">
            {p.status === 'draft' && <button className="primary" onClick={() => run(() => post(`/api/payments/${p.id}/link`))}>Create payment link</button>}
            {p.status === 'open' && <button className="primary" onClick={async () => { const d = await run(() => get(`/api/payments/${p.id}/message-draft`)); if (d) onCompose({ conversationId: d.conversationId, body: d.body, mediaIds: [], packageId: '' }); }}>Draft text with the link…</button>}
            {['draft', 'open'].includes(p.status) && <button onClick={() => { if (confirm('Cancel this request in Relay? If the customer still uses the link and pays, Relay will show that payment.')) run(() => post(`/api/payments/${p.id}/cancel`)); }}>Cancel</button>}
            {['paid', 'partially_paid', 'partially_refunded'].includes(p.status) && admin && <button onClick={() => { const v = prompt(`Refund how many dollars? (up to ${money(p.paid_cents - p.refunded_cents, p.currency)})`); if (v && Number(v) > 0) run(async () => { const r = await post(`/api/payments/${p.id}/refund`, { amountCents: Math.round(Number(v) * 100) }); alert(r.note); }); }}>Request refund…</button>}
            <button onClick={() => setSel(sel === p.id ? null : p.id)}>{sel === p.id ? 'Hide' : 'Events'}</button>
            {p.provider === 'demo_pay' && p.status !== 'draft' && admin && <details className="sim"><summary>Sandbox: simulate the provider</summary><div className="btns">{[['pay', 'Customer pays in full'], ['partial', 'Pays half'], ['refund', 'Provider refunds'], ['expire', 'Link expires']].map(([k, l]) => <button key={k} onClick={() => run(() => post('/api/dev/sandbox/payment', { paymentRequestId: p.id, kind: k }))}>{l}</button>)}<button onClick={() => run(() => post('/api/dev/sandbox/reconcile', { paymentRequestId: p.id }))}>Run reconciliation</button></div><p className="small muted">Sends a real SIGNED webhook through the same endpoint a provider would use.</p></details>}
          </div>}
          {sel === p.id && <Events id={p.id} />}
        </div>))}
    </div>
  );
}
function Events({ id }: { id: string }) {
  const [d, setD] = useState<any>(null); useEffect(() => { get(`/api/payments/${id}`).then(setD); }, [id]);
  if (!d) return null;
  return <div className="pad small">{d.events.length === 0 ? <p className="muted">No verified provider events yet.</p> : <table className="tbl"><thead><tr><th>When</th><th>Event</th><th>Amount</th><th>Verified by</th></tr></thead><tbody>{d.events.map((e: any, i: number) => <tr key={i}><td>{fmtTime(e.received_at)}</td><td>{e.type}{e.terminal ? ' (final)' : ''}</td><td>{e.amount_cents != null ? money(e.amount_cents) : '—'}</td><td>{e.source.replace('_', ' ')}</td></tr>)}</tbody></table>}</div>;
}
