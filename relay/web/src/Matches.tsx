import { useCallback, useEffect, useState } from 'react';
import { get, post, put, fmtTime, nameOf } from './api';
import type { Me } from './App';

const AV: Record<string, [string, string]> = { available: ['Available (source current)', 'good'], unverified_stale: ['Unverified — inventory data is stale', 'warn'], pending: ['Pending / on hold', 'warn'], sold: ['Sold', 'bad'], unknown: ['Availability unknown', 'bad'] };
const money = (n: number | null) => (n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'));

export function Matches({ me, onCompose }: { me: Me; onCompose: (c: { conversationId: string; body: string; mediaIds: string[]; packageId: string }) => void }) {
  const [tab, setTab] = useState<'customers' | 'inventory'>('customers');
  return <div className="chatshell"><div className="tabs"><button className={tab === 'customers' ? 'active' : ''} onClick={() => setTab('customers')}>Customer matches</button><button className={tab === 'inventory' ? 'active' : ''} onClick={() => setTab('inventory')}>Inventory</button>
    <span className="badge right">Outreach is draft-only: a person reviews and sends</span></div>
    {tab === 'inventory' ? <Inventory me={me} /> : <CustomerMatches onCompose={onCompose} />}</div>;
}

function Inventory({ me }: { me: Me }) {
  const [d, setD] = useState<any>(null); const [paste, setPaste] = useState(''); const [msg, setMsg] = useState(''); const mgr = me.user.role !== 'staff';
  const load = useCallback(() => get('/api/inventory').then(setD), []); useEffect(() => { load(); }, [load]);
  const importPaste = async () => {
    setMsg('');
    try {
      let boats: any[];
      if (paste.trim().startsWith('[')) boats = JSON.parse(paste);
      else { const [head, ...lines] = paste.trim().split(/\r?\n/); const cols = head.split(',').map((c) => c.trim()); boats = lines.map((l) => { const v = l.split(','); const o: any = {}; cols.forEach((c, i) => { const x = (v[i] ?? '').trim(); if (x === '') return; o[c] = ['year', 'lengthFt', 'price', 'capacity', 'engineHours'].includes(c) ? Number(x) : c === 'features' ? x.split(';').map((f) => f.trim()) : x; }); return o; }); }
      const r = await post('/api/inventory/import', { sourceKey: 'import', boats }); setMsg(`Imported ${r.upserted} boats.`); setPaste(''); load();
    } catch (e: any) { setMsg(e.message); }
  };
  if (!d) return <p className="muted pad">Loading…</p>;
  return (
    <div className="page">
      <h3>Sources</h3>
      {d.sources.length === 0 ? <p className="muted">No inventory source yet. Import a list below; Relay will treat it as the source of truth until a live inventory connection exists (none is connected).</p> :
        d.sources.map((s: any) => <div key={s.key} className={`banner ${s.fresh ? '' : 'warn'}`}><b>{s.name}</b> ({s.kind}) — last confirmed {s.last_success_sync_at ? fmtTime(s.last_success_sync_at) : 'never'} · {s.fresh ? 'current' : `STALE (older than ${s.stale_after_hours}h): boats are shown as unverified and cannot be offered`} {mgr && <button onClick={async () => { await post(`/api/inventory/sources/${s.key}/confirm`); load(); }}>Confirm inventory is current</button>}</div>)}
      {mgr && <section className="card section"><h3>Import inventory</h3><p className="small muted">CSV (header row: externalId,status,year,make,model,boatType,lengthFt,price,features) or a JSON array. status is one of available, pending, hold, sold. Nothing is assumed: blank cells stay unknown.</p>
        <textarea rows={4} aria-label="Inventory import data" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'externalId,status,year,make,model,boatType,lengthFt,price,features\nS-100,available,2019,Sea Ray,SLX 250,bowrider,25,32000,bimini top;depth finder'} /><div><button className="primary" disabled={!paste.trim()} onClick={importPaste}>Import</button> <span className="small muted">{msg}</span></div></section>}
      <table className="tbl"><thead><tr><th>Boat</th><th>Type</th><th>Length</th><th>Price</th><th>Status</th><th>Source</th></tr></thead><tbody>
        {d.boats.map((b: any) => <tr key={b.id}><td>{[b.year, b.make, b.model].filter(Boolean).join(' ')}<div className="small muted">{b.external_id}</div></td><td>{b.boat_type ?? '—'}</td><td>{b.length_ft ?? '—'}</td><td>{money(b.price == null ? null : Number(b.price))}</td><td><span className={`chip ${AV[b.availability][1]}`}>{AV[b.availability][0]}</span></td><td>{b.source_key}</td></tr>)}</tbody></table>
      {d.boats.length === 0 && <p className="muted">No boats yet.</p>}
    </div>
  );
}

