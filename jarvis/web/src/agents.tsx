import { useState } from 'react';
import { api, useLive, usd } from './api.ts';

const STATUS_LABEL: Record<string, string> = { working: 'Working', in_review: 'Ready for you', returned: 'Sent back for more', blocked: 'Stuck', accepted: 'Accepted', failed: 'Failed', cancelled: 'Cancelled' };
const card30 = (c: any) => (c.jobs === 0 ? 'No jobs in the last 30 days.' : `${c.jobs} job${c.jobs === 1 ? '' : 's'}, ${c.accepted} accepted${c.acceptRatePct !== null ? ` (${c.acceptRatePct}% of those finished)` : ''}, sent back ${c.returned} time${c.returned === 1 ? '' : 's'}${c.failed ? `, ${c.failed} failed` : ''}${c.avgCostMicro ? ` · about ${usd(c.avgCostMicro)} each` : ''}${c.avgDays !== null ? ` · ${c.avgDays} days on average` : ''}`);

function Delegations() {
  const { data, reload } = useLive<any>(() => api('/api/delegations'), ['delegations', 'missions']);
  const [req, setReq] = useState(''), [who, setWho] = useState<any>(null), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [back, setBack] = useState<Record<string, string>>({}), [days, setDays] = useState(''), [cap, setCap] = useState('3');
  if (!data) return null;
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } };
  return (
    <div className="glass pad section"><h2>Give a job to an agent</h2>
      <p className="muted small">Say what you want done. Jarvis picks the agent that can do it and tells you why, sets a spending limit, checks what comes back and sends weak work back (up to {data.maxReturns} times) before it reaches you.</p>
      <textarea value={req} onChange={(e) => { setReq(e.target.value); setWho(null); }} rows={2} maxLength={500} placeholder="e.g. Research the best ways to cut winter storage costs at a small marina" aria-label="The job" />
      <div className="row wrap"><button disabled={req.trim().length < 8} onClick={() => void run(async () => setWho(await api('/api/delegations/preview', 'POST', { request: req })), '')}>Who would do this?</button>
        <label className="small">limit $<input value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 60 }} inputMode="decimal" aria-label="Spending limit in dollars" /></label><label className="small">due in <input value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 50 }} inputMode="numeric" aria-label="Days to finish" /> days</label>
        <button className="primary" disabled={req.trim().length < 8 || (who && !who.available)} onClick={() => void run(async () => { await api('/api/delegations', 'POST', { request: req, capMicro: Math.round(Number(cap || '3') * 1e6), ...(days ? { deadlineDays: Number(days) } : {}) }); setReq(''); setWho(null); }, 'Handed over.')}>Hand it over</button></div>
      {who && <p className={`small ${who.available ? '' : 'warn'}`} role="status"><b>{who.name}.</b> {who.why}</p>}
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      {data.items.length > 0 && <ul className="plain small">{data.items.map((d: any) => (
        <li key={d.id} className="rcard"><div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{d.request}</b><span className="badge">{STATUS_LABEL[d.status]}</span></div>
          <div className="muted">{d.agentId === 'prometheus' ? 'Prometheus' : 'Your task list'} · {d.why}{d.returns ? ` · sent back ${d.returns} time${d.returns === 1 ? '' : 's'}` : ''}{d.capMicroUsd ? ` · ${usd(d.spentMicroUsd)} of ${usd(d.capMicroUsd)}` : ''}{d.deadlineMs ? ` · due ${new Date(d.deadlineMs).toLocaleDateString()}` : ''}</div>
          {d.verdict && <div>{d.verdict}</div>}
          <div className="row wrap">{d.missionId && <a href="#/missions">See the work →</a>}
            {d.status === 'in_review' && <><button className="primary" onClick={() => void run(() => api(`/api/delegations/${d.id}/accept`, 'POST'), 'Accepted.')}>Accept</button><input value={back[d.id] ?? ''} onChange={(e) => setBack({ ...back, [d.id]: e.target.value })} placeholder="What is missing?" aria-label="What is missing" style={{ width: 200 }} /><button disabled={(back[d.id] ?? '').trim().length < 8} onClick={() => void run(() => api(`/api/delegations/${d.id}/return`, 'POST', { feedback: back[d.id] }), 'Sent back.')}>Send back</button></>}
            {['working', 'returned', 'blocked', 'in_review'].includes(d.status) && <button onClick={() => void run(() => api(`/api/delegations/${d.id}/cancel`, 'POST'), 'Cancelled.')}>Cancel</button>}</div></li>))}</ul>}
    </div>);
}

