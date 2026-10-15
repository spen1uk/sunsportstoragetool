import { useState } from 'react';
import { api, useLive } from './api.ts';
import { passkeySupported, registerPasskey, onNumericAddress, stepUpWithPasskey } from './passkey.ts';

/** Settings: add, list and remove passkeys, and choose whether the passphrase may still be used to sign in. */
export function PasskeyCard() {
  const { data, reload } = useLive<any>(() => api('/api/passkeys'), []);
  const [pw, setPw] = useState(''), [name, setName] = useState('This device'), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [busy, setBusy] = useState(false);
  if (!data) return null;
  const run = async (f: () => Promise<unknown>, ok: string) => { setBusy(true); setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); reload(); } };
  const confirmFirst = async () => { if (!data.required && pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else if (data.items.length) { await stepUpWithPasskey(); setPw(''); } else throw new Error('Enter your passphrase to confirm.'); };
  const supported = passkeySupported();
  return (
    <div className="glass pad section">
      <h2>Passkeys <span className={`badge ${data.items.length ? 'connected' : 'planned'}`}>{data.items.length ? `${data.items.length} set up` : 'not set up'}</span></h2>
      <p className="muted small">Sign in with Face ID / Touch ID instead of typing the passphrase. Jarvis only keeps the public half; the secret half never leaves your device. A passkey is tied to the address you create it on: one made at <code>http://localhost:8788</code> on your Mac won't work on your server's address, so you add another there.</p>
      {onNumericAddress() && <p className="warn small">You opened Jarvis at a numeric address. Passkeys need a name, so open <code>http://localhost:8788</code> instead.</p>}
      {!supported && <p className="warn small">This browser doesn't support passkeys.</p>}
      <ul className="plain">{data.items.map((p: any) => (
        <li key={p.id} className="row"><span className="grow"><b>{p.name}</b> <span className="muted small">added {new Date(p.created_at).toLocaleDateString()} · {p.last_used_at ? `last used ${new Date(p.last_used_at).toLocaleDateString()}` : 'never used'}</span></span>
          <button disabled={busy} onClick={() => { if (confirm(`Remove "${p.name}"?`)) void run(async () => { await confirmFirst(); await api(`/api/passkeys/${encodeURIComponent(p.id)}`, 'DELETE'); }, 'Removed.'); }}>Remove</button></li>))}</ul>
      <div className="row wrap section">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Passkey name" style={{ width: 160 }} />
        <input type="password" autoComplete="current-password" placeholder={data.required ? 'Not needed: a passkey is required' : data.items.length ? 'Passphrase (or leave blank to use a passkey)' : 'Your passphrase (to confirm)'} value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Passphrase to confirm" className="grow" />
        <button className="primary" disabled={busy || !supported || onNumericAddress()} onClick={() => void run(async () => { await confirmFirst(); await registerPasskey(name); }, 'Passkey added.')}>Add a passkey</button>
      </div>
      {data.items.length > 0 && <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={data.required} disabled={busy} onChange={(e) => void run(async () => { await confirmFirst(); await api('/api/passkeys/require', 'PUT', { required: e.target.checked }); }, e.target.checked ? 'Passphrase sign-in is now off.' : 'Passphrase sign-in is back on.')} /> Require a passkey to sign in (turns the passphrase off for sign-in)</label>}
      {data.required && <p className="muted small">If you ever lose every passkey, on the machine itself run <code>npm run setup -- --allow-passphrase</code> to turn the passphrase back on.</p>}
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
    </div>
  );
}

/** Settings: are encrypted backups happening, and have you practised restoring one? */
export function BackupCard() {
  const { data } = useLive<any>(() => api('/api/backups'), []);
  if (!data) return null;
  const when = (t: number) => new Date(t).toLocaleString(); const age = data.last ? Date.now() - data.last.at : null;
  const stale = age === null || age > 36 * 3_600_000, noDrill = !data.drill;
  return (
    <div className="glass pad section">
      <h2>Encrypted backups <span className={`badge ${!data.hasKey || stale ? 'planned' : 'connected'}`}>{!data.hasKey ? 'no key yet' : data.last ? (stale ? 'overdue' : 'up to date') : 'none yet'}</span></h2>
      <p className="muted small">Backups are locked with a public key, so a stolen backup file or server can't open them. Only your recovery key can. It's created once and shown once; keep it in a password manager.</p>
      <ul className="plain small">
        <li>Last backup: {data.last ? <b>{when(data.last.at)}</b> : <span className="warn">never</span>}{data.last && <span className="muted"> · {Math.round(data.last.bytes / 1024)} KB · keeping {data.last.kept}</span>}{data.last && !data.last.auditChainOk && <span className="err"> · the activity log in it failed its tamper check</span>}</li>
        <li>Last restore practice: {data.drill ? <b>{when(data.drill.at)}</b> : <span className="warn">never. A backup you've never restored is only a hope.</span>}</li>
      </ul>
      {!data.hasKey && <p className="warn small">Set up the key: in the jarvis folder run <code>npm run backup:keygen</code>, and save the recovery key it prints.</p>}
      {data.hasKey && (stale || noDrill) && <p className="small muted">Make a backup: <code>npm run backup -- --to &lt;a folder&gt;</code>. Practise restoring: <code>npm run backup:drill -- &lt;backup file&gt;</code>. The server setup guide shows how to run the backup daily.</p>}
      <p className="muted small">The settings, your Anthropic key and passkeys' private halves are not in backups: keys stay in <code>data/secrets.json</code> (re-enter if lost), and private halves never leave your devices.</p>
    </div>
  );
}

/** Settings: a plain-English health check, and whether anything outside Jarvis will tell you if it stops. */
export function HealthCard() {
  const { data } = useLive<any>(() => api('/api/health/detail'), ['system']);
  if (!data) return null;
  const bad = data.checks.filter((c: any) => !c.ok);
  return (
    <div className="glass pad section">
      <h2>Health <span className={`badge ${bad.length ? 'planned' : 'connected'}`}>{bad.length ? `${bad.length} to look at` : 'all good'}</span></h2>
      <ul className="plain small">{data.checks.map((c: any) => <li key={c.key}>{c.ok ? '✓' : '⚠'} <b>{c.label}</b> <span className={c.ok ? 'muted' : 'warn'}>— {c.detail}</span></li>)}</ul>
      {!data.heartbeat.configured && <p className="muted small">Jarvis can't tell you it has died. To get an outside alert if it ever stops, set <code>JARVIS_HEARTBEAT_URL</code> to a ping address from a free "dead-man's-switch" service (see docs/DEPLOY.md). Your Mac helper also shows a notification if the server stops answering.</p>}
      {data.heartbeat.configured && <p className="muted small">Checking in with <b>{data.heartbeat.host}</b> every 5 minutes. If the check-ins stop, that service alerts you.</p>}
    </div>
  );
}

/** Settings: phone / car / text / voice clients that may talk to Jarvis, each with its own revocable token and narrow scopes. */
export function DevicesCard() {
  const { data, reload } = useLive<any>(() => api('/api/devices'), []);
  const [name, setName] = useState(''), [kind, setKind] = useState('phone'), [pw, setPw] = useState(''), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [limit, setLimit] = useState('10'), [token, setToken] = useState<string | null>(null), [preview, setPreview] = useState<any>(null), [busy, setBusy] = useState(false);
  if (!data) return null;
  const run = async (f: () => Promise<unknown>, ok: string) => { setBusy(true); setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); reload(); } };
  const confirmFirst = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  const active = data.items.filter((d: any) => d.status === 'active');
  return (
    <div className="glass pad section">
      <h2>Devices <span className={`badge ${active.length ? 'connected' : 'planned'}`}>{active.length ? `${active.length} active` : 'none yet'}</span></h2>
      <p className="muted small">Each phone, car screen, text line or voice client gets its own key. A device can chat, hear the greeting and see the glance line. It can never confirm an action, change settings, or read your files; anything it proposes waits here for you. Each has a monthly spend limit (default $10); at the limit it stops answering until next month or until you raise its limit (raising needs your passphrase or passkey; lowering doesn't). Remove one and it stops working at once.</p>
      <ul className="plain">{active.map((d: any) => (
        <li key={d.id} className="row"><span className="grow"><b>{d.name}</b> <span className="muted small">{d.kind} · {(d.scopes || []).join(', ')} · ${(d.spentMicroUsd / 1e6).toFixed(2)} of ${(d.monthlyLimitMicroUsd / 1e6).toFixed(2)} this month · {d.lastSeen ? `last seen ${new Date(d.lastSeen).toLocaleString()}` : 'never used'}</span></span>
          <button disabled={busy} onClick={() => { const v = prompt(`Monthly limit for "${d.name}" in dollars (0.50 to 50). Raising it needs your passphrase or passkey.`, String(d.monthlyLimitMicroUsd / 1e6)); if (v === null) return; const n = Number(v); if (!(n >= 0.5 && n <= 50)) { setMsg({ ok: false, t: 'Enter a number from 0.50 to 50.' }); return; } void run(async () => { if (n * 1e6 > d.monthlyLimitMicroUsd) await confirmFirst(); await api(`/api/devices/${encodeURIComponent(d.id)}/limit`, 'PUT', { monthlyLimitUsd: n }); }, 'Limit updated.'); }}>Limit</button>
          <button disabled={busy} onClick={() => { if (confirm(`Remove "${d.name}"?`)) void run(() => api(`/api/devices/${encodeURIComponent(d.id)}`, 'DELETE'), 'Removed.'); }}>Remove</button></li>))}</ul>
      <div className="row wrap section">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Name, e.g. Luke's iPhone" aria-label="Device name" style={{ width: 190 }} />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Device kind">{data.kinds.map((k: string) => <option key={k}>{k}</option>)}</select>
        <input type="number" min={0.5} max={50} step={0.5} value={limit} onChange={(e) => setLimit(e.target.value)} aria-label="Monthly limit in dollars" title="Monthly spend limit ($)" style={{ width: 80 }} />
        <input type="password" autoComplete="current-password" placeholder="Passphrase (blank to use a passkey)" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Passphrase to confirm" className="grow" />
        <button className="primary" disabled={busy || !name.trim()} onClick={() => void run(async () => { await confirmFirst(); const r = await api('/api/devices', 'POST', { name: name.trim(), kind, monthlyLimitUsd: Number(limit) || 10 }); setToken((r as any).token); setName(''); }, 'Device added. Copy its key now.')}>Add device</button>
      </div>
      {token && <p className="warn small">Key (shown once, keep it in a password manager): <code>{token}</code></p>}
      <div className="row wrap"><button onClick={() => void api('/api/greeting').then(setPreview).catch(() => setPreview(null))}>Preview greeting</button><button onClick={() => void api('/api/greeting?profile=glance').then(setPreview).catch(() => setPreview(null))}>Preview car glance</button></div>
      {preview && <p className="small" role="status">“{preview.speak}”</p>}
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
    </div>
  );
}