function CustomerMatches({ onCompose }: { onCompose: (c: { conversationId: string; body: string; mediaIds: string[]; packageId: string }) => void }) {
  const [list, setList] = useState<any[]>([]); const [q, setQ] = useState(''); const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => get('/api/contacts?search=' + encodeURIComponent(q)).then(setList), 200); return () => clearTimeout(t); }, [q]);
  return (
    <div className={`split2 ${sel ? 'has-sel' : ''}`}><section className="pane list"><div className="pane-head"><input placeholder="Find a customer…" aria-label="Find a customer" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ul className="rows">{list.map((c) => <li key={c.id}><button className={`row ${sel === c.id ? 'sel' : ''}`} onClick={() => setSel(c.id)}><strong>{nameOf(c)}</strong><span className="muted small">{c.phone}</span></button></li>)}</ul></section>
      <section className="pane detail">{sel ? <CustomerPane key={sel} id={sel} onCompose={onCompose} onBack={() => setSel(null)} /> : <p className="muted pad">Select a customer to record what they want and see matching boats.</p>}</section></div>
  );
}

function CustomerPane({ id, onCompose, onBack }: { id: string; onCompose: (c: { conversationId: string; body: string; mediaIds: string[]; packageId: string }) => void; onBack: () => void }) {
  const [m, setM] = useState<any>(null); const [f, setF] = useState<any>({ budgetMax: '', boatTypes: '', lengthMin: '', lengthMax: '', features: '', useCase: '', tradeNotes: '', confirmed: false }); const [pick, setPick] = useState<string[]>([]); const [msg, setMsg] = useState(''); const [showEx, setShowEx] = useState(false);
  const load = useCallback(() => get(`/api/contacts/${id}/matches?excluded=1`).then((r) => { setM(r); const p = r.preferences; if (p) setF({ budgetMax: p.budget_max != null ? Number(p.budget_max) : '', boatTypes: (p.boat_types ?? []).join(', '), lengthMin: p.length_min != null ? Number(p.length_min) : '', lengthMax: p.length_max != null ? Number(p.length_max) : '', features: (p.features ?? []).join(', '), useCase: p.use_case ?? '', tradeNotes: p.trade_notes ?? '', confirmed: p.confirmed }); }), [id]);
  useEffect(() => { load(); }, [load]);
  const n = (v: string) => (v === '' ? null : Number(v)); const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const save = async () => { setMsg(''); try { await put(`/api/contacts/${id}/preferences`, { budgetMax: n(String(f.budgetMax)), boatTypes: list(f.boatTypes), lengthMin: n(String(f.lengthMin)), lengthMax: n(String(f.lengthMax)), features: list(f.features), useCase: f.useCase || null, tradeNotes: f.tradeNotes || null, provenance: 'staff_entered', confirmed: f.confirmed }); setMsg('Saved. Matches recalculate in the background — refresh in a moment.'); setTimeout(load, 1500); } catch (e: any) { setMsg(e.message); } };
  if (!m) return <p className="muted pad">Loading…</p>;
  return (
    <div className="scroll pad">
      <button className="linkbtn show-m" onClick={onBack}>← Customers</button>
      <section className="card section"><h3>What this customer wants</h3><p className="small muted">Only explicitly recorded preferences are used. Relay never guesses them from message text.</p>
        <div className="formgrid"><label>Max budget ($)<input value={f.budgetMax} onChange={(e) => setF({ ...f, budgetMax: e.target.value })} inputMode="numeric" /></label><label>Boat types (comma separated)<input value={f.boatTypes} onChange={(e) => setF({ ...f, boatTypes: e.target.value })} /></label>
          <label>Min length (ft)<input value={f.lengthMin} onChange={(e) => setF({ ...f, lengthMin: e.target.value })} inputMode="decimal" /></label><label>Max length (ft)<input value={f.lengthMax} onChange={(e) => setF({ ...f, lengthMax: e.target.value })} inputMode="decimal" /></label>
          <label className="wide">Wanted features (comma separated)<input value={f.features} onChange={(e) => setF({ ...f, features: e.target.value })} /></label><label className="wide">Use case<input value={f.useCase} onChange={(e) => setF({ ...f, useCase: e.target.value })} /></label><label className="wide">Trade-in notes<input value={f.tradeNotes} onChange={(e) => setF({ ...f, tradeNotes: e.target.value })} /></label></div>
        <label className="inline"><input type="checkbox" checked={f.confirmed} onChange={(e) => setF({ ...f, confirmed: e.target.checked })} /> Confirmed with the customer</label>
        <div><button className="primary" onClick={save}>Save preferences</button> <span className="small muted">{msg}</span></div></section>
      <h3>Matches</h3>
      {!m.hasPreferences ? <p className="muted">Record preferences above to see matches.</p> : m.matches.length === 0 ? <p className="muted">No boats match right now ({m.excludedCount} excluded — see reasons below).</p> :
        m.matches.map((b: any) => (
          <div key={b.boatId} className="card match"><div className="rowtop"><label className="inline"><input type="checkbox" disabled={!b.packageable} checked={pick.includes(b.boatId)} onChange={(e) => setPick(e.target.checked ? [...pick, b.boatId] : pick.filter((x) => x !== b.boatId))} aria-label={`Select ${b.title}`} /> <b>{b.title}</b> · {money(b.price)}{b.lengthFt ? ` · ${b.lengthFt} ft` : ''}</label><span className="chip count">{b.score}</span></div>
            <div className="chips"><span className={`chip ${AV[b.availability][1]}`}>{AV[b.availability][0]}</span>{b.alreadySentAt && <span className="chip warn">Already sent {fmtTime(b.alreadySentAt)}</span>}{b.userStatus !== 'suggested' && <span className="chip info">{b.userStatus}</span>}</div>
            <ul className="small reasons">{b.explanation.reasons.map((r: any, i: number) => <li key={i} className={`r-${r.result}`}><b>{r.criterion}</b>: {r.detail}{r.result === 'missing_data' && ' (missing data — not counted as a match)'}</li>)}</ul>
            <div className="btns"><button onClick={async () => { await post(`/api/contacts/${id}/matches/${b.boatId}/feedback`, { status: 'interested' }); load(); }}>Customer interested</button><button onClick={async () => { const reason = prompt('Why not a fit? (optional)') ?? undefined; await post(`/api/contacts/${id}/matches/${b.boatId}/feedback`, { status: 'dismissed', reason }); load(); }}>Not a fit</button></div></div>))}
      {m.matches.length > 0 && <div className="btns"><button className="primary" disabled={!pick.length} onClick={async () => {
        try { const pkg = await post(`/api/contacts/${id}/packages`, { boatIds: pick }); const cv = await post('/api/conversations', { contactId: id }); onCompose({ conversationId: cv.id, body: pkg.body, mediaIds: pkg.mediaIds, packageId: pkg.id }); } catch (e: any) { setMsg(e.message); } }}>Build draft package → open in inbox</button><span className="small muted">Selected boats are re-checked for price and availability at the moment you press Send.</span></div>}
      <button className="linkbtn" onClick={() => setShowEx(!showEx)}>{showEx ? 'Hide' : 'Show'} excluded boats ({m.excludedCount})</button>
      {showEx && m.excluded?.map((b: any) => <div key={b.boatId} className="small muted pad">✗ {b.title} ({money(b.price)}) — excluded: {b.excludedBecause.join(', ').replaceAll('_', ' ')}{b.explanation.reasons.filter((r: any) => r.result === 'disqualified').map((r: any) => ` · ${r.detail}`)}</div>)}
    </div>
  );
}