const TIER = (t: number) => (t === 0 ? 'reads only' : t === 1 ? 'small changes' : 'larger changes');
const when = (t: number) => { const m = Math.round((Date.now() - t) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/** Who does what, in plain words. Everything here is read live from Jarvis's own records; nothing is typed in by hand. */
export function AgentsPage() {
  const { data, error } = useLive<any>(() => api('/api/agents/overview'), ['tasks', 'missions', 'approvals', 'chat', 'improve']);
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <section className="page"><h1>Agents</h1>{error ? <p className="err small" role="alert">Couldn't load this page: {error}. If it says “not found”, restart Jarvis so it picks up the latest version (Ctrl+C in its Terminal window, then npm run build and npm start).</p> : <p className="muted">Loading…</p>}</section>;
  return (
    <section className="page"><h1>Agents</h1>
      <p className="muted">The agents that actually exist in Jarvis today, what each one is allowed to do, what it has been doing, and what it cost this month. Everything else on your org chart is shown at the bottom as planned.</p>
      <div className="rcards">{data.agents.map((a: any) => (
        <div key={a.id} className="glass pad rcard">
          <div className="row wrap" style={{ alignItems: 'center' }}><h2 className="grow" style={{ margin: 0 }}>{a.name}</h2><span className={`badge ${a.busy ? 'connected' : ''}`}>{a.status}</span></div>
          <div className="muted small">{a.role} · works with {a.sees}</div>
          <p className="small">{a.does}</p>
          <ul className="plain small">{a.now.map((n: string) => <li key={n}>{n}</li>)}<li>This month: <b>{usd(a.month)}</b> <span className="muted">(approximate)</span></li></ul>
          {a.scorecard && <p className="small"><b>Last 30 days:</b> {card30(a.scorecard.now)}{a.scorecard.before.jobs > 0 ? <span className="muted"> · the 30 days before: {card30(a.scorecard.before)}</span> : null}{a.scorecard.now.skillRuns > 0 ? <span className="muted"> · skills worked {a.scorecard.now.skillOkPct}% of {a.scorecard.now.skillRuns} runs</span> : null}</p>}
          <button onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Hide what it can do' : `What it can do (${a.skills.length} skills)`}</button>
          {open === a.id && <ul className="plain small">{a.skills.map((s: any) => <li key={s.id}><b>{s.title}</b> <span className="muted">· {TIER(s.tier)}{s.data === 'private' ? ' · uses your private data' : ''}</span><br />{s.purpose}</li>)}{a.skills.length === 0 && <li className="muted">Nothing yet.</li>}</ul>}
          <div className="small"><b>It can never:</b><ul>{a.cannot.map((c: string) => <li key={c}>{c}</li>)}</ul></div>
          {a.recent.length > 0 && <div className="small"><b>Recently</b><ul className="plain">{a.recent.map((r: any, i: number) => <li key={i}>{r.text} <span className="muted">· {when(r.at)}</span></li>)}</ul></div>}
          <div className="row wrap">{a.links.map((l: any) => <a key={l.href} href={l.href}>{l.label} →</a>)}</div>
        </div>))}</div>
      {data.foundryAgents?.length > 0 && <div className="glass pad section"><h2>Built by the Agent Foundry</h2><ul className="plain small">{data.foundryAgents.map((f: any) => <li key={f.id}><b>{f.name}</b> · {f.status === 'active' ? 'working' : 'paused'} · {f.purpose}</li>)}</ul><a href="#/foundry">Open the Foundry →</a></div>}
      <Delegations />
      <div className="glass pad section"><h2>Short-lived helpers</h2>
        {data.helpers.length === 0 ? <p className="muted small">None right now. Prometheus creates one for each step of a mission and removes it when the step is done.</p> : <ul className="plain small">{data.helpers.map((h: any) => <li key={h.id}><b>{h.name}</b>: {h.charter}</li>)}</ul>}</div>
      <div className="glass pad section"><h2>Planned, not connected</h2>
        <ul className="plain small">{data.planned.map((p: any) => <li key={p.id}><b>{p.name}</b> <span className="muted">· {p.status}</span><br />{p.note}</li>)}</ul>
        <p className="muted small">None of these can do anything yet. They show what you intend to connect later.</p></div>
      <p className="muted small">{data.note}</p>
    </section>);
}
