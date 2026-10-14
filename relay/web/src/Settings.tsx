import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from './api';
import type { Me } from './App';
import { Assistant, SystemStatus } from './Assistant';

const FIELDS: [string, string][] = [['business_phone', 'Business phone'], ['business_address', 'Address'], ['business_hours', 'Business hours (free text)'], ['directions_link', 'Directions link'], ['review_link', 'Review link'], ['website', 'Website']];

export function Settings({ me }: { me: Me }) {
  const mgr = me.user.role !== 'staff';
  return (
    <div className="page">
      <h2>Settings</h2>
      <p className="muted small">Timezone: {me.workspace.timezone} (default). Channels: {me.channels.map((c) => `${c.provider} ${c.address}${c.is_simulated ? ' (DEMO)' : ''}${c.is_live_enabled ? ' [live enabled]' : ' [live sending off]'}`).join('; ') || 'none'}</p>
      <BusinessFacts editable={mgr} />
      <HoursAndAutoResponse editable={mgr} />
      <Templates mgr={mgr} />
      {(me.user.role === 'owner' || me.user.role === 'admin') && <><SystemStatus /><Assistant isOwner={me.user.role === 'owner'} /></>}
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

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function HoursAndAutoResponse({ editable }: { editable: boolean }) {
  const [d, setD] = useState<any>(null); const [hours, setHours] = useState<any[]>([]); const [hol, setHol] = useState<any[]>([]); const [ar, setAr] = useState<any>(null); const [msg, setMsg] = useState(''); const [newHol, setNewHol] = useState({ day: '', name: '', notice: '' });
  useEffect(() => { get('/api/automation/settings').then((x) => { setD(x); setHours(DAYS.map((_, w) => { const h = x.hours.find((y: any) => y.weekday === w); return h ? { weekday: w, closed: h.closed, open: h.open ?? '09:00', close: h.close ?? '17:00' } : { weekday: w, closed: true, open: '09:00', close: '17:00', unset: true }; })); setHol(x.holidays); const a = x.autoResponse; setAr({ enabled: a.auto_response_enabled, firstContactMessage: a.first_contact_message ?? '', afterHoursMessage: a.after_hours_message ?? '', holidayMessage: a.holiday_message ?? '', cadenceHours: a.cadence_hours, quietStartHour: a.quiet_start_hour, quietEndHour: a.quiet_end_hour }); }); }, []);
  if (!d || !ar) return null;
  return (
    <section className="card section"><h3>Business hours, holidays &amp; auto-responses</h3>
      <p className="muted small">Nothing is assumed. {d.hoursConfigured ? 'Hours below are what you entered.' : 'Hours are NOT configured: after-hours notices and “business hours” conditions stay off until you save them.'} Times are in {d.timezone}.</p>
      <table className="tbl"><tbody>{hours.map((h, i) => <tr key={i}><td>{DAYS[i]}</td><td><label className="inline"><input type="checkbox" disabled={!editable} checked={h.closed} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, closed: e.target.checked, unset: false } : x)))} /> Closed</label></td><td><input type="time" disabled={!editable || h.closed} value={h.open} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))} aria-label={`${DAYS[i]} opens`} /></td><td><input type="time" disabled={!editable || h.closed} value={h.close} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))} aria-label={`${DAYS[i]} closes`} /></td></tr>)}</tbody></table>
      <h4>Holidays</h4>{hol.map((h, i) => <div key={i} className="trow"><span>{h.day} — {h.name}{h.notice ? `: “${h.notice}”` : ''}</span>{editable && <button onClick={() => setHol(hol.filter((_, j) => j !== i))}>Remove</button>}</div>)}
      {editable && <div className="formgrid"><label>Date<input type="date" value={newHol.day} onChange={(e) => setNewHol({ ...newHol, day: e.target.value })} /></label><label>Name<input value={newHol.name} onChange={(e) => setNewHol({ ...newHol, name: e.target.value })} /></label><label>Notice text (optional)<input value={newHol.notice} onChange={(e) => setNewHol({ ...newHol, notice: e.target.value })} /></label><button onClick={() => { if (newHol.day && newHol.name) { setHol([...hol, { day: newHol.day, name: newHol.name, closed: true, notice: newHol.notice || null }]); setNewHol({ day: '', name: '', notice: '' }); } }}>Add holiday</button></div>}
      <h4>Auto-responses</h4>
      <label className="inline"><input type="checkbox" disabled={!editable} checked={ar.enabled} onChange={(e) => setAr({ ...ar, enabled: e.target.checked })} /> Send automatic first-contact / after-hours / holiday replies</label>
      <p className="small muted">Never sent when a person or Sandra is handling the thread, when staff already replied, or for STOP/HELP. After-hours and holiday notices are limited to one per conversation per cadence window; a first-contact greeting is sent once. If both apply, only the closed notice is sent. You write every message — Relay supplies none.</p>
      <div className="formgrid"><label className="wide">First-contact message (while open)<textarea rows={2} disabled={!editable} value={ar.firstContactMessage} onChange={(e) => setAr({ ...ar, firstContactMessage: e.target.value })} /></label><label className="wide">After-hours message<textarea rows={2} disabled={!editable} value={ar.afterHoursMessage} onChange={(e) => setAr({ ...ar, afterHoursMessage: e.target.value })} /></label><label className="wide">Holiday message (used when a holiday has no notice of its own)<textarea rows={2} disabled={!editable} value={ar.holidayMessage} onChange={(e) => setAr({ ...ar, holidayMessage: e.target.value })} /></label>
        <label>Min hours between closed notices<input type="number" min="1" disabled={!editable} value={ar.cadenceHours} onChange={(e) => setAr({ ...ar, cadenceHours: Number(e.target.value) })} /></label><label>Quiet hours start (0–23)<input type="number" min="0" max="23" disabled={!editable} value={ar.quietStartHour} onChange={(e) => setAr({ ...ar, quietStartHour: Number(e.target.value) })} /></label><label>Quiet hours end (0–23)<input type="number" min="0" max="23" disabled={!editable} value={ar.quietEndHour} onChange={(e) => setAr({ ...ar, quietEndHour: Number(e.target.value) })} /></label></div>
      <p className="small muted">Quiet hours apply to follow-ups, automations and marketing broadcasts (not to replying to a customer who just wrote). Start = end turns them off.</p>
      {editable && <div><button className="primary" onClick={async () => { setMsg(''); try { await put('/api/automation/settings', { hours: hours.filter((h) => !h.unset).length ? hours.map((h) => ({ weekday: h.weekday, closed: h.closed, open: h.closed ? null : h.open, close: h.closed ? null : h.close })) : undefined, holidays: hol, autoResponse: { ...ar, firstContactMessage: ar.firstContactMessage || null, afterHoursMessage: ar.afterHoursMessage || null, holidayMessage: ar.holidayMessage || null } }); setMsg('Saved.'); } catch (e: any) { setMsg(e.message); } }}>Save</button> <span className="small muted">{msg}</span></div>}
    </section>
  );
}
