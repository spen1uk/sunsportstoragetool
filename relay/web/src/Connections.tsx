import { useCallback, useEffect, useState } from 'react';
import { get, post, api, fmtTime } from './api';
import type { Me } from './App';

const STATE: Record<string, [string, string]> = { 'verified-docs': ['Verified in docs', 'info'], 'sandbox-tested': ['Sandbox-tested', 'good'], 'production-tested': ['Production-tested', 'good'], unsupported: ['Not supported', 'bad'], 'pending-investigation': ['Not yet verified', 'warn'] };
const IMPL: Record<string, string> = { complete: 'Working', sandbox: 'Demo/sandbox only', helper: 'Building block only', 'not-built': 'Not built — setup required' };
const CONN: Record<string, [string, string]> = { connected: ['Connected', 'good'], needs_reauth: ['Needs re-authorization', 'bad'], error: ['Errors — check', 'bad'], disconnected: ['Disconnected', ''], revoked: ['Revoked', ''] };

export function Connections({ me }: { me: Me }) {
  const [list, setList] = useState<any[] | null>(null); const [open, setOpen] = useState<string | null>(null); const [err, setErr] = useState(''); const admin = me.user.role === 'owner' || me.user.role === 'admin';
  const load = useCallback(() => get('/api/integrations').then(setList).catch((e) => setErr(e.message)), []); useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <h2>Connections</h2>
      <p className="muted small">A card here is <b>not</b> proof that a service works. Each integration shows what is verified, what is only sandbox-tested, and what is blocked. Read and write access are separate; writes stay off until an admin turns them on. Nothing real is connected yet — only sandbox demos can be.</p>
      {err && <p className="error" role="alert">{err}</p>}
      {list === null ? <p className="muted">Loading…</p> : list.map((e) => (
        <div key={e.id} className="card section">
          <div className="rowtop"><b>{e.name}</b><span className="chips"><span className={`chip ${e.implementation === 'complete' ? 'good' : e.implementation === 'not-built' ? 'warn' : 'info'}`}>{IMPL[e.implementation]}</span>{e.connection && <span className={`chip ${CONN[e.connection.status]?.[1]}`}>{CONN[e.connection.status]?.[0] ?? e.connection.status}</span>}</span></div>
          <div className="small">{e.summary}</div>
          {e.connection?.status === 'needs_reauth' && <div className="banner bad" role="alert">Authorization expired or was revoked: {e.connection.lastError}. Reconnect to resume — syncing is paused and no data is lost.</div>}
          {e.connection && e.connection.status !== 'disconnected' && <div className="small muted">Account: {e.connection.account ?? '—'} · last successful sync: {e.connection.lastSuccessSyncAt ? fmtTime(e.connection.lastSuccessSyncAt) : 'never'}{e.connection.tokenExpiresAt ? ` · token expires ${fmtTime(e.connection.tokenExpiresAt)}` : ''}{e.connection.lastError && e.connection.status !== 'needs_reauth' ? ` · last error: ${e.connection.lastError}` : ''}</div>}
          <button className="linkbtn" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide details' : 'Capabilities, requirements & blockers'}</button>
          {open === e.id && <Detail e={e} />}
          {admin && <Actions e={e} reload={load} />}
        </div>))}
      {admin && <Webhooks />}
    </div>
  );
}

