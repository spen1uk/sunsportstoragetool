import { useState } from 'react';
import { api, useLive } from './api.ts';

/** Facts Jarvis thinks are worth remembering. They are only suggestions: nothing is saved until you accept (and you can edit first). */
export function MemorySuggestions() {
  const { data, reload } = useLive<any>(() => api('/api/memory/suggestions'), ['memory']);
  const [busy, setBusy] = useState(''); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null); const [edits, setEdits] = useState<Record<string, string>>({});
  if (!data) return null;
  const run = async (what: string, f: () => Promise<any>) => { setBusy(what); setMsg(null); try { const r = await f(); if (r?.message) setMsg({ ok: r.ok !== false, text: r.message }); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(''); reload(); } };
  const items: { id: string; content: string }[] = data.items;
  return (
    <div className="glass pad section">
      <div className="row wrap"><h2 className="grow" style={{ margin: 0 }}>Suggested memories</h2>
        <button disabled={!!busy || !data.modelReady} title={data.modelReady ? '' : 'Needs a language model key'} onClick={() => run('look', () => api('/api/memory/suggest', 'POST', {}))}>{busy === 'look' ? 'Reading…' : 'Look through recent chats'}</button></div>
      <p className="muted small">Jarvis can read your recent saved chats and suggest things worth remembering, like preferences, routines and people. It costs a fraction of a cent. <b>Nothing is remembered until you accept it.</b> Private-mode chats are never saved, so they are never read, and secrets are filtered out.</p>
      <label className="check small"><input type="checkbox" checked={data.auto} onChange={(e) => void run('auto', () => api('/api/memory/suggest-settings', 'PUT', { auto: e.target.checked }))} /> Look automatically (at most once a day, and only when there's enough new chat)</label>
      {!data.modelReady && <p className="warn small">No language model is connected, so suggestions are unavailable.</p>}
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.text}</p>}
      {items.length === 0 ? <p className="muted small">No suggestions waiting.</p> : <ul className="plain">{items.map((s) => (
        <li key={s.id} className="row wrap" style={{ padding: '6px 0' }}>
          <input className="grow" value={edits[s.id] ?? s.content} onChange={(e) => setEdits((x) => ({ ...x, [s.id]: e.target.value }))} maxLength={300} aria-label="Suggested memory (you can edit it)" />
          <button className="primary" disabled={!!busy} onClick={() => void run(s.id, async () => { await api(`/api/memory/suggestions/${s.id}/accept`, 'POST', edits[s.id] !== undefined && edits[s.id] !== s.content ? { content: edits[s.id] } : {}); setMsg({ ok: true, text: 'Remembered.' }); })}>Remember</button>
          <button disabled={!!busy} onClick={() => void run(s.id, () => api(`/api/memory/suggestions/${s.id}/reject`, 'POST', {}))}>No thanks</button>
        </li>))}</ul>}
    </div>
  );
}
