import { useState } from 'react';
import { api, useLive, usd } from './api.ts';

const TIER = (t: number) => (t === 0 ? 'reads only' : t === 1 ? 'small changes' : 'larger changes');
const when = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/** Who does what, in plain words. Everything here is read live from Jarvis's own records; nothing is typed in by hand. */
export function AgentsPage() {
  const { data } = useLive<any>(() => api('/api/agents/overview'), ['tasks', 'missions', 'approvals', 'chat', 'improve']);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <section className="page"><h1>Agents</h1><p className="muted">Loading…</p></section>;
  return (
    <section className="page"><h1>Agents</h1>
      <p className="muted">The agents that actually exist in Jarvis today, what each one is allowed to do, what it has been doing, and what it cost this month. Everything else on your org chart is shown at the bottom as planned.</p>
      <div className="rcards">{data.agents.map((a: any) => (
        <div key={a.id} className="glass pad rcard">
          <div className="row wrap" style={{ alignItems: 'center' }}><h2 className="grow" style={{ margin: 0 }}>{a.name}</h2><span className={`badge ${a.busy ? 'connected' : ''}`}>{a.status}</span></div>
          <div className="muted small">{a.role} · works with {a.sees}</div>
          <p className="small">{a.does}</p>
          <ul className="plain small">{a.now.map((n: string) => <li key={n}>{n}</li>)}<li>This month: <b>{usd(a.month)}</b> <span className="muted">(approximate)</span></li></ul>
          <button onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Hide what it can do' : `What it can do (${a.skills.length} skills)`}</button>
          {open === a.id && <ul className="plain small">{a.skills.map((s: any) => <li key={s.id}><b>{s.title}</b> <span className="muted">· {TIER(s.tier)}{s.data === 'private' ? ' · uses your private data' : ''}</span><br />{s.purpose}</li>)}{a.skills.length === 0 && <li className="muted">Nothing yet.</li>}</ul>}
          <div className="small"><b>It can never:</b><ul>{a.cannot.map((c: string) => <li key={c}>{c}</li>)}</ul></div>
          {a.recent.length > 0 && <div className="small"><b>Recently</b><ul className="plain">{a.recent.map((r: any, i: number) => <li key={i}>{r.text} <span className="muted">· {when(r.at)}</span></li>)}</ul></div>}
          <div className="row wrap">{a.links.map((l: any) => <a key={l.href} href={l.href}>{l.label} →</a>)}</div>
        </div>))}</div>
      <div className="glass pad section"><h2>Short-lived helpers</h2>
        {data.helpers.length === 0 ? <p className="muted small">None right now. Prometheus creates one for each step of a mission and removes it when the step is done.</p> : <ul className="plain small">{data.helpers.map((h: any) => <li key={h.id}><b>{h.name}</b>: {h.charter}</li>)}</ul>}</div>
      <div className="glass pad section"><h2>Planned, not connected</h2>
        <ul className="plain small">{data.planned.map((p: any) => <li key={p.id}><b>{p.name}</b> <span className="muted">· {p.status}</span><br />{p.note}</li>)}</ul>
        <p className="muted small">None of these can do anything yet. They show what you intend to connect later.</p></div>
      <p className="muted small">{data.note}</p>
    </section>);
}
