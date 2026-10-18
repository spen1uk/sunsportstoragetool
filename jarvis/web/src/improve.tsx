import { useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { stepUpWithPasskey } from './passkey.ts';

const STATUS: Record<string, string> = { proposed: 'Proposed', passed: 'Passed its checks', failed: 'Failed its checks', staged: 'Staged (switched off)', active: 'Switched on', rolled_back: 'Rolled back', rejected: 'Rejected', brief: 'Sent to a brief' };
const GAP: Record<string, string> = { failing_skill: 'A skill keeps failing', failing_workflow: 'A workflow keeps failing', failing_missions: 'Research keeps getting stuck', request: 'Asked for' };

/** Where Jarvis notices its own shortcomings and proposes fixes. Proposals are tested in a throwaway copy; only you can switch anything on. */
export function ImprovePage() {
  const { data, reload } = useLive<any>(() => api('/api/improve'), ['improve']);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [pw, setPw] = useState(''), [title, setTitle] = useState(''), [detail, setDetail] = useState(''), [busy, setBusy] = useState<string | null>(null), [open, setOpen] = useState<string | null>(null), [ev, setEv] = useState<any[]>([]), [cap, setCap] = useState('0.25');
  if (!data) return <section className="page"><h1>Improvements</h1><p className="muted">Loading…</p></section>;
  const run = async (f: () => Promise<unknown>, ok: string, key?: string) => { setMsg(null); setBusy(key ?? null); try { await f(); setMsg({ ok: true, t: ok }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { setBusy(null); } };
  const confirm1 = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  const post = (p: string, b: unknown = {}) => api(p, 'POST', b);
  const byGap = (gid: string) => data.improvements.filter((i: any) => i.gap_id === gid);
  const gaps = data.gaps.filter((g: any) => g.status === 'open'), active = data.improvements.filter((i: any) => ['proposed', 'passed', 'failed', 'staged', 'active'].includes(i.status));
  const card = (i: any) => (
    <div key={i.id} className="rcard" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
      <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{i.title}</b><span className="badge">{STATUS[i.status]}</span></div>
      <div className="muted small">{i.kind === 'workflow' ? 'A chain of skills that already exist' : 'A request for a new skill, to be written by a person'} · proposed by {i.created_by === 'luke' ? 'you asking' : i.created_by} · model cost {usd(i.cost_micro)} of {usd(i.cap_micro)}</div>
      <p className="small">{i.rationale}</p>
      {i.kind === 'workflow' && i.spec.steps && <ol className="small">{i.spec.steps.map((s: any, n: number) => <li key={n}><code>{s.skill}</code></li>)}</ol>}
      {i.kind === 'skill_request' && i.spec.needs && <p className="small"><b>It would need to:</b> {i.spec.needs}</p>}
      {i.report && <details open={!i.report.passed}><summary className="small"><b>{i.report.passed ? 'All safety checks passed' : 'Some checks failed'}</b> <span className="muted">· tested in {i.report.sandbox}</span></summary>
        <ul className="plain small">{i.report.checks.map((c: any) => <li key={c.id}>{c.passed ? '✓' : '✕'} {c.title}{!c.passed && <span className="warn"> — {c.detail}</span>}</li>)}</ul></details>}
      <div className="row wrap">
        {['proposed', 'passed', 'failed', 'staged'].includes(i.status) && i.spec && Object.keys(i.spec).length > 0 && <button disabled={busy === 't' + i.id} onClick={() => void run(() => post(`/api/improve/${i.id}/test`), 'Tested again.', 't' + i.id)}>Test again</button>}
        {i.status === 'passed' && i.kind === 'workflow' && <button className="primary" onClick={() => void run(() => post(`/api/improve/${i.id}/stage`), 'Staged. It is saved but switched off.')}>Stage it (still off)</button>}
        {i.status === 'passed' && i.kind === 'skill_request' && <button className="primary" onClick={() => void run(() => post(`/api/improve/${i.id}/brief`), 'Brief written. Find it under Integrations.')}>Write a Claude Code brief</button>}
        {i.status === 'staged' && <button className="primary" onClick={() => void run(async () => { await confirm1(); await post(`/api/improve/${i.id}/promote`); }, 'Switched on. It is watched, and switches itself off if it starts failing.')}>Switch it on…</button>}
        {i.status === 'active' && <button onClick={() => { if (confirm('Switch this off and go back to what you had?')) void run(async () => { await confirm1(); const r = await post(`/api/improve/${i.id}/rollback`); setMsg({ ok: true, t: r.restored ? 'Rolled back. The earlier workflow is on again.' : 'Rolled back.' }); }, ''); }}>Roll back…</button>}
        {['proposed', 'passed', 'failed', 'staged'].includes(i.status) && <button onClick={() => void run(() => post(`/api/improve/${i.id}/reject`), 'Rejected.')}>Reject</button>}
        <button onClick={async () => { if (open === i.id) { setOpen(null); return; } setEv((await api(`/api/improve/${i.id}`)).events); setOpen(i.id); }}>{open === i.id ? 'Hide history' : 'History'}</button></div>
      {open === i.id && <ul className="plain small">{ev.map((e, n) => <li key={n}>{new Date(e.at).toLocaleString()} · {e.kind}{e.detail ? ` · ${e.detail}` : ''}</li>)}</ul>}
    </div>);
  return (
    <section className="page"><h1>Improvements</h1>
      <p className="muted">Jarvis counts its own failures and keeps a list of where it falls short. For a gap you can ask it to draft a fix. A fix is only ever a chain of skills it already has, or a request for a person to build a new one: it never writes or installs code. Every proposal is tested in a throwaway copy with made-up data (including hostile inputs), then it waits for you. Nothing switches itself on.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      <div className="glass pad section"><h2>Your confirmation</h2><p className="muted small">Switching something on or off, or letting Prometheus draft on its own, asks once each time.</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase (blank to use your passkey)" aria-label="Passphrase" autoComplete="current-password" /></div>
      {active.length > 0 && <div className="glass pad section"><h2>Proposals</h2>{active.map(card)}</div>}
      <div className="glass pad section"><h2>Where it falls short</h2>
        {gaps.length === 0 ? <p className="muted small">Nothing found. It looks for repeated failures once a day.</p> : gaps.map((g: any) => (
          <div key={g.id} className="rcard" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
            <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{g.title}</b><span className="badge">{GAP[g.kind]}</span></div>
            {g.detail && <p className="small">{g.detail}</p>}
            <div className="row wrap">{byGap(g.id).some((i: any) => ['proposed', 'passed', 'staged'].includes(i.status)) ? <span className="muted small">A proposal is waiting above.</span> : <button className="primary" disabled={!data.modelReady || busy === g.id} onClick={() => void run(async () => { await post(`/api/improve/gaps/${g.id}/draft`, { capMicro: Math.round(Number(cap) * 1e6) }); }, 'Drafted and tested. See Proposals.', g.id)}>{busy === g.id ? 'Drafting…' : 'Draft a fix'}</button>}
              <button onClick={() => void run(() => post(`/api/improve/gaps/${g.id}/dismiss`), 'Dismissed.')}>Dismiss</button></div>
          </div>))}
        <div className="row wrap section"><label className="small">Most one draft may cost $<input value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 70 }} inputMode="decimal" aria-label="Draft spending limit in dollars" /></label>
          <button onClick={() => void run(async () => { const r = await post('/api/improve/scan'); if (!r.found) throw new Error('Nothing new found.'); }, 'New gaps found.')}>Look now</button></div>
        {!data.modelReady && <p className="small warn">No language model is connected, so drafting is unavailable.</p>}
        <h3>Something you wish it could do</h3>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Summarise my week automatically" aria-label="Wish" maxLength={120} style={{ width: '100%' }} /><textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={2} placeholder="Anything that would help (optional)" aria-label="Detail" maxLength={1000} />
        <button className="primary" disabled={title.trim().length < 6} onClick={() => void run(async () => { await post('/api/improve/gaps', { title: title.trim(), detail }); setTitle(''); setDetail(''); }, 'Added to the list.')}>Add to the list</button></div>
      <div className="glass pad section"><h2>Let Prometheus draft by itself</h2>
        <p className="muted small">Off by default. When on, it may draft at most one fix a week for a repeated problem, within the draft limit, and test it. It can only draft: staging and switching on stay yours.</p>
        <button className={data.auto ? '' : 'primary'} onClick={() => void run(async () => { if (!data.auto) await confirm1(); await api('/api/improve/settings', 'PUT', { auto: !data.auto }); }, data.auto ? 'Turned off.' : 'Turned on.')}>{data.auto ? 'Turn off' : 'Turn on…'}</button> <span className="small">{data.auto ? 'Currently on.' : 'Currently off.'}</span></div>
      {data.improvements.some((i: any) => ['rolled_back', 'rejected', 'brief'].includes(i.status)) && <details className="section"><summary><b>Finished and set aside</b></summary><div className="section">{data.improvements.filter((i: any) => ['rolled_back', 'rejected', 'brief'].includes(i.status)).map(card)}</div></details>}
    </section>);
}
