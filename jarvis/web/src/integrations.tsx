import { useState } from 'react';
import { api, useLive } from './api.ts';
import { stepUpWithPasskey } from './passkey.ts';
import { parseExport, parsePasted, type Conv } from './chatgpt.ts';

const STATUS: Record<string, string> = { draft: 'Draft', ready: 'Ready to copy', launched: 'Started', done: 'Finished', dropped: 'Dropped' };
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function Briefs({ run }: { run: (f: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const { data, reload } = useLive<any>(() => api('/api/briefs'), ['briefs']);
  const [req, setReq] = useState(''), [repo, setRepo] = useState('spen1uk/sunsportstoragetool'), [copied, setCopied] = useState<string | null>(null), [res, setRes] = useState<Record<string, string>>({}), [edit, setEdit] = useState<{ id: string; goal: string; context: string; acceptance: string; repo: string } | null>(null);
  if (!data) return null;
  const go = (f: () => Promise<unknown>, ok: string) => run(async () => { await f(); await reload(); }, ok);
  const copy = async (id: string) => { const r = await api(`/api/briefs/${id}/markdown`); await navigator.clipboard.writeText(r.markdown); setCopied(id); };
  return (
    <div className="glass pad section"><h2>Claude Code briefs</h2>
      <p className="muted small">Jarvis writes the instructions; you read them, copy them, and start the Claude Code session yourself. Nothing here connects to Claude Code or touches a repository. Every brief carries the same fixed rules: its own branch, nothing pushed to the main branch, no pull request unless you ask, no secrets, no new software.</p>
      <textarea value={req} onChange={(e) => setReq(e.target.value)} rows={3} maxLength={3000} placeholder="What do you want done? Plain words are fine, e.g. “The Mac login page shows an error on my phone. Find out why and fix it.”" aria-label="What do you want done" />
      <div className="row wrap"><input className="grow" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" aria-label="Repository" />
        <button className="primary" disabled={req.trim().length < 10} onClick={() => void go(async () => { await api('/api/briefs/draft', 'POST', { request: req, repo }); setReq(''); }, 'Draft written. Read it before you use it.')}>Write a brief</button></div>
      {data.items.map((b: any) => (
        <div key={b.id} className="rcard" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
          <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{b.title}</b><span className="badge">{STATUS[b.status]}</span></div>
          <div className="muted small">{b.repo || 'no repository set'} · branch {b.branch}{b.drafted_by === 'jarvis' ? ' · worded by the model, please read it' : ''}</div>
          {edit && edit.id === b.id ? <div>
            <textarea value={edit.goal} onChange={(e) => setEdit({ ...edit, goal: e.target.value })} rows={3} aria-label="Goal" /><textarea value={edit.context} onChange={(e) => setEdit({ ...edit, context: e.target.value })} rows={2} placeholder="Context" aria-label="Context" />
            <textarea value={edit.acceptance} onChange={(e) => setEdit({ ...edit, acceptance: e.target.value })} rows={3} placeholder="Done when… (one per line)" aria-label="Done when" /><input value={edit.repo} onChange={(e) => setEdit({ ...edit, repo: e.target.value })} aria-label="Repository" placeholder="owner/name" />
            <div className="row wrap"><button className="primary" onClick={() => void go(async () => { await api(`/api/briefs/${b.id}`, 'PATCH', { goal: edit.goal, context: edit.context, acceptance: lines(edit.acceptance), repo: edit.repo }); setEdit(null); }, 'Saved. It is a draft again until you mark it ready.')}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div></div>
            : <><p className="small">{b.goal}</p>{b.context && <p className="small muted">{b.context}</p>}{b.acceptance.length > 0 && <ul className="small">{b.acceptance.map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>}</>}
          {b.result_note && <p className="small"><b>Result:</b> {b.result_note}</p>}
          <div className="row wrap">
            {['draft', 'ready'].includes(b.status) && !edit && <button onClick={() => setEdit({ id: b.id, goal: b.goal, context: b.context, acceptance: b.acceptance.join('\n'), repo: b.repo })}>Edit</button>}
            {b.status === 'draft' && <button className="primary" onClick={() => void go(() => api(`/api/briefs/${b.id}/ready`, 'POST'), 'Marked ready.')}>I have read it: ready</button>}
            {['ready', 'launched'].includes(b.status) && <button className="primary" onClick={() => void run(() => copy(b.id), 'Copied. Paste it into a new Claude Code session.')}>{copied === b.id ? 'Copied ✓' : 'Copy the brief'}</button>}
            {b.status === 'ready' && <button onClick={() => void go(() => api(`/api/briefs/${b.id}/launched`, 'POST'), 'Noted.')}>I started it</button>}
            {b.status === 'launched' && <><input className="grow" value={res[b.id] ?? ''} onChange={(e) => setRes({ ...res, [b.id]: e.target.value })} placeholder="How did it go? (branch name, what changed)" aria-label="Result" /><button className="primary" onClick={() => void go(() => api(`/api/briefs/${b.id}/finish`, 'POST', { result: res[b.id] ?? '' }), 'Recorded.')}>Finished</button></>}
            {['draft', 'ready', 'launched'].includes(b.status) && <button onClick={() => void go(() => api(`/api/briefs/${b.id}/drop`, 'POST'), 'Dropped.')}>Drop</button>}
            <button onClick={() => { if (confirm('Delete this brief?')) void go(() => api(`/api/briefs/${b.id}`, 'DELETE'), 'Deleted.'); }}>Delete</button></div>
        </div>))}
      <details className="small"><summary>The fixed rules every brief carries</summary><ul>{data.rules.map((r: string) => <li key={r}>{r}</li>)}</ul></details>
    </div>);
}

function ChatImports({ run, confirm1 }: { run: (f: () => Promise<unknown>, ok: string) => Promise<void>; confirm1: () => Promise<void> }) {
  const { data, reload } = useLive<any>(() => api('/api/imports'), ['imports']);
  const [convs, setConvs] = useState<Conv[] | null>(null), [pick, setPick] = useState<Set<number>>(new Set()), [paste, setPaste] = useState(''), [project, setProject] = useState(''), [q, setQ] = useState(''), [hits, setHits] = useState<any[] | null>(null), [view, setView] = useState<any>(null), [filter, setFilter] = useState('');
  if (!data) return null;
  const go = (f: () => Promise<unknown>, ok: string) => run(async () => { await f(); await reload(); }, ok);
  const shown = (convs ?? []).map((c, i) => ({ c, i })).filter(({ c }) => c.title.toLowerCase().includes(filter.toLowerCase()));
  const send = async (cs: Conv[]) => { let tot = { imported: 0, duplicates: 0, skipped: 0, redactedMessages: 0 }; for (let i = 0; i < cs.length; i += data.limits.maxBatch) { const r = await api('/api/imports', 'POST', { conversations: cs.slice(i, i + data.limits.maxBatch), project }); for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += r[k]; } return tot; };
  return (
    <div className="glass pad section"><h2>Chats from ChatGPT</h2>
      <p className="muted small">You hand over your own data; Jarvis never connects to your ChatGPT account. In ChatGPT: Settings → Data controls → Export data. You get an email with a zip; unzip it and pick <b>conversations.json</b> below. The file is read in your browser, and only the chats you tick are sent to Jarvis. Imported chats are <b>private</b>: kept for you to read and search, never shown to the language model, never used in answers, memory or the knowledge graph unless you say so. Anything that looks like a secret, or mentions a name you excluded, is removed on the way in.</p>
      <div className="row wrap"><input type="file" accept="application/json,.json" aria-label="conversations.json" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; void run(async () => { const all = parseExport(JSON.parse(await f.text())); setConvs(all); setPick(new Set()); if (!all.length) throw new Error('No conversations found in that file. Is it conversations.json from the export?'); }, 'File read. Tick the chats you want.'); e.target.value = ''; }} />
        <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Label these (optional), e.g. Marina" aria-label="Label" maxLength={80} /></div>
      {convs && <div className="section"><div className="row wrap"><input className="grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${convs.length} chats by title`} aria-label="Filter chats" /><button onClick={() => setPick(new Set(shown.map((s) => s.i)))}>Tick shown</button><button onClick={() => setPick(new Set())}>Clear</button></div>
        <ul className="plain small" style={{ maxHeight: 260, overflow: 'auto' }}>{shown.slice(0, 300).map(({ c, i }) => <li key={i}><label><input type="checkbox" checked={pick.has(i)} onChange={() => { const n = new Set(pick); n.has(i) ? n.delete(i) : n.add(i); setPick(n); }} /> {c.title} <span className="muted">· {c.messages.length} messages{c.createdAt ? ` · ${new Date(c.createdAt).toLocaleDateString()}` : ''}</span></label></li>)}</ul>
        <button className="primary" disabled={pick.size === 0} onClick={() => void go(async () => { const t = await send([...pick].map((i) => convs[i])); setConvs(null); setPick(new Set()); setProject(''); throw Object.assign(new Error(`Imported ${t.imported}${t.duplicates ? `, ${t.duplicates} already there` : ''}${t.skipped ? `, ${t.skipped} skipped` : ''}${t.redactedMessages ? `; ${t.redactedMessages} message(s) had something removed` : ''}.`), { ok: true }); }, '')}>Import {pick.size} chat{pick.size === 1 ? '' : 's'}</button></div>}
      <details className="small section"><summary>Or paste one chat</summary><textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} placeholder={'Copy a conversation from the ChatGPT page and paste it here. “You said:” / “ChatGPT said:” lines are understood.'} aria-label="Pasted chat" />
        <button disabled={paste.trim().length < 10} onClick={() => void go(async () => { const c = parsePasted(paste, paste.trim().split('\n')[0].replace(/^(You said|User)\s*:?\s*/i, '').slice(0, 80) || 'Pasted chat'); if (!c) throw new Error('I could not find "You said:" / "ChatGPT said:" (or "User:" / "Assistant:") lines in that.'); await send([c]); setPaste(''); }, 'Imported.')}>Import pasted chat</button></details>

      <h3>Imported chats ({data.items.length})</h3>
      <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void run(async () => setHits((await api(`/api/imports?q=${encodeURIComponent(q)}`)).hits), ''); }}><input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything you imported" aria-label="Search imports" /><button type="submit">Search</button></form>
      {hits && <ul className="plain small">{hits.length === 0 ? <li className="muted">Nothing found.</li> : hits.map((h, i) => <li key={i}><b>{h.title}</b> <span className="muted">({h.role})</span>: …{h.snippet}…</li>)}</ul>}
      <ul className="plain small">{data.items.map((c: any) => (
        <li key={c.id} className="rcard"><div className="row wrap" style={{ alignItems: 'center' }}><span className="grow"><b>{c.title}</b> <span className="muted">· {c.message_count} messages{c.project ? ` · ${c.project}` : ''} · {c.visibility === 'private' ? 'private' : 'searchable by Jarvis (titles only)'}{c.redacted ? ` · ${c.redacted} removed` : ''}{c.truncated ? ' · cut to the first 400 messages' : ''}</span></span>
          <button onClick={async () => setView(view?.chat.id === c.id ? null : await api(`/api/imports/${c.id}`))}>{view?.chat.id === c.id ? 'Hide' : 'Read'}</button>
          <button onClick={() => void go(() => api(`/api/imports/${c.id}`, 'PATCH', { visibility: c.visibility === 'private' ? 'searchable' : 'private' }), c.visibility === 'private' ? 'Jarvis can now mention this chat’s title when you ask what it knows about a topic. Its text stays private.' : 'Private again.')}>{c.visibility === 'private' ? 'Let Jarvis find it' : 'Make private'}</button>
          <button title="Sends this chat to the language model, then you approve or reject each suggestion on the Memory page" onClick={() => { if (confirm('Send what YOU said in this chat to the language model to suggest things worth remembering? You approve each one on the Memory page.')) void go(async () => { const r = await api(`/api/imports/${c.id}/suggest-memories`, 'POST'); throw Object.assign(new Error(r.added ? `${r.added} suggestion${r.added === 1 ? '' : 's'} waiting on the Memory page.` : 'Nothing new worth remembering.'), { ok: true }); }, ''); }}>Suggest memories</button>
          <button onClick={() => { if (confirm('Delete this imported chat for good?')) void go(() => api(`/api/imports/${c.id}`, 'DELETE'), 'Deleted.'); }}>Delete</button></div>
          {view?.chat.id === c.id && <div style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{view.messages.map((m: any) => <p key={m.idx}><b>{m.role === 'user' ? 'You' : 'ChatGPT'}:</b> {m.text}</p>)}</div>}
        </li>))}</ul>
      {data.items.length > 0 && <button onClick={() => { if (confirm('Delete EVERY imported chat? This cannot be undone.')) void go(async () => { await confirm1(); await api('/api/imports', 'DELETE', {}); }, 'All imported chats deleted.'); }}>Delete all imported chats…</button>}
    </div>);
}

