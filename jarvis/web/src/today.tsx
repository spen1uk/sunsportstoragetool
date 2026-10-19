import { useEffect, useState } from 'react';
import { api, ago, useLive, usd, subscribe } from './api.ts';

const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
const Err = ({ m }: { m: string }) => (m ? <p className="err" role="alert">{m}</p> : null);

const MODE_LABEL: Record<string, string> = { normal: 'Available', personal: 'Personal hours', family: 'Family time', meal: 'Meal', church: 'Church / quiet', unavailable: 'Unavailable', away: 'Out for a bit' };

export function ModeControl() {
  const { data, reload } = useLive<any>(() => api('/api/today'), ['mode', 'notifications']);
  const [err, setErr] = useState('');
  if (!data) return null;
  const c = data.contact, away = c.mode === 'away';
  const set = (mode: string, untilMinutes?: number) => api('/api/mode', 'POST', { mode, untilMinutes }).then(reload).catch((e) => setErr(e.message));
  return (
    <span className="modectl" title={`${c.decision.reason}${c.until ? ` · until ${hhmm(c.until)}` : ''}`}>
      {away ? <button className="primary" onClick={() => set('normal')}>I'm back</button> : <button onClick={() => set('away')}>I'm out for a bit</button>}
      <select aria-label="Contact mode" value={c.mode} onChange={(e) => set(e.target.value, ['church', 'meal', 'family'].includes(e.target.value) ? 90 : undefined)}>
        {data.modes.map((m: string) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
      </select>
      {c.decision.hold ? <span className="pill warn">held</span> : <span className="pill ok">{c.decision.channels.join(' · ')}</span>}
      {err && <span className="err small">{err}</span>}
    </span>
  );
}

/** Bell + tray. Real desktop notifications only fire if you grant permission in the browser. */
export function Notifications({ navigate }: { navigate: (h: string) => void }) {
  const { data, reload } = useLive<any[]>(() => api('/api/notifications'), ['notifications', 'notify']);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    return subscribe((type, e) => {
      if (type === 'notify' && 'Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(e.title, { body: e.body, tag: e.id });
        n.onclick = () => { window.focus(); if (e.link) location.hash = e.link; void api(`/api/notifications/${e.id}/seen`, 'POST', {}); };
      }
    });
  }, []);
  const live = (data ?? []).filter((n) => n.state !== 'acked' && n.desktop_at);
  return (
    <span className="bell">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Notifications, ${live.length} unread`}>🔔{live.length > 0 && <b className="count">{live.length}</b>}</button>
      {open && (
        <div className="tray glass" role="region" aria-label="Notifications">
          {'Notification' in window && Notification.permission !== 'granted' && <p className="note small">Desktop pop-ups are off. <button onClick={() => Notification.requestPermission().then(reload)}>Allow desktop notifications</button></p>}
          {(data ?? []).length === 0 && <p className="muted">Nothing yet.</p>}
          <ul className="plain">{(data ?? []).slice(0, 12).map((n) => (
            <li key={n.id} className={n.state === 'acked' ? 'dim' : ''}>
              <div><b>{n.title}</b> <span className="muted small">{ago(new Date(n.due_at).toISOString())}</span></div>
              {n.body && <div className="small">{n.body}</div>}
              {n.text_note && <div className="muted small">Text: {n.text_note}</div>}
              {n.state !== 'acked' && <div className="row">
                {n.link && <button onClick={() => { void api(`/api/notifications/${n.id}/seen`, 'POST', {}); navigate(n.link); setOpen(false); }}>Open</button>}
                <button onClick={() => api(`/api/notifications/${n.id}/snooze`, 'POST', { minutes: 30 }).then(reload)}>Snooze 30m</button>
                <button onClick={() => api(`/api/notifications/${n.id}/ack`, 'POST', {}).then(reload)}>Acknowledge</button>
              </div>}
            </li>))}</ul>
          <p className="muted small">Acknowledging a notification never approves anything; decisions are made on the Approvals page.</p>
        </div>
      )}
    </span>
  );
}

export function BriefingsPage() {
  const { data, error, reload } = useLive<any>(() => api('/api/today'), ['tasks', 'approvals', 'artifacts', 'system', 'mode']);
  if (error) return <section className="page"><Err m={error} /></section>;
  if (!data) return <section className="page"><p className="muted">Loading…</p></section>;
  const b = data.briefing, r = data.recap, t = data.contact.todayTimes;
  return (
    <section className="page">
      <h1>Briefings <button className="link small" onClick={reload}>refresh</button></h1>
      <p className="muted small">Today (Chicago): collection {hhmm(t.collectMorning)} · briefing {hhmm(t.briefing)} · reminders {hhmm(t.noon)}, {hhmm(t.afternoon)}, {hhmm(t.evening)} · recap {hhmm(t.recap)}. Read-aloud arrives with voice (deferred). ~{Math.max(1, Math.round(b.estimatedSeconds / 60))} min of narration prepared{b.overflow ? `; ${b.overflow} more item(s) are only shown below` : ''}.</p>
      {b.isMonday && <p className="note">Monday: schedule below covers the week ahead.</p>}
      {b.sections.map((s: any) => (
        <div key={s.title} className="glass pad section"><h2>{s.title} <span className="muted">{s.items.length}</span></h2>
          {s.items.length === 0 ? <p className="muted">Nothing.</p> : <ul className="plain">{s.items.map((i: any, k: number) => <li key={k} className={i.level === 'urgent' ? 'urgent' : ''}>{i.link ? <a href={i.link}>{i.text}</a> : i.text}</li>)}</ul>}
        </div>))}
      <div className="glass pad section"><h2>Proposed schedule</h2>
        <p className="note small">{b.schedule.caveat}</p>
        {(b.schedule.appointments ?? []).length > 0 && <><h3>Appointments (next 2 days)</h3><ul className="plain">{b.schedule.appointments.map((a: any) => <li key={a.calendar + a.start + a.title}><span className="mono">{a.day} {a.when}</span> {a.title}</li>)}</ul></>}
        {b.schedule.blocks.length === 0 ? <p className="muted">No open tasks to schedule.</p> :
          <table><thead><tr><th>Day</th><th>Time</th><th>Task</th></tr></thead><tbody>{b.schedule.blocks.map((x: any) => <tr key={x.taskId}><td>{x.day}</td><td>{x.when}</td><td>{x.title}</td></tr>)}</tbody></table>}
        {b.schedule.unscheduled.length > 0 && <p className="warn">Does not fit: {b.schedule.unscheduled.join('; ')}</p>}
      </div>
      {b.unavailable.length > 0 && <div className="glass pad section"><h2>Reports unavailable</h2>{b.unavailable.map((u: string) => <p key={u} className="muted">{u}</p>)}</div>}
      <div className="glass pad section"><h2>Evening recap (preview)</h2>
        <p>Completed today: {r.completedToday.length ? r.completedToday.join('; ') : 'none'}</p>
        <p>Unfinished priorities: {r.unfinished.length ? r.unfinished.join('; ') : 'none'}</p>
        <p>Tomorrow: {r.tomorrow} block(s) proposed · Overnight: {r.overnightCount} item(s)</p>
        <p>Needs your decision: {r.decisionsNeeded?.length ? r.decisionsNeeded.join('; ') : 'nothing'}</p></div>
    </section>
  );
}

export function OvernightPage() {
  const { data, reload } = useLive<any>(() => api('/api/today'), ['tasks', 'approvals']);
  const [err, setErr] = useState('');
  const items: any[] = data?.overnight ?? [];
  return (
    <section className="page"><h1>Overnight Plan</h1><Err m={err} />
      <p className="muted small">Work Jarvis can do while you sleep, within permissions and budget. Spending, publishing and anything consequential still waits for your approval. Only cloud-capable work runs; Mac-only tasks wait for a connected Mac. Runs only while this app is running on your Mac.</p>
      <div className="glass pad">
        {items.length === 0 ? <p className="muted">Nothing queued. Assign research from Tasks &amp; Projects.</p> :
          <table><thead><tr><th>Task</th><th>Owner</th><th>Desired morning result</th><th>Priority</th><th>State / hold</th><th>Est. cost</th><th></th></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id}><td>{i.title}{i.tonight && <span className="badge live sm">TONIGHT</span>}</td><td>{i.owner}</td><td>{i.desiredResult}</td><td>{i.priority}</td>
                <td><span className={`state ${i.state}`}>{i.state.replace('_', ' ')}</span>{i.hold && <div className="warn small">{i.hold}</div>}{i.requires === 'mac' && <div className="small">Waits for the Mac</div>}</td>
                <td>{usd(i.estimateMicroUsd)}</td>
                <td><button onClick={() => api(`/api/tasks/${i.id}/tonight`, 'POST', { on: !i.tonight }).then(reload).catch((e) => setErr(e.message))}>{i.tonight ? 'Remove from tonight' : 'Do this tonight'}</button></td></tr>))}</tbody></table>}
      </div>
    </section>
  );
}
