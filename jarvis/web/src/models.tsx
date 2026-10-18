import { useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { stepUpWithPasskey } from './passkey.ts';

const TASK: Record<string, string> = { chat: 'Everyday chat', analysis: 'Analysis and planning', ping: 'Connection test', web: 'Web search answers' };
const pct = (n: number) => `${Math.round(n * 100)}%`;
const cost = (m: number) => `$${(m / 1e6).toFixed(m < 10_000 ? 4 : 3)}`;

/** Which model does what, what it costs, what has been measured, and what you have allowed. Changes need your passphrase or passkey. */
export function ModelsPage() {
  const { data, reload } = useLive<any>(() => api('/api/models'), ['models', 'llm']);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [pw, setPw] = useState(''), [sel, setSel] = useState({ task: 'chat', model: 'claude-haiku-5-5', provider: 'anthropic' }), [cap, setCap] = useState('0.50'), [est, setEst] = useState<any>(null), [open, setOpen] = useState<string | null>(null), [detail, setDetail] = useState<any>(null);
  if (!data) return <section className="page"><h1>Models</h1><p className="muted">Loading…</p></section>;
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } };
  const confirm1 = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  const connected = data.providers.filter((p: any) => p.connected);
  return (
    <section className="page"><h1>Models</h1>
      <p className="muted">Jarvis picks a language model for each kind of job, cheapest first, and falls back to the next if one fails. Here you can see what is used, measure models on a fixed set of public practice questions, and change the order. Nothing is sent to a vendor you have not approved, and the practice questions contain none of your information.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      <div className="glass pad section"><h2>Your confirmation</h2><p className="muted small">Changing a route, approving a provider or running a test spends or exposes something, so it asks once each time.</p>
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase (blank to use your passkey)" aria-label="Passphrase" autoComplete="current-password" /></div>

      <div className="glass pad section"><h2>Which model does what</h2>
        {data.routes.map((r: any) => (
          <div key={r.task} className="rcard" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
            <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{TASK[r.task]}</b>{r.overridden && <span className="badge">Your order</span>}</div>
            <ol className="small">{r.effective.map((c: any) => <li key={c.provider + c.model}>{c.model} <span className="muted">({c.provider})</span></li>)}</ol>
            <p className="muted small">Tried in this order. If a model fails three times in a row, it is tried last for ten minutes.</p>
            {data.recommendations.filter((x: any) => x.task === r.task).map((x: any) => <div key={x.task} className="small">{x.suggestion ? <><b>Suggestion:</b> {x.reason} <button className="primary" onClick={() => void run(async () => { await confirm1(); const rest = r.effective.filter((c: any) => c.model !== x.suggestion.model); const best = { ...(r.effective[0]), provider: x.suggestion.provider, model: x.suggestion.model }; await api(`/api/models/routes/${r.task}`, 'PUT', { candidates: [best, ...rest].slice(0, 4) }); }, 'Saved. It will be used from the next request.')}>Make it first choice</button></> : <span className="muted">{x.reason}</span>}</div>)}
            <div className="row wrap">{r.task !== 'ping' && <><select aria-label={`Add model for ${r.task}`} id={`add-${r.task}`} defaultValue="" style={{ width: 'auto' }}><option value="">Add or move a model first…</option>{data.knownModels.map((m: any) => <option key={m.model} value={m.model}>{m.model}</option>)}</select>
              <button onClick={() => { const el = document.getElementById(`add-${r.task}`) as HTMLSelectElement; if (!el.value) return; const prov = el.value.startsWith('claude') ? 'anthropic' : connected.find((p: any) => p.approved && p.id !== 'anthropic')?.id ?? 'anthropic'; const first = { provider: prov, model: el.value, effort: r.effective[0]?.effort ?? 'low', maxTokens: r.effective[0]?.maxTokens ?? 700 }; void run(async () => { await confirm1(); await api(`/api/models/routes/${r.task}`, 'PUT', { candidates: [first, ...r.effective.filter((c: any) => c.model !== el.value)].slice(0, 4) }); }, 'Saved.'); }}>Put first</button></>}
              {r.overridden && <button onClick={() => void run(() => api(`/api/models/routes/${r.task}`, 'DELETE'), 'Back to the built-in order.')}>Reset to built-in</button>}</div>
          </div>))}
      </div>

      <div className="glass pad section"><h2>Providers</h2>
        <ul className="plain small">{data.providers.map((p: any) => <li key={p.id} className="row wrap" style={{ alignItems: 'center' }}><span className="grow"><b>{p.label}</b> · {p.connected ? (p.configured ? 'connected' : 'built in, no key set') : 'not connected (nothing is sent to it)'} · {p.approved ? (p.allowPrivate ? 'approved, may see private text' : 'approved for practice questions and non-private jobs only') : 'not approved'}</span>
          {p.connected && p.id !== 'anthropic' && <><button onClick={() => void run(async () => { await confirm1(); await api(`/api/models/providers/${p.id}`, 'PUT', { approved: !p.approved, allowPrivate: false }); }, p.approved ? 'Approval withdrawn.' : 'Approved for practice questions and non-private jobs.')}>{p.approved ? 'Withdraw approval' : 'Approve'}</button>
            {p.approved && <button onClick={() => void run(async () => { await confirm1(); await api(`/api/models/providers/${p.id}`, 'PUT', { approved: true, allowPrivate: !p.allowPrivate }); }, 'Updated.')}>{p.allowPrivate ? 'Stop allowing private text' : 'Allow private text'}</button>}</>}
        </li>)}</ul>
        <p className="muted small">Other vendors (OpenAI, Google, xAI, Perplexity) are shown so you can see what is possible, but none is connected. Adding one needs reviewed code, your own API key set on the server, a price check and a look at its data-retention terms first, and then your approval here.</p></div>

      <div className="glass pad section"><h2>Measure a model</h2>
        <p className="muted small">Runs {data.cases.length} fixed public questions (arithmetic, sticking to a format, resisting hidden instructions, admitting what it does not know, clean JSON…). Each is scored by rules, not by another model. It costs real money, so you see the worst case first and it stops at the limit you set.</p>
        <div className="row wrap"><select value={sel.task} onChange={(e) => { setSel({ ...sel, task: e.target.value }); setEst(null); }} aria-label="Kind of job" style={{ width: 'auto' }}><option value="chat">Everyday chat</option><option value="analysis">Analysis and planning</option></select>
          <select value={`${sel.provider}/${sel.model}`} onChange={(e) => { const [provider, model] = e.target.value.split('/'); setSel({ ...sel, provider, model }); setEst(null); }} aria-label="Model" style={{ width: 'auto' }}>{connected.filter((p: any) => p.approved).flatMap((p: any) => data.knownModels.filter((m: any) => p.id !== 'anthropic' || m.model.startsWith('claude')).map((m: any) => <option key={p.id + m.model} value={`${p.id}/${m.model}`}>{m.model}</option>))}</select>
          <label className="small">Limit $<input value={cap} onChange={(e) => setCap(e.target.value)} style={{ width: 70 }} inputMode="decimal" aria-label="Spending limit in dollars" /></label>
          <button onClick={() => void run(async () => setEst(await api('/api/models/eval/estimate', 'POST', sel)), '')}>Show worst-case cost</button>
          <button className="primary" disabled={!est || !!est.refusal} onClick={() => void run(async () => { await confirm1(); await api('/api/models/eval', 'POST', { ...sel, capMicro: Math.round(Number(cap) * 1e6) }); }, 'Started. Results appear below in a minute or so.')}>Run it</button></div>
        {est && <p className={est.refusal ? 'err small' : 'small'}>{est.refusal ?? `Up to ${cost(est.microUsd)} for ${est.cases} questions (usually much less).`}</p>}
        {data.runs.length > 0 && <table className="small" style={{ width: '100%' }}><thead><tr><th align="left">When</th><th align="left">Model</th><th align="left">Job</th><th>Score</th><th>Speed</th><th>Cost</th><th /></tr></thead><tbody>{data.runs.map((r: any) => (
          <tr key={r.id}><td>{new Date(r.at).toLocaleDateString()}</td><td>{r.model}</td><td>{TASK[r.task]}</td>
            <td align="center">{r.status === 'running' ? 'running…' : r.status === 'done' ? pct(r.avg_score) : `${r.status}${r.ran ? ` (${r.ran}/${r.cases})` : ''}`}</td><td align="center">{r.avg_latency_ms ? `${(r.avg_latency_ms / 1000).toFixed(1)}s` : '–'}</td><td align="center">{cost(r.cost_micro)}</td>
            <td><button onClick={async () => { if (open === r.id) { setOpen(null); return; } setDetail(await api(`/api/models/eval/${r.id}`)); setOpen(r.id); }}>{open === r.id ? 'Hide' : 'Details'}</button></td></tr>))}</tbody></table>}
        {open && detail?.run.id === open && <ul className="plain small">{detail.results.map((x: any) => <li key={x.case_id}>{x.score >= 1 ? '✓' : '✕'} {data.cases.find((c: any) => c.id === x.case_id)?.title ?? x.case_id}{x.score < 1 && <span className="muted"> — {x.detail}</span>}</li>)}{detail.run.error && <li className="warn">Stopped: {detail.run.error}</li>}</ul>}
        <p className="muted small">Only complete runs count. A model needs at least {pct(data.threshold)} to be suggested, and suggestions only ever change anything when you press the button.</p></div>

      <div className="glass pad section"><h2>How models have done in real use <span className="muted small">(last 30 days)</span></h2>
        {data.live.length === 0 ? <p className="muted small">No model calls yet.</p> : <table className="small" style={{ width: '100%' }}><thead><tr><th align="left">Model</th><th>Calls</th><th>Failures</th><th>Avg speed</th><th>Spent</th></tr></thead><tbody>{data.live.map((l: any) => <tr key={l.provider + l.model}><td>{l.model}</td><td align="center">{l.calls}</td><td align="center">{l.failures}</td><td align="center">{l.avgLatencyMs ? `${(l.avgLatencyMs / 1000).toFixed(1)}s` : '–'}</td><td align="center">{usd(l.costMicro)}</td></tr>)}</tbody></table>}</div>
    </section>);
}
