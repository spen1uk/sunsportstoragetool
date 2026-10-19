import { useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { stepUpWithPasskey } from './passkey.ts';

const STATUS: Record<string, string> = { building: 'Being built…', ready: 'Ready for your decision', blocked: 'Did not pass its checks', failed: 'Failed', approved: 'Approved', rejected: 'Rejected' };

/** Prometheus's Agent Foundry: describe an employee you want, watch it get designed, tested and audited, then decide. */
export function FoundryPage() {
  const { data, reload } = useLive<any>(() => api('/api/foundry'), ['foundry']);
  const [need, setNeed] = useState(''), [gal, setGal] = useState('proj'), [cap, setCap] = useState('0.60'), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [pw, setPw] = useState(''), [open, setOpen] = useState<string | null>(null), [ev, setEv] = useState<any[]>([]), [replace, setReplace] = useState('');
  if (!data) return <section className="page"><h1>Agent Foundry</h1><p className="muted">Loading…</p></section>;
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMsg(null); try { await fn(); if (ok) setMsg({ ok: true, t: ok }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } };
  const confirm1 = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  const name = (id: string) => data.galaxies.find((g: any) => g.id === id)?.name ?? id;
  const live = data.agents.filter((a: any) => a.status !== 'retired');
  return (
    <section className="page"><h1>Agent Foundry</h1>
      <p className="muted">Prometheus's department for building new AI employees. Describe what you want. An <b>Architect</b> designs it, an <b>Engineer</b> turns the design into instructions, a schedule and a cost, a <b>Simulation Tester</b> tries it on made-up situations (including tricks), and a <b>Security Auditor</b> checks its limits. Then you decide. Nothing is switched on without your passphrase or passkey. For now it builds research agents: they watch public information on the internet on a schedule and report; they cannot see your private records or take any action.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      <div className="glass pad section"><h2>Request an agent</h2>
        <textarea value={need} onChange={(e) => setNeed(e.target.value)} rows={3} maxLength={600} placeholder="e.g. An employee that watches boat prices across Wisconsin and tells Sandra when ours look too high" aria-label="What should the agent do" />
        <div className="row wrap"><label className="small">Reports to <select value={gal} onChange={(e) => setGal(e.target.value)} style={{ width: 'auto' }}>{data.galaxies.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label className="small">Improve one I have <select value={replace} onChange={(e) => setReplace(e.target.value)} style={{ width: 'auto' }}><option value="">No, a new one</option>{live.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label className="small">Spending limit $<input value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 60 }} inputMode="decimal" aria-label="Spending limit in dollars" /></label>
          <button className="primary" disabled={need.trim().length < 15 || !data.modelReady} onClick={() => void run(async () => { await api('/api/foundry', 'POST', { need, galaxyId: gal, capMicro: Math.round(Number(cap) * 1e6), replacesAgentId: replace || null }); setNeed(''); }, 'The Foundry is working on it. This takes a minute or two.')}>Build it</button></div>
        <p className="muted small">Designing, testing and auditing usually costs 5 to 20 cents, never more than your limit. {!data.modelReady && <span className="warn">No language model is connected.</span>}</p></div>
      {live.length > 0 && <div className="glass pad section"><h2>Agents the Foundry built</h2><ul className="plain small">{live.map((a: any) => (
        <li key={a.id} className="rcard"><div className="row wrap" style={{ alignItems: 'center' }}><span className="grow"><b>{a.name}</b> · reports to {name(a.galaxyId)} · {a.status === 'active' ? 'working' : 'paused'} · version {a.version}<br /><span className="muted">{a.spec.purpose}</span><br /><span className="muted">Asks “{a.spec.question}” every {a.spec.cadenceDays} day{a.spec.cadenceDays === 1 ? '' : 's'}{a.lastRunAt ? ` · last run ${new Date(a.lastRunAt).toLocaleDateString()}` : ''}</span></span>
          {a.status === 'active' ? <button onClick={() => void run(() => api(`/api/foundry/agents/${a.id}/status`, 'POST', { status: 'paused' }), 'Paused.')}>Pause</button> : <button onClick={() => void run(async () => { await confirm1(); await api(`/api/foundry/agents/${a.id}/status`, 'POST', { status: 'active' }); }, 'Switched on.')}>Switch on…</button>}
          <button onClick={() => { if (confirm(`Retire ${a.name}? It stops for good.`)) void run(() => api(`/api/foundry/agents/${a.id}/status`, 'POST', { status: 'retired' }), 'Retired.'); }}>Retire</button></div></li>))}</ul>
        <p className="muted small">They run as scheduled research under the same limits as other self-started research. Their reports arrive in your briefing when something corroborated turns up.</p></div>}
      <div className="glass pad section"><h2>Proposals</h2>
        {data.proposals.length === 0 ? <p className="muted small">None yet.</p> : data.proposals.map((p: any) => (
          <div key={p.id} className="rcard" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
            <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{p.spec?.name ?? p.need.slice(0, 70)}</b><span className="badge">{STATUS[p.status]}</span></div>
            <div className="muted small">For {name(p.galaxyId)} · cost so far {usd(p.costMicroUsd)} of {usd(p.capMicroUsd)}{p.replacesAgentId ? ' · an improvement of an existing agent' : ''}</div>
            {p.error && <p className="small warn">{p.error}</p>}
            {p.report && <details open={p.status === 'ready'}><summary className="small"><b>Read the write-up</b></summary><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }} className="small">{p.report}</pre>
              {p.audit && <ul className="plain small">{p.audit.checks.map((c: any) => <li key={c.id}>{c.passed ? '✓' : '✕'} {c.title}{!c.passed && <span className="warn"> — {c.detail}</span>}</li>)}</ul>}
              {p.audit?.secondOpinion?.length > 0 && <div className="small"><b>A model's second opinion (not a fact):</b><ul>{p.audit.secondOpinion.map((x: string) => <li key={x}>{x}</li>)}</ul></div>}
              {p.audit?.possibleDuplicateOf && <p className="small warn">It overlaps with {p.audit.possibleDuplicateOf}. Consider improving that instead.</p>}</details>}
            <div className="row wrap">
              {p.status === 'ready' && <><button className="primary" onClick={() => void run(async () => { await confirm1(); await api(`/api/foundry/${p.id}/approve`, 'POST'); }, 'Approved. The agent is registered and its schedule is on.')}>Approve and employ…</button><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase (blank for passkey)" aria-label="Passphrase" autoComplete="current-password" /></>}
              {['ready', 'blocked', 'failed'].includes(p.status) && <button onClick={() => void run(() => api(`/api/foundry/${p.id}/reject`, 'POST'), 'Rejected.')}>Reject</button>}
              <button onClick={async () => { if (open === p.id) { setOpen(null); return; } setEv((await api(`/api/foundry/${p.id}`)).events); setOpen(p.id); }}>{open === p.id ? 'Hide log' : 'Who did what'}</button></div>
            {open === p.id && <ul className="plain small">{ev.map((e, i) => <li key={i}>{new Date(e.at).toLocaleTimeString()} · <b>{e.role}</b> · {e.kind}{e.detail ? ` · ${e.detail}` : ''}</li>)}</ul>}
          </div>))}</div>
    </section>);
}
