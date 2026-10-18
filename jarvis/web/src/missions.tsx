import { useState } from 'react';
import { api, useLive, usd } from './api.ts';

const KIND: Record<string, string> = { assigned: 'You assigned', followup: 'Follow-up you accepted', watch: 'Your watch', scout: 'Scouting' };
const STATUS: Record<string, { label: string; tone: 'ok' | 'busy' | 'warn' }> = { proposed: { label: 'Waiting for you', tone: 'warn' }, active: { label: 'Working', tone: 'busy' }, paused: { label: 'Paused', tone: 'warn' }, blocked: { label: 'Needs a nudge', tone: 'warn' }, done: { label: 'Finished', tone: 'ok' }, stopped: { label: 'Stopped', tone: 'warn' }, failed: { label: 'Failed', tone: 'warn' } };
const STEP: Record<string, string> = { pending: '○ waiting', running: '◔ working', done: '● done', failed: '✕ failed', skipped: '– skipped' };
const PRIO = (n: number) => (n <= 2 ? 'High priority' : n >= 5 ? 'Background' : 'Normal');

/** The Mission Tracker: what Prometheus is working on, what it cost, what's blocked, and what it found. */
export function MissionsPage() {
  const { data, reload } = useLive<any>(() => api('/api/missions'), ['missions', 'tasks']);
  const [goal, setGoal] = useState(''), [cap, setCap] = useState('3'), [prio, setPrio] = useState('3'), [value, setValue] = useState(''), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const [topic, setTopic] = useState(''), [every, setEvery] = useState('14'), [more, setMore] = useState<Record<string, string>>({});
  if (!data) return <section className="page"><h1>Missions</h1><p className="muted">Loading…</p></section>;
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { reload(); } };
  const post = (path: string, body: unknown = {}) => api(path, 'POST', body);
  const proposals = data.missions.filter((m: any) => m.status === 'proposed'), live = data.missions.filter((m: any) => ['active', 'blocked', 'paused'].includes(m.status)), past = data.missions.filter((m: any) => ['done', 'stopped', 'failed'].includes(m.status));
  const ex = data.exploration;
  const card = (m: any) => { const st = STATUS[m.status]; return (
    <div key={m.id} className="glass pad rcard"><div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{m.title}</b><span className={`badge ${st.tone === 'ok' ? 'connected' : 'planned'}`}>{st.label}</span></div>
      <div className="muted small">{m.status === 'proposed' ? 'Suggested by Prometheus' : KIND[m.kind]} · {PRIO(m.priority)} · owner {m.owner} · {usd(m.spentMicroUsd)} of {usd(m.capMicroUsd)}</div>
      <div className="meter" role="img" aria-label="budget used"><i style={{ width: `${Math.min(100, (m.spentMicroUsd / Math.max(1, m.capMicroUsd)) * 100)}%` }} /></div>
      {m.value && <p className="small muted">Why: {m.value}</p>}
      {m.blockers && <p className="small warn">{m.blockers.replace(/^auto:budget — /, '')}</p>}
      {m.nextAction && m.status !== 'done' && <p className="small">Next: {m.nextAction}</p>}
      {m.steps.length > 0 && <ul className="plain small">{m.steps.map((s: any) => <li key={s.idx}>{STEP[s.status]} · {s.title}{s.taskId && s.status === 'done' && <> · <a href={`#/research/${s.taskId}`}>View results</a></>}</li>)}</ul>}
      {m.report && <div className="small"><b>Jarvis's review:</b> {m.report.conclusion}{m.report.toVerify?.length > 0 && <><div className="muted">Worth verifying:</div><ul>{m.report.toVerify.map((v: string, i: number) => <li key={i}>{v}</li>)}</ul></>}
        <div className="muted">{m.report.stats.corroborated} of {m.report.stats.findings} findings backed by several sites{m.report.stats.partial ? ' · partial' : ''}{m.report.reviewedByJarvis ? '' : ' · not reviewed by a model'}</div>
        {m.status === 'done' && <div className="row wrap"><input value={more[m.id] ?? ''} onChange={(e) => setMore({ ...more, [m.id]: e.target.value })} placeholder="Ask for more evidence on…" aria-label="More evidence" className="grow" /><button disabled={(more[m.id] ?? '').trim().length < 8} onClick={() => void run(async () => { await post(`/api/missions/${m.id}/more-evidence`, { question: more[m.id] }); setMore({ ...more, [m.id]: '' }); }, 'Added a step; Prometheus will pick it up.')}>Add step</button></div>}</div>}
      <div className="row wrap">
        {m.status === 'proposed' && <><button className="primary" onClick={() => void run(() => post(`/api/missions/${m.id}/accept`), 'Accepted. It will start shortly.')}>Accept</button><button onClick={() => void run(() => post(`/api/missions/${m.id}/dismiss`), 'Dismissed.')}>Dismiss</button></>}
        {m.status === 'active' && <button onClick={() => void run(() => post(`/api/missions/${m.id}/pause`), 'Paused.')}>Pause</button>}
        {m.status === 'paused' && <button className="primary" onClick={() => void run(() => post(`/api/missions/${m.id}/resume`), 'Resumed.')}>Resume</button>}
        {m.status === 'blocked' && <><button className="primary" onClick={() => void run(() => post(`/api/missions/${m.id}/retry`), 'Trying again.')}>Retry</button><button onClick={() => void run(() => post(`/api/missions/${m.id}/wrap-up`), 'Wrapped up.')}>Wrap up with what it has</button></>}
        {['active', 'blocked', 'paused'].includes(m.status) && <button onClick={() => { if (confirm('Stop this mission? What it already found is kept.')) void run(() => post(`/api/missions/${m.id}/stop`), 'Stopped.'); }}>Stop</button>}
      </div></div>); };
  return (
    <section className="page"><h1>Missions</h1>
      <p className="muted">Bigger research jobs that Prometheus runs in steps, using short-lived specialist agents, and reports through Jarvis. You assign them; the only things it starts by itself are the watches you set up below, and follow-up ideas arrive as proposals that do nothing until you accept. Everything is capped and can be paused or stopped. Chat shortcut: <code>mission: your goal</code>.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      {proposals.length > 0 && <div className="section"><h2>Ideas waiting for you</h2><div className="rcards">{proposals.map(card)}</div></div>}
      <div className="glass pad section"><h2>Assign a mission</h2>
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} maxLength={500} placeholder="e.g. Work out the best way to reduce our winter storage costs and what it would take to switch" aria-label="Mission goal" style={{ width: '100%' }} />
        <div className="row wrap section"><label className="small">Spending cap <select value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 'auto' }}><option value="1">$1</option><option value="3">$3</option><option value="5">$5</option><option value="10">$10</option></select></label>
          <label className="small">Priority <select value={prio} onChange={(e) => setPrio(e.target.value)} style={{ width: 'auto' }}><option value="2">High</option><option value="3">Normal</option></select></label>
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Why it matters (optional)" aria-label="Why it matters" className="grow" />
          <button className="primary" disabled={goal.trim().length < 8} onClick={() => void run(async () => { await post('/api/missions', { goal, capUsd: Number(cap), priority: Number(prio), value }); setGoal(''); setValue(''); }, 'Mission created. Prometheus will plan the steps.')}>Start mission</button></div>
        <p className="muted small">Needs web search turned on. The cap is a hard stop for this mission; your monthly cap and daily limits still apply.</p></div>
      <div className="section"><h2>Running and paused</h2>{live.length === 0 ? <p className="muted small">Nothing running.</p> : <div className="rcards">{live.map(card)}</div>}</div>
      <div className="glass pad section"><h2>Watches <span className="muted small">(the only thing Prometheus starts by itself)</span></h2>
        <p className="muted small">A watch repeats a quick search on your topic at the pace you choose. Self-started work runs at the lowest priority (it gives way to anything you assign), at most {data.caps.maxActiveProactive} at a time and {data.caps.maxNewPerDay} new per day, up to {usd(data.caps.proactiveCapMicro)} each. This month: {usd(ex.spent)} spent{ex.inflight ? ` + ${usd(ex.inflight)} in progress` : ''} of the {usd(ex.cap)} monthly exploration budget. Results reach your morning briefing only when something was backed by several sites.</p>
        {data.watches.length > 0 && <ul className="plain small">{data.watches.map((w: any) => <li key={w.id} className="row wrap"><span className="grow"><b>{w.topic}</b> · every {w.cadenceDays} days · {w.kind === 'scout' ? 'scouting' : 'watch'} · {w.lastRunAt ? `last ran ${new Date(w.lastRunAt).toLocaleDateString()}` : 'not run yet'}{!w.enabled && <span className="warn"> · off</span>}</span>
          <button onClick={() => void run(() => post(`/api/watches/${w.id}/enabled`, { enabled: !w.enabled }), w.enabled ? 'Switched off.' : 'Switched on.')}>{w.enabled ? 'Switch off' : 'Switch on'}</button><button onClick={() => void run(() => api(`/api/watches/${w.id}`, 'DELETE'), 'Removed.')}>Remove</button></li>)}</ul>}
        <div className="row wrap"><input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic to keep an eye on" aria-label="Watch topic" className="grow" />
          <label className="small">every <select value={every} onChange={(e) => setEvery(e.target.value)} style={{ width: 'auto' }}><option value="7">week</option><option value="14">2 weeks</option><option value="30">month</option></select></label>
          <button className="primary" disabled={topic.trim().length < 8} onClick={() => void run(async () => { await post('/api/watches', { topic, cadenceDays: Number(every) }); setTopic(''); }, 'Watch added.')}>Add watch</button>
          <button onClick={() => void run(async () => { const r = await post('/api/watches/presets'); if (!r.added) throw new Error('The scouting presets are already there.'); }, 'Added scouting for Jarvis upgrades, security advisories and new safe techniques.')}>Add upgrade scouting</button></div></div>
      <div className="glass pad section"><h2>Temporary agents</h2>
        {data.agents.filter((a: any) => a.live).length === 0 ? <p className="muted small">None right now. A specialist exists only while it works on one step, then is removed automatically (or after {6} hours at the most).</p> : <ul className="plain small">{data.agents.filter((a: any) => a.live).map((a: any) => <li key={a.id} className="row wrap"><span className="grow"><b>{a.name}</b> · {usd(a.budgetMicroUsd)} allowance · may use: {a.skills.join(', ') || 'no skills (research only)'} · ends {new Date(a.expiresAt).toLocaleTimeString()}</span><button onClick={() => void run(() => post(`/api/agents/temp/${a.id}/teardown`), 'Removed.')}>Remove now</button></li>)}</ul>}</div>
      {past.length > 0 && <details className="section"><summary><b>Finished and stopped ({past.length})</b></summary><div className="rcards section">{past.map(card)}</div></details>}
    </section>
  );
}