export function IntegrationsPage() {
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [pw, setPw] = useState('');
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(null); try { await f(); if (ok) setMsg({ ok: true, t: ok }); } catch (e) { const o = (e as any)?.ok; setMsg({ ok: !!o, t: e instanceof Error ? e.message : String(e) }); } };
  const confirm1 = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  return (
    <section className="page"><h1>Integrations</h1>
      <p className="muted">Ways to bring other tools in, without giving them a way in. Each one here works from things you hand over or copy yourself.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      <Briefs run={run} />
      <ChatImports run={run} confirm1={confirm1} />
      <div className="glass pad section"><h2>Your confirmation</h2><p className="muted small">Only needed to delete every imported chat.</p><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase (blank to use your passkey)" aria-label="Passphrase" autoComplete="current-password" /></div>
      <div className="glass pad section"><h2>Not connected yet</h2>
        <ul className="plain small"><li><b>Email and texts.</b> Not built. Nothing sends or reads either. This waits on your answers to the email/SMS questions (F8–F21 in docs/MASTER_EXPANSION_AUDIT.md): which accounts, what Jarvis may do alone, what always needs your Confirm, and who pays for the number.</li>
          <li><b>Your messaging code.</b> Once you give read-only access to the repo that holds it, Jarvis can review it and plan how to connect it. No access has been given.</li>
          <li><b>Claude Code connection.</b> Briefs are the first step. A direct connection that can push to a branch would need your decision on which repositories, a dedicated limited credential and a security review.</li>
          <li><b>The Real World.</b> Only by you logging in on your own screen; Jarvis never connects to it.</li></ul></div>
    </section>);
}
