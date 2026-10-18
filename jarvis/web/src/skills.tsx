import { Fragment, useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { stepUpWithPasskey } from './passkey.ts';

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never');
const TIER = ['0 read-only', '1 internal change', '2 publishes internally', '3 needs approval', '4 money / control'];
const EXAMPLE = JSON.stringify([{ skill: 'docs.extract_text', input: { html: '<p>Hello</p>' } }], null, 1);

/** The Skills Command Center: every capability agents have, who may use it, which version is live, and what happened. */
export function SkillsPage() {
  const { data, reload } = useLive<any>(() => api('/api/skills'), ['approvals', 'system']);
  const [open, setOpen] = useState<string | null>(null), [det, setDet] = useState<any>(null), [pw, setPw] = useState(''), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [filter, setFilter] = useState('all'), [q, setQ] = useState('');
  const [testIn, setTestIn] = useState('{}'), [testOut, setTestOut] = useState(''), [wname, setWname] = useState(''), [wsteps, setWsteps] = useState(EXAMPLE), [wcheck, setWcheck] = useState<any>(null);
  if (!data) return <section className="page"><h1>Skills</h1><p className="muted">Loading…</p></section>;
  const confirmFirst = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  const run = async (f: () => Promise<unknown>, ok: string, needStep = false) => { setMsg(null); try { if (needStep) await confirmFirst(); await f(); setMsg({ ok: true, t: ok }); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { reload(); if (open) void api(`/api/skills/${open}`).then(setDet).catch(() => {}); } };
  const toggle = async (id: string) => { if (open === id) { setOpen(null); return; } setOpen(id); setDet(null); setTestOut(''); setTestIn('{}'); setDet(await api(`/api/skills/${id}`)); };
  const rows = data.skills.filter((s: any) => (filter === 'all' || (filter === 'direct' && s.runPath === 'direct') || (filter === 'approval' && s.tier >= 3) || (filter === 'off' && s.status !== 'active') || filter === s.owner) && (!q || (s.id + s.title + s.purpose).toLowerCase().includes(q.toLowerCase())));
  return (
    <section className="page"><h1>Skills</h1>
      <p className="muted">Every capability Jarvis and Prometheus have, in one registry. A skill's definition lives in the code (reviewed and tested); here you decide who may use it, switch it off, or roll it back. Agents can never grant themselves anything. Skills that send, spend, delete or widen access (tier 3+) are only ever approval requests and can never be given to an agent.</p>
      <div className="glass pad section">
        <div className="row wrap">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills" aria-label="Search skills" style={{ width: 200 }} />
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter" style={{ width: 'auto' }}><option value="all">All</option><option value="direct">Run by the registry</option><option value="approval">Tier 3+ (approval only)</option><option value="off">Switched off</option><option value="jarvis">Owned by Jarvis</option><option value="prometheus">Owned by Prometheus</option></select>
          <input type="password" autoComplete="current-password" placeholder="Passphrase for changes (blank = passkey)" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Passphrase to confirm" className="grow" />
        </div>
        {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
        <table className="small section"><thead><tr><th>Skill</th><th>Owner</th><th>Ver</th><th>Tier</th><th>Effects / data</th><th>Who may use it</th><th>Runs</th><th></th></tr></thead><tbody>
          {rows.map((s: any) => (<Fragment key={s.id}>
            <tr><td><b>{s.title}</b><div className="muted">{s.id}{s.status !== 'active' && <span className="warn"> · OFF</span>}</div></td><td>{s.owner}</td><td>{s.version}</td><td>{s.tier}</td>
              <td>{s.sideEffects}{s.untrustedOutput ? ' · web content' : ''}<div className="muted">{s.dataSensitivity} data</div></td>
              <td>{data.principals.map((p: any) => { const a = s.access[p.id]; return <div key={p.id} title={a.reasons.join('; ')}>{a.allowed ? '✓' : '·'} {p.label}{a.allowed ? ` (${a.via})` : ''}</div>; })}</td>
              <td>{s.stats.runs}{s.stats.refused ? <span className="muted"> ({s.stats.refused} refused)</span> : null}</td><td><button onClick={() => void toggle(s.id)}>{open === s.id ? 'Close' : 'Open'}</button></td></tr>
            {open === s.id && <tr><td colSpan={8}>{!det ? 'Loading…' : (
              <div className="small">
                <p>{s.purpose}</p>
                <p className="muted">Runs via: <b>{s.runPath}</b>{s.runPath !== 'direct' ? ' (its existing, separately tested path; this registry lists and governs it)' : ''} · Tier {TIER[s.tier]} · Needs: {s.permissions.join(', ') || 'nothing'} · Cost: {s.cost.perCallMicroUsd ? usd(s.cost.perCallMicroUsd) + '/call' : 'free'} {s.cost.note} · Services: {s.externalServices.join(', ') || 'none'} · Trust: {s.trust} · Tests: {s.tests.join(', ') || '—'}</p>
                <p className="muted">Returns: {s.outputDescription}. {s.docs}</p>
                <div className="row wrap">
                  {s.status === 'active' ? <button onClick={() => void run(() => api(`/api/skills/${s.id}/status`, 'POST', { status: 'disabled' }), 'Switched off.')}>Switch off</button> : <button className="primary" onClick={() => void run(() => api(`/api/skills/${s.id}/status`, 'POST', { status: 'active' }), 'Switched on.', true)}>Switch on (needs confirmation)</button>}
                  {data.principals.map((p: any) => s.grants.includes(p.id) ? <button key={p.id} onClick={() => void run(() => api(`/api/skills/${s.id}/grant/${p.id}`, 'DELETE'), `Removed from ${p.label}.`)}>Remove from {p.label}</button> : (!s.access[p.id].allowed && s.tier < 3 && !s.access[p.id].reasons.some((r: string) => /cannot hold|ceiling/.test(r)) && <button key={p.id} onClick={() => void run(() => api(`/api/skills/${s.id}/grant`, 'POST', { principal: p.id }), `Granted to ${p.label}.`, true)}>Give to {p.label}…</button>))}
                </div>
                {det.versions.length > 1 && <p>Versions: {det.versions.map((v: any) => <span key={v.version} style={{ marginRight: 10 }}>{v.version} ({v.status}) {v.status !== 'active' && <button onClick={() => void run(() => api(`/api/skills/${s.id}/activate`, 'POST', { version: v.version }), `Version ${v.version} is now live.`, true)}>{v.status === 'staged' ? 'Activate' : 'Roll back to this'}</button>}</span>)}</p>}
                {s.testable && <div><b>Test run</b> (read-only; nothing is changed)<div className="row wrap"><input value={testIn} onChange={(e) => setTestIn(e.target.value)} className="grow" aria-label="Test input as JSON" /><button onClick={async () => { try { setTestOut(JSON.stringify(await api(`/api/skills/${s.id}/test`, 'POST', { input: JSON.parse(testIn || '{}') }), null, 1).slice(0, 1500)); } catch (e) { setTestOut(e instanceof Error ? e.message : String(e)); } }}>Run</button></div>{testOut && <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{testOut}</pre>}</div>}
                <p><b>History</b></p>{det.history.length === 0 ? <p className="muted">No changes recorded.</p> : <ul className="plain">{det.history.slice(0, 8).map((h: any, i: number) => <li key={i} className="muted">{new Date(h.at).toLocaleString()} · {h.actor} · {h.action.replace('skill.', '')} {h.detail && h.detail !== '{}' ? h.detail : ''}</li>)}</ul>}
                {det.recentRuns.length > 0 && <><p><b>Recent runs</b> (what was asked or returned is never stored)</p><ul className="plain">{det.recentRuns.slice(0, 6).map((r: any, i: number) => <li key={i} className="muted">{when(r.at)} · {r.principal} · {r.ok ? `ok ${r.ms} ms` : r.refused ? `refused: ${r.refused}` : `failed: ${r.error}`}</li>)}</ul></>}
              </div>)}</td></tr>}
          </Fragment>))}
        </tbody></table>
      </div>
      <div className="glass pad section"><h2>Workflows</h2>
        <p className="muted small">A saved chain of skills. Combining skills never loosens anything: it needs the union of their permissions, takes the highest tier, can only be run by an agent that may use every step, and data from the web can only flow into steps with no side effects. New chains start <b>staged</b>; you activate them. Only chains of plain read/compute registry skills can run.</p>
        {data.workflows.length === 0 ? <p className="muted small">None yet.</p> : <ul className="plain small">{data.workflows.map((w: any) => <li key={w.id} className="row wrap"><span className="grow"><b>{w.name}</b> · {w.status} · {w.steps.map((s: any) => s.skill).join(' → ')} · tier {w.effective.tier}, {w.effective.sideEffects}, {w.effective.dataSensitivity}{w.effective.runnable ? '' : ' · cannot be run by the workflow runner'}</span>
          {w.status !== 'active' ? <button onClick={() => void run(() => api(`/api/skills/workflows/${w.id}/status`, 'POST', { status: 'active' }), 'Activated.', true)}>Activate…</button> : <><button onClick={() => void run(async () => { const r = await api(`/api/skills/workflows/${w.id}/run`, 'POST', {}); if (!r.ok) throw new Error(r.error); }, 'Ran. (Results are not stored.)')}>Run</button><button onClick={() => void run(() => api(`/api/skills/workflows/${w.id}/status`, 'POST', { status: 'disabled' }), 'Disabled.')}>Disable</button></>}
          <button onClick={() => { if (confirm('Delete this workflow?')) void run(() => api(`/api/skills/workflows/${w.id}`, 'DELETE'), 'Deleted.'); }}>Delete</button></li>)}</ul>}
        <div className="section"><input value={wname} onChange={(e) => setWname(e.target.value)} placeholder="Workflow name" aria-label="Workflow name" style={{ width: 220 }} />
          <textarea value={wsteps} onChange={(e) => setWsteps(e.target.value)} rows={6} aria-label="Workflow steps as JSON" style={{ width: '100%', fontFamily: 'monospace' }} />
          <div className="row wrap"><button onClick={async () => { try { setWcheck(await api('/api/skills/workflows/validate', 'POST', { steps: JSON.parse(wsteps) })); } catch (e) { setWcheck({ ok: false, violations: [e instanceof Error ? e.message : String(e)] }); } }}>Check</button>
            <button className="primary" disabled={!wname.trim()} onClick={() => void run(async () => { await api('/api/skills/workflows', 'POST', { name: wname, steps: JSON.parse(wsteps) }); setWname(''); }, 'Saved as staged.')}>Save (staged)</button></div>
          {wcheck && <p className={wcheck.ok ? 'ok small' : 'err small'}>{wcheck.ok ? `Passes. Needs ${wcheck.effective.permissions.join(', ') || 'nothing'}; tier ${wcheck.effective.tier}; ${wcheck.effective.sideEffects}; ${wcheck.effective.dataSensitivity} data${wcheck.effective.untrusted ? '; includes web content' : ''}.` : wcheck.violations.join(' ')}</p>}
        </div>
      </div>
    </section>
  );
}
