import { useCallback, useEffect, useState } from 'react';
import { api, get, post, put, fmtTime } from './api';

const SCOPE_HELP: Record<string, string> = {
  'conversations:read': 'See conversations it is allowed to access', 'messages:read': 'Read message text (customer text is always marked untrusted)', 'contacts:read': 'Names, tags, boats, preferences (never internal notes)', 'contacts:pii': 'Also phone numbers and email',
  'summaries:read': 'Customer summaries', 'inventory:read': 'Boats and matches', 'business:read': 'Business name, hours', 'events:read': 'Receive the event feed',
  'messages:send': 'Send customer texts (also needs autonomy “send”)', 'drafts:write': 'Suggest replies for staff', 'conversations:write': 'Tags, hand-off, pause', 'tasks:write': 'Create tasks',
};
const AUTONOMY: Record<string, string> = { read_only: 'Read only — can look, cannot change anything', drafts: 'Drafts — can suggest, tag, hand off, create tasks; cannot text customers', send: 'Send — may text customers in conversations handed to Sandra' };

/** Owner/admin panel for the assistant (Sandra) integration. Nothing here talks to a real assistant: it issues the keys and limits she will use once she is connected. */
export function Assistant({ isOwner }: { isOwner: boolean }) {
  const [ids, setIds] = useState<any[]>([]); const [cat, setCat] = useState<{ scopes: string[] } | null>(null); const [deps, setDeps] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]); const [audit, setAudit] = useState<any[]>([]); const [err, setErr] = useState(''); const [secret, setSecret] = useState<{ title: string; items: [string, string][] } | null>(null);
  const [form, setForm] = useState({ name: 'Sandra', scopes: ['conversations:read', 'messages:read', 'contacts:read', 'events:read'] as string[], departmentIds: [] as string[], autonomy: 'read_only', webhookUrl: '' });
  const [rule, setRule] = useState({ topic: '', keywords: '' }); const [showAudit, setShowAudit] = useState(false);
  const load = useCallback(() => { get('/api/assistant/identities').then(setIds).catch((e) => setErr(e.message)); get('/api/assistant/rules').then(setRules).catch(() => {}); }, []);
  useEffect(() => { load(); get('/api/assistant/catalog').then(setCat); get('/api/departments').then(setDeps); }, [load]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); try { await fn(); load(); } catch (e: any) { setErr(e.message); } };
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <section className="card section" aria-labelledby="asst-h"><h3 id="asst-h">Assistant (Sandra)</h3>
      <p className="muted small">Sandra is <strong>not connected</strong> until you create access here and give her the key. She can only act through the limits below, never sends in a conversation unless a person handed it to Sandra, and every action she takes appears in the audit list. Customer messages are treated as information, never as instructions.</p>
      {err && <div className="banner warn" role="alert">{err}</div>}
      {secret && <div className="banner" role="alert"><strong>{secret.title}</strong> — copy now; it will not be shown again.{secret.items.map(([k, v]) => <div key={k}><span className="small muted">{k}</span> <code style={{ wordBreak: 'break-all' }}>{v}</code></div>)}<button onClick={() => setSecret(null)}>I have saved it</button></div>}

      {ids.map((i) => (
        <div key={i.id} className="card section" style={{ marginTop: 8 }}>
          <div className="trow"><strong>{i.name}</strong><span>{i.status === 'active' ? 'Active' : 'DISABLED'} · autonomy: {i.autonomy.replace('_', ' ')} · {i.department_ids.length ? `${i.department_ids.length} department(s)` : 'unrouted conversations only'} · last used {i.last_used_at ? fmtTime(i.last_used_at) : 'never'}</span></div>
          <p className="small muted">Scopes: {i.scopes.join(', ') || 'none'}. Unacknowledged events: {Number(i.head_seq) - Number(i.ack_cursor)}.{i.push_last_error ? ` Push error: ${i.push_last_error}` : ''}</p>
          <label>Autonomy<select value={i.autonomy} onChange={(e) => run(() => api('PATCH', `/api/assistant/identities/${i.id}`, { autonomy: e.target.value }))}>{Object.entries(AUTONOMY).filter(([k]) => k !== 'send' || isOwner || i.autonomy === 'send').map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {!isOwner && <p className="small muted">Only the owner can allow sending customer texts.</p>}
          <div className="chips">{(cat?.scopes ?? []).filter((sc) => isOwner || sc !== 'messages:send').map((sc) => <label key={sc} className="inline" title={SCOPE_HELP[sc]}><input type="checkbox" checked={i.scopes.includes(sc)} onChange={() => run(() => api('PATCH', `/api/assistant/identities/${i.id}`, { scopes: toggle(i.scopes, sc) }))} /> {sc}</label>)}</div>
          <div className="chips">{deps.map((d) => <label key={d.id} className="inline"><input type="checkbox" checked={i.department_ids.includes(d.id)} onChange={() => run(() => api('PATCH', `/api/assistant/identities/${i.id}`, { departmentIds: toggle(i.department_ids, d.id) }))} /> {d.name}{d.restricted ? ' (restricted)' : ''}</label>)}</div>
          <h4>Keys</h4>
          {i.keys.map((k: any) => <div key={k.id} className="trow"><span><code>rk_{k.prefix}_…</code> {k.label} · {k.revokedAt ? 'revoked' : k.expiresAt ? `expires ${fmtTime(k.expiresAt)}` : 'no expiry'} · last used {k.lastUsedAt ? fmtTime(k.lastUsedAt) : 'never'}</span>{!k.revokedAt && <button onClick={() => run(() => api('DELETE', `/api/assistant/identities/${i.id}/keys/${k.id}`))}>Revoke now</button>}</div>)}
          <div className="row"><button onClick={() => run(async () => { const r = await post(`/api/assistant/identities/${i.id}/keys`, { label: 'rotated' }); setSecret({ title: 'New API key', items: [['API key', r.apiKey]] }); })}>Create another key (rotate)</button>
            {i.webhook_url && <button onClick={() => run(async () => { const r = await post(`/api/assistant/identities/${i.id}/webhook-secret`); setSecret({ title: 'New webhook signing secret', items: [['Secret', r.webhookSecret]] }); })}>Rotate webhook secret</button>}
            {i.status === 'active' && <button className="danger" onClick={() => { if (confirm(`Disable ${i.name} immediately? All keys stop working and queued texts from her are cancelled.`)) run(() => post(`/api/assistant/identities/${i.id}/disable`)); }}>Disable now</button>}
            {i.status !== 'active' && <button onClick={() => run(() => api('PATCH', `/api/assistant/identities/${i.id}`, { status: 'active' }))}>Re-enable</button>}</div>
        </div>
      ))}

      <h4>Create access</h4>
      <div className="formgrid">
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Starting autonomy<select value={form.autonomy} onChange={(e) => setForm({ ...form, autonomy: e.target.value })}>{Object.entries(AUTONOMY).filter(([k]) => k !== 'send' || isOwner).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="wide">Optional event push URL (https; otherwise she polls)<input value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} placeholder="https://…" /></label>
      </div>
      <div className="chips">{(cat?.scopes ?? []).filter((sc) => isOwner || sc !== 'messages:send').map((sc) => <label key={sc} className="inline" title={SCOPE_HELP[sc]}><input type="checkbox" checked={form.scopes.includes(sc)} onChange={() => setForm({ ...form, scopes: toggle(form.scopes, sc) })} /> {sc}</label>)}</div>
      <div className="chips">{deps.map((d) => <label key={d.id} className="inline"><input type="checkbox" checked={form.departmentIds.includes(d.id)} onChange={() => setForm({ ...form, departmentIds: toggle(form.departmentIds, d.id) })} /> {d.name}</label>)}</div>
      <button className="primary" onClick={() => run(async () => { const r = await post('/api/assistant/identities', { ...form, webhookUrl: form.webhookUrl || undefined }); setSecret({ title: `Access created for ${form.name}`, items: [['API key', r.apiKey], ...(r.webhookSecret ? [['Webhook signing secret', r.webhookSecret] as [string, string]] : [])] }); })}>Create access &amp; key</button>

      <h4>What she may never decide alone</h4>
      <p className="small muted">If a message she tries to send mentions any of these words, it is NOT sent. It becomes a draft for staff. Dollar amounts that don’t match a listed boat price or something the customer said are held too.</p>
      {rules.map((r) => <div key={r.id} className="trow"><span><strong>{r.topic.replaceAll('_', ' ')}</strong> {r.enabled ? '' : '(off)'}: {r.keywords.join(', ')}</span><span><button onClick={() => run(() => put('/api/assistant/rules', { topic: r.topic, keywords: r.keywords, enabled: !r.enabled }))}>{r.enabled ? 'Turn off' : 'Turn on'}</button> <button onClick={() => run(() => api('DELETE', `/api/assistant/rules/${r.id}`))}>Delete</button></span></div>)}
      <div className="formgrid"><label>Topic (letters/underscores)<input value={rule.topic} onChange={(e) => setRule({ ...rule, topic: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></label><label className="wide">Words or phrases, comma-separated<input value={rule.keywords} onChange={(e) => setRule({ ...rule, keywords: e.target.value })} /></label>
        <button disabled={!rule.topic || !rule.keywords.trim()} onClick={() => run(async () => { await put('/api/assistant/rules', { topic: rule.topic, keywords: rule.keywords.split(',').map((k) => k.trim()).filter(Boolean) }); setRule({ topic: '', keywords: '' }); })}>Add / update rule</button></div>

      <h4>Audit</h4>
      <button onClick={() => { setShowAudit(!showAudit); if (!showAudit) get('/api/assistant/audit').then(setAudit); }}>{showAudit ? 'Hide' : 'Show'} what the assistant has done</button>
      {showAudit && <table className="tbl"><tbody>{audit.length === 0 ? <tr><td className="muted">Nothing yet.</td></tr> : audit.map((a) => <tr key={a.id}><td>{fmtTime(a.created_at)}</td><td>{a.action}</td><td className="small muted">{a.meta?.identity ?? ''} {a.meta?.reason ?? a.meta?.topic ?? ''}</td></tr>)}</tbody></table>}
    </section>
  );
}

/** Admin health card: is the background worker alive, is anything stuck, when was the last backup. */
export function SystemStatus() {
  const [st, setSt] = useState<any>(null); const [err, setErr] = useState('');
  const load = useCallback(() => get('/api/admin/status').then(setSt).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  if (err) return null;
  if (!st) return null;
  return (
    <section className="card section" aria-labelledby="sys-h"><h3 id="sys-h">System health</h3>
      <p className={st.ok ? 'small' : 'small warn'} role="status">{st.ok ? 'All checks passing.' : 'Needs attention:'}</p>
      {st.problems.map((p: string) => <div key={p} className="banner warn">{p}</div>)}
      <p className="small muted">Workers: {st.workers.filter((w: any) => w.alive).length} alive · Jobs waiting {st.queue.pending}, running {st.queue.running}, failed {st.queue.failed} · Live-update connections {st.realtime.subscribers} · Backup: {st.backup ? `${st.backup.ageHours} h old` : 'not reported'}</p>
    </section>
  );
}
