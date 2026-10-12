import { useState } from 'react';
import { api, useLive } from './api.ts';

const tz = 'America/Chicago';
const t = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
const dayKey = (ms: number) => new Date(ms).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
const ago = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

/** Pick which Mac calendars / Notes folders Jarvis may read. Nothing is read until at least one is ticked. */
function SourcePicker({ kind, noun }: { kind: 'calendar' | 'notes'; noun: string }) {
  const { data, reload } = useLive<any>(() => api('/api/mac'), ['calendar-sync']);
  const [busy, setBusy] = useState(''); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const st = data?.[kind]; const [picked, setPicked] = useState<Set<string> | null>(null);
  if (!data) return null;
  const sources: { name: string; enabled: boolean }[] = st.sources;
  const sel = picked ?? new Set(sources.filter((s) => s.enabled).map((s) => s.name));
  const run = async (what: string, f: () => Promise<any>) => { setBusy(what); setMsg(null); try { const r = await f(); setMsg({ ok: true, text: r?.count !== undefined ? `Synced ${r.count} item(s).` : 'Done.' }); } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(''); setPicked(null); reload(); } };
  return (
    <div className="glass pad section">
      <h2>Connect {noun}</h2>
      {!data.mac && <p className="err">Jarvis is not running on a Mac, so it cannot read Apple {kind === 'calendar' ? 'Calendar' : 'Notes'} from here. Any copy shown is the last one taken.</p>}
      <p className="muted small">Read-only, from this Mac, using macOS's own permission (no password is stored). Jarvis reads only what you tick, and never writes anything back.</p>
      <div className="row wrap">
        <button disabled={!!busy || !data.mac} onClick={() => run('detect', async () => { await api('/api/mac/detect', 'POST', { kind }); })}>{busy === 'detect' ? 'Asking macOS…' : sources.length ? `Re-detect ${noun}` : `Detect my ${noun}`}</button>
        {st.status !== 'planned' && <button disabled={!!busy || !data.mac} onClick={() => run('sync', () => api('/api/mac/sync', 'POST', { kind }))}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
        {st.status !== 'planned' && <button disabled={!!busy} onClick={() => run('off', () => api('/api/mac/disconnect', 'POST', { kind }))}>Disconnect & delete copy</button>}
      </div>
      {sources.length > 0 && <>
        <ul className="plain" style={{ marginTop: 12 }}>{sources.map((s) => <li key={s.name}><label className="check"><input type="checkbox" checked={sel.has(s.name)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(s.name) : n.delete(s.name); setPicked(n); }} /> {s.name}</label></li>)}</ul>
        <button className="primary" disabled={!!busy || picked === null} onClick={() => run('save', async () => { await api('/api/mac/sources', 'PUT', { kind, enabled: [...sel] }); if (sel.size && data.mac) return api('/api/mac/sync', 'POST', { kind }); })}>Save choice{sel.size ? ' and sync' : ''}</button>
      </>}
      {msg && <p className={msg.ok ? 'ok' : 'err'} role="status">{msg.text}</p>}
      {st.error && <p className="err small">Last sync problem: {st.error}</p>}
    </div>
  );
}

function Status({ st }: { st: any }) {
  const label = ({ connected: 'connected', stale: 'STALE', disconnected: 'disconnected', planned: 'not connected' } as any)[st.status];
  return <p><span className={`badge ${st.status}`}>{label}</span> <span className="muted small">last successful sync: {ago(st.lastOk)}{st.status === 'stale' ? ' — newer items may be missing' : ''}</span>{st.detail && <span className="muted small"> · scanned {st.detail.scanned} events{st.detail.repeatingSeries !== undefined ? `, ${st.detail.repeatingSeries} repeating series` : ''}{st.detail.unsupportedRules ? `, ${st.detail.unsupportedRules} with a repeat pattern I can't read yet` : ''}</span>}</p>;
}

export function CalendarPage() {
  const { data } = useLive<any>(() => api('/api/calendar'), ['calendar-sync']);
  const groups = new Map<string, any[]>(); for (const e of data?.events ?? []) { const k = dayKey(e.start); (groups.get(k) ?? groups.set(k, []).get(k)!).push(e); }
  return (
    <section className="page"><h1>Calendar</h1>
      {data && <Status st={data.state} />}
      <p className="muted small">A read-only copy of your Apple Calendar for the next two weeks. Jarvis plans work around these appointments but never changes your calendar. Repeating events are worked out from their repeat rule; a few unusual patterns may still be missed, so don't treat free time here as certain.</p>
      <div className="glass pad">
        {data && data.state.status === 'planned' ? <p className="muted">No calendar connected yet. Choose one below.</p>
          : groups.size === 0 ? <p className="muted">Nothing in the next two weeks.</p>
          : [...groups].map(([day, evs]) => <div key={day} className="section"><h3>{day}</h3><ul className="plain">{evs.map((e) => <li key={e.calendar + e.uid + e.start}><span className="mono">{e.allDay ? 'all day' : `${t(e.start)}–${t(e.end)}`}</span> {e.title} <span className="muted small">{e.location ? `· ${e.location} ` : ''}· {e.calendar}</span></li>)}</ul></div>)}
      </div>
      <SourcePicker kind="calendar" noun="calendars" />
    </section>
  );
}

export function NotesPage() {
  const [q, setQ] = useState(''); const [open, setOpen] = useState<any>(null);
  const { data } = useLive<any>(() => api(`/api/notes?q=${encodeURIComponent(q)}`), ['calendar-sync'], [q]);
  return (
    <section className="page"><h1>Notes</h1>
      {data && <Status st={data.state} />}
      <p className="muted small">A read-only copy of the Apple Notes folders you chose. <b>Privacy:</b> note text stays on this machine. It is never sent to the language model and never saved into chat history.</p>
      <div className="glass pad">
        <input type="search" placeholder="Search your notes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" style={{ width: '100%' }} />
        {data && data.state.status === 'planned' ? <p className="muted">No Notes folder connected yet. Choose one below.</p> : (data?.items ?? []).length === 0 ? <p className="muted">No notes{q ? ' match' : ''}.</p>
          : <ul className="plain" style={{ marginTop: 10 }}>{data.items.map((n: any) => <li key={n.id}><button className="link" onClick={async () => setOpen(await api(`/api/notes/${encodeURIComponent(n.id)}`))}><b>{n.title}</b></button> <span className="muted small">· {n.folder} · {ago(n.modified)}</span><div className="muted small">{n.snippet}</div></li>)}</ul>}
      </div>
      {open && <div className="glass pad section"><div className="row"><h2>{open.title}</h2><button onClick={() => setOpen(null)}>Close</button></div><pre className="wrap">{open.body}</pre></div>}
      <SourcePicker kind="notes" noun="Notes folders" />
    </section>
  );
}
