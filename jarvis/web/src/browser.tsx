import { useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { stepUpWithPasskey } from './passkey.ts';

const STATUS: Record<string, string> = { starting: 'Starting…', waiting_login: 'Waiting for you to log in', running: 'Looking around', done: 'Finished', stopped: 'Stopped', failed: 'Failed' };

/** The Jarvis browser: a separate window where Jarvis looks around (and clicks safe buttons) on a site you named. Start it in chat: “look around the real world”. */
export function BrowserPage() {
  const { data, reload } = useLive<any>(() => api('/api/browser'), ['browser']);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [pw, setPw] = useState('');
  if (!data) return <section className="page"><h1>Jarvis Browser</h1><p className="muted">Loading…</p></section>;
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMsg(null); try { await fn(); if (ok) setMsg({ ok: true, t: ok }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } };
  const confirm1 = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  const busy = data.runs.find((r: any) => ['starting', 'waiting_login', 'running'].includes(r.status));
  return (
    <section className="page"><h1>Jarvis Browser</h1>
      <p className="muted">A separate browser window, not your everyday Chrome. You log in there yourself, then Jarvis looks around the site you named, scrolls, opens links and clicks safe buttons, and tells you what he found. Start it in chat, for example “look around the real world and get to know it”.</p>
      <p className="muted small">He never types, submits forms, buys, sends, downloads, logs out, changes settings, or leaves the site, and he skips buttons with words like pay, delete, send, join, settings or account. Pages he reads are sent to Claude to be understood; only his short summary is kept. Limits per visit: {data.limits.steps} steps, ${(data.limits.capMicro / 1e6).toFixed(2)}, {data.limits.minutes} minutes.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      {busy && <div className="glass pad section"><b>{STATUS[busy.status]}: {busy.site}</b> <span className="muted small">step {busy.steps}</span>
        <div className="row wrap"><button className="danger" onClick={() => void run(() => api(`/api/browser/${busy.id}/stop`, 'POST', {}), 'Stopped.')}>Stop now</button></div></div>}
      <h2>Recent visits</h2>
      {data.runs.length === 0 ? <p className="muted">Nothing yet.</p> : <ul className="plain">{data.runs.map((r: any) => (
        <li key={r.id} className="glass pad section"><b>{r.site}</b> <span className="muted small">· {STATUS[r.status]} · {r.steps} steps · {usd(r.cost_micro)}</span>
          <div className="small">Goal: {r.goal}</div>
          {r.summary && <p>{r.summary}</p>}
          {r.log.length > 0 && <details><summary className="small">What he did</summary><ol className="small">{r.log.map((l: string, i: number) => <li key={i}>{l}</li>)}</ol></details>}
        </li>))}</ul>}
      <div className="glass pad section"><b>Forget my logins</b> <span className="muted small">(deletes the Jarvis browser's saved sign-ins; needs your passkey)</span>
        <div className="row wrap"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase (blank to use your passkey)" aria-label="Passphrase" autoComplete="current-password" />
          <button onClick={() => void run(async () => { await confirm1(); await api('/api/browser/forget-logins', 'POST', {}); }, 'Done. The Jarvis browser has forgotten its logins.')}>Forget logins</button></div></div>
    </section>
  );
}
