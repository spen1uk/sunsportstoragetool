import { useCallback, useEffect, useState } from 'react';
import { get, post, fmtTime, nameOf } from './api';
import type { Me } from './App';

export function Customers({ me }: { me: Me }) {
  const [rows, setRows] = useState<any[] | null>(null); const [search, setSearch] = useState(''); const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '' }); const [err, setErr] = useState('');
  const load = useCallback(() => get('/api/contacts?search=' + encodeURIComponent(search)).then(setRows).catch((e) => setErr(e.message)), [search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  return (
    <div className="split">
      <section className={`pane list ${sel ? 'hide-m' : ''}`}>
        <div className="pane-head"><input placeholder="Search name, phone, email…" aria-label="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <form className="addrow" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await post('/api/contacts', form); setForm({ firstName: '', lastName: '', phone: '' }); load(); } catch (x: any) { setErr(x.message); } }}>
          <input placeholder="First" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} aria-label="First name" />
          <input placeholder="Last" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} aria-label="Last name" />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} aria-label="Phone" />
          <button className="primary">Add</button>
        </form>
        {err && <p className="error" role="alert">{err}</p>}
        {rows === null ? <p className="muted pad">Loading…</p> : rows.length === 0 ? <p className="muted pad">No customers yet. Add one above, or they appear automatically when someone texts.</p> :
          <ul className="rows">{rows.map((c) => (
            <li key={c.id}><button className={`row ${sel === c.id ? 'sel' : ''}`} onClick={() => setSel(c.id)}>
              <strong>{nameOf(c)}</strong><span className="muted small">{c.phone}</span>
              <span className="chips">{c.sms_opted_out && <span className="chip bad">Opted out</span>}{c.do_not_text && <span className="chip bad">Do not text</span>}{c.outbound_blocked && <span className="chip bad">Outbound blocked</span>}</span>
            </button></li>))}</ul>}
      </section>
      <section className={`pane detail ${sel ? '' : 'hide-m'}`}>
        {sel ? <ContactCard id={sel} me={me} onBack={() => setSel(null)} onChange={load} /> : <p className="muted pad">Select a customer.</p>}
      </section>
    </div>
  );
}

export function ContactCard({ id, me, onBack, onChange }: { id: string; me: Me; onBack?: () => void; onChange?: () => void }) {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  const load = useCallback(() => get(`/api/contacts/${id}`).then(setD).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (err) return <p className="error pad">{err}</p>; if (!d) return <p className="muted pad">Loading…</p>;
  const c = d.contact;
  const consent = async (type: string) => { try { await post(`/api/contacts/${id}/consent`, { type, evidence: 'set by staff in Relay' }); load(); onChange?.(); } catch (x: any) { setErr(x.message); } };
  return (
    <div className="pad scroll">
      {onBack && <button className="linkbtn show-m" onClick={onBack}>← Back</button>}
      <h2>{nameOf({ first_name: c.first_name, last_name: c.last_name, company: c.company, phone: d.identities[0]?.original_value })}</h2>
      <dl className="kv">
        {d.identities.map((i: any) => <div key={i.id}><dt>{i.kind}{i.is_primary ? ' (primary)' : ''}</dt><dd>{i.original_value}<span className="muted small"> → {i.normalized}</span></dd></div>)}
        {c.email && <div><dt>email</dt><dd>{c.email}</dd></div>}
      </dl>
      <h3>Communication status</h3>
      <div className="chips">
        <State on={c.sms_opted_out} label="SMS opt-out (STOP)" /><State on={c.do_not_text} label="Do not text" /><State on={c.outbound_blocked} label="Outbound blocked" /><State on={c.inbound_blocked} label="Inbound blocked" />
        <span className={`chip ${c.marketing_status === 'opt_in' ? 'good' : ''}`}>Marketing: {c.marketing_status.replaceAll('_', ' ')}</span>
      </div>
      <p className="muted small">“Opt-in not received” is not consent. Marketing sends require an explicit opt-in with recorded evidence.</p>
      <div className="btns">
        {c.do_not_text ? <button onClick={() => consent('do_not_text_clear')}>Clear do-not-text</button> : <button onClick={() => consent('do_not_text_set')}>Set do-not-text</button>}
        {c.sms_opted_out ? <button onClick={() => consent('sms_start')}>Record customer re-subscribe (START)</button> : <button onClick={() => consent('sms_stop')}>Record customer opt-out</button>}
        {c.marketing_status !== 'opt_in' && <button onClick={() => consent('marketing_opt_in')}>Record marketing opt-in…</button>}
        {me.user.role !== 'staff' && (c.outbound_blocked ? <button onClick={() => consent('outbound_unblock')}>Unblock outbound</button> : <button onClick={() => consent('outbound_block')}>Block outbound</button>)}
      </div>
      <h3>Boats</h3>
      {d.boats.length === 0 ? <p className="muted">None recorded.</p> : <ul>{d.boats.map((b: any) => <li key={b.id}>{b.relation}: {[b.year, b.make, b.model].filter(Boolean).join(' ')} <span className="muted small">({b.provenance}{b.confirmed ? ', confirmed' : ', unconfirmed'})</span></li>)}</ul>}
      <h3>Timeline</h3>
      {d.timeline.length === 0 ? <p className="muted">No activity yet.</p> : <ul className="tl">{d.timeline.map((t: any, i: number) => <li key={i}><span className="muted small">{fmtTime(t.occurred_at)}</span> {t.summary}</li>)}</ul>}
    </div>
  );
}
const State = ({ on, label }: { on: boolean; label: string }) => <span className={`chip ${on ? 'bad' : 'ok'}`}>{label}: {on ? 'YES' : 'no'}</span>;