function Detail({ e }: { e: any }) {
  return (
    <div className="pad">
      <table className="tbl"><thead><tr><th>Capability</th><th>Access</th><th>Evidence</th></tr></thead><tbody>{e.capabilities.map((c: any) => <tr key={c.id}><td>{c.label}{c.note && <div className="small muted">{c.note}</div>}{c.scopes && <div className="small muted">scopes: {c.scopes.join(', ')}</div>}</td><td>{c.read ? 'read' : ''}{c.read && c.write ? ' + ' : ''}{c.write ? 'write' : ''}</td><td><span className={`chip ${STATE[c.state][1]}`}>{STATE[c.state][0]}</span></td></tr>)}</tbody></table>
      <b className="small">Account requirements</b><ul className="small">{e.accountRequirements.map((r: string) => <li key={r}>{r}</li>)}</ul>
      <p className="small"><b>Cost:</b> {e.costs} · <b>Tests:</b> {e.tests}</p>
      {e.blockers.length > 0 && <><b className="small">Blockers</b><ul className="small">{e.blockers.map((r: string) => <li key={r}>{r}</li>)}</ul></>}
      {e.sources.length > 0 && <p className="small muted">Sources (researched 2026-10-13): {e.sources.map((s: any) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title}</a>).reduce((a: any, b: any) => [a, ' · ', b])}</p>}
    </div>
  );
}

function Actions({ e, reload }: { e: any; reload: () => void }) {
  const [creds, setCreds] = useState(''); const [msg, setMsg] = useState(''); const [form, setForm] = useState(false); const c = e.connection;
  const defaults: Record<string, string> = { demo_pay: '{"apiKey":"demo_key_1","webhookSecret":"whsec_demo_secret_123"}', demo_reviews: '{"accessToken":"at_1","refreshToken":"rt_1"}' };
  const run = async (fn: () => Promise<unknown>) => { setMsg(''); try { await fn(); reload(); setForm(false); } catch (x: any) { setMsg(x.message); } };
  if (!e.connectable) return <p className="small muted">Cannot be connected yet: {e.blockers[0] ?? 'no adapter exists'}.</p>;
  const live = c && c.status !== 'disconnected' && c.status !== 'revoked';
  return (
    <div>
      {live ? <div className="btns">
        <label className="inline"><input type="checkbox" checked={c.readEnabled} onChange={(x) => run(() => post(`/api/connections/${c.id}/permissions`, { read: x.target.checked }))} /> Read</label>
        {e.canWrite && <label className="inline"><input type="checkbox" checked={c.writeEnabled} disabled={c.status !== 'connected'} onChange={(x) => { if (!x.target.checked || confirm('Allow Relay to make changes at this provider (e.g. post replies, create payment links)? Every public/financial action still needs a person to approve it.')) run(() => post(`/api/connections/${c.id}/permissions`, { write: x.target.checked })); }} /> Write</label>}
        <button onClick={() => run(() => (e.id.startsWith('demo_') ? post('/api/dev/sandbox/sync', { connectionId: c.id }) : post(`/api/connections/${c.id}/sync`)))}>Sync now</button>
        {e.id === 'demo_reviews' && <button onClick={() => run(() => post('/api/dev/sandbox/reviews', { count: 4 }))}>Sandbox: add sample reviews</button>}
        <button onClick={() => { setForm(true); setCreds(defaults[e.id] ?? '{}'); }}>{c.status === 'needs_reauth' ? 'Re-authorize' : 'Update credentials'}</button>
        <button onClick={() => { if (confirm('Disconnect? Stored credentials are destroyed immediately.')) run(() => post(`/api/connections/${c.id}/disconnect`)); }}>Disconnect</button></div>
        : <button className="primary" onClick={() => { setForm(true); setCreds(defaults[e.id] ?? '{}'); }}>Connect</button>}
      {form && <div className="card pad"><label>Credentials (JSON). Stored encrypted; never shown again.<textarea rows={3} value={creds} onChange={(x) => setCreds(x.target.value)} /></label>
        <p className="small muted">Sandbox demo values are pre-filled. Real providers will use their own OAuth/API-key flow.</p>
        <button className="primary" onClick={() => run(async () => { const credentials = JSON.parse(creds); if (live) await post(`/api/connections/${c.id}/reauthorize`, { credentials }); else await post(`/api/integrations/${e.id}/connect`, { credentials }); })}>{live ? 'Save & resume' : 'Verify & connect'}</button> <button onClick={() => setForm(false)}>Cancel</button></div>}
      {msg && <p className="error" role="alert">{msg}</p>}
    </div>
  );
}

