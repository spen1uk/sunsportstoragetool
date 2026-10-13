import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from './api';
import type { Me } from './App';

const FIELDS: [string, string][] = [['business_phone', 'Business phone'], ['business_address', 'Address'], ['business_hours', 'Business hours (free text)'], ['directions_link', 'Directions link'], ['review_link', 'Review link'], ['website', 'Website']];

export function Settings({ me }: { me: Me }) {
  const mgr = me.user.role !== 'staff';
  return (
    <div className="page">
      <h2>Settings</h2>
      <p className="muted small">Timezone: {me.workspace.timezone} (default). Channels: {me.channels.map((c) => `${c.provider} ${c.address}${c.is_simulated ? ' (DEMO)' : ''}${c.is_live_enabled ? ' [live enabled]' : ' [live sending off]'}`).join('; ') || 'none'}</p>
      <BusinessFacts editable={mgr} />
      <Templates mgr={mgr} />
    </div>
  );
}

function BusinessFacts({ editable }: { editable: boolean }) {
  const [v, setV] = useState<Record<string, string>>({}); const [msg, setMsg] = useState('');
  useEffect(() => { get('/api/settings').then(setV); }, []);
  return (
    <section className="card section"><h3>Business facts</h3>
      <p className="muted small">Templates can only use facts entered here. Nothing is pre-filled — hours, prices and services are never assumed.</p>
      <div className="formgrid">{FIELDS.map(([k, l]) => <label key={k}>{l}<input disabled={!editable} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></label>)}</div>
      {editable && <button className="primary" onClick={async () => { try { await put('/api/settings', Object.fromEntries(FIELDS.map(([k]) => [k, v[k] ?? '']))); setMsg('Saved.'); } catch (e: any) { setMsg(e.message); } }}>Save</button>} <span className="small muted">{msg}</span>
    </section>
  );
}

function Templates({ mgr }: { mgr: boolean }) {
  const [list, setList] = useState<any[]>([]); const [cats, setCats] = useState<string[]>([]); const [form, setForm] = useState({ category: 'general', name: '', body: '' }); const [err, setErr] = useState('');
  const [editing, setEditing] = useState<any>(null); const [versions, setVersions] = useState<any[]>([]);
  const load = useCallback(() => get('/api/templates?inactive=1').then(setList), []);
  useEffect(() => { load(); get('/api/templates/categories').then(setCats); }, [load]);
  return (
    <section className="card section"><h3>Templates</h3>
      <p className="muted small">Use variables like {'{{first_name}}'}, {'{{staff_name}}'}, {'{{business_name}}'}, {'{{boat_description}}'} or any business fact above. Messages with unfilled variables cannot be sent.</p>
      {list.map((t) => (
        <div key={t.id} className="trow"><div><b>{t.name}</b> <span className="chip">{t.category}</span> <span className="chip">v{t.current_version}</span>{!t.is_active && <span className="chip bad">inactive</span>}<div className="small muted pre">{t.body}</div></div>
          {mgr && <div className="btns"><button onClick={() => { setEditing({ id: t.id, body: t.body }); get(`/api/templates/${t.id}/versions`).then(setVersions); }}>Edit</button><button onClick={async () => { await post(`/api/templates/${t.id}/active`, { active: !t.is_active }); load(); }}>{t.is_active ? 'Deactivate' : 'Activate'}</button></div>}</div>))}
      {editing && <div className="card"><textarea rows={3} aria-label="Template body" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
        <button className="primary" onClick={async () => { try { await post(`/api/templates/${editing.id}/versions`, { body: editing.body }); setEditing(null); load(); } catch (e: any) { setErr(e.message); } }}>Save as new version</button> <button onClick={() => setEditing(null)}>Cancel</button>
        <ul className="small">{versions.map((v) => <li key={v.version}>v{v.version} — <span className="pre">{v.body}</span> <button onClick={async () => { await post(`/api/templates/${editing.id}/revert`, { version: v.version }); setEditing(null); load(); }}>Restore as new version</button></li>)}</ul></div>}
      {mgr && <form className="formgrid" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await post('/api/templates', form); setForm({ ...form, name: '', body: '' }); load(); } catch (x: any) { setErr(x.message); } }}>
        <label>Category<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{cats.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
        <label className="wide">Body<textarea rows={2} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required /></label>
        <button className="primary">Add template</button></form>}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}