function Webhooks() {
  const [subs, setSubs] = useState<any[]>([]); const [eps, setEps] = useState<any[]>([]); const [url, setUrl] = useState(''); const [evs, setEvs] = useState('*'); const [content, setContent] = useState(false); const [secret, setSecret] = useState<{ what: string; value: string } | null>(null); const [err, setErr] = useState(''); const [name, setName] = useState('');
  const load = useCallback(() => { get('/api/webhooks').then(setSubs); get('/api/inbound-endpoints').then(setEps); }, []); useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>) => { setErr(''); try { const r = await fn(); load(); return r; } catch (x: any) { setErr(x.message); } };
  return (
    <section className="card section"><h3>Webhooks</h3>
      <p className="small muted">For other services you use. Outbound destinations must be public HTTPS addresses — private/internal addresses are refused. Events carry IDs and statuses only unless you tick “include content”. Signing details: docs/WEBHOOKS.md.</p>
      {secret && <div className="banner warn" role="alert"><b>{secret.what} — copy it now, it is shown only once:</b> <code>{secret.value}</code> <button onClick={() => setSecret(null)}>Done</button></div>}
      {err && <p className="error" role="alert">{err}</p>}
      <h4>Outbound event subscriptions</h4>
      {subs.map((s) => <div key={s.id} className="trow"><div><b className="small">{s.url}</b> {!s.active && <span className="chip bad">disabled: {s.disabled_reason}</span>}<div className="small muted">{s.events.join(', ')}{s.include_content ? ' · includes content' : ''} · {s.pending} pending · {s.dead} dead</div></div>
        <div className="btns"><button onClick={() => run(() => post(`/api/webhooks/${s.id}/ping`))}>Send test</button><button onClick={() => run(async () => { const r = await post(`/api/webhooks/${s.id}/rotate-secret`); setSecret({ what: 'New signing secret', value: r.secret }); })}>Rotate secret</button><button onClick={() => run(() => post(`/api/webhooks/${s.id}/active`, { active: !s.active }))}>{s.active ? 'Disable' : 'Enable'}</button><button onClick={() => { if (confirm('Delete this subscription?')) run(() => api('DELETE', `/api/webhooks/${s.id}`)); }}>Delete</button></div></div>)}
      <div className="formgrid"><label>Destination URL<input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/relay" /></label><label>Events (comma separated: message.received, message.status_changed, payment.updated, review.created, or *)<input value={evs} onChange={(e) => setEvs(e.target.value)} /></label><label className="inline"><input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} /> include message/review text</label>
        <button className="primary" disabled={!url} onClick={async () => { const r = await run(() => post('/api/webhooks', { url, events: evs.split(',').map((x) => x.trim()).filter(Boolean), includeContent: content })); if (r) { setSecret({ what: 'Signing secret', value: r.secret }); setUrl(''); } }}>Add subscription</button></div>
      <h4>Inbound lead endpoints (website forms)</h4>
      <p className="small muted">A signed POST creates or updates a contact and a note. It can never send a text, and marketing consent is recorded only if the form passes explicit evidence.</p>
      {eps.map((x) => <div key={x.id} className="trow"><div><b className="small">{x.name}</b> {!x.active && <span className="chip bad">disabled</span>}<div className="small muted"><code>POST /hooks/inbound/{x.id}</code></div></div><button onClick={() => run(() => post(`/api/inbound-endpoints/${x.id}/active`, { active: !x.active }))}>{x.active ? 'Disable' : 'Enable'}</button></div>)}
      <div className="formgrid"><label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Website contact form" /></label><button disabled={!name} onClick={async () => { const r = await run(() => post('/api/inbound-endpoints', { name, defaultTags: ['website'] })); if (r) { setSecret({ what: `Signing secret for ${r.url}`, value: r.secret }); setName(''); } }}>Create endpoint</button></div>
    </section>
  );
}
