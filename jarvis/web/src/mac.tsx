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

// ---------------- Calendar (month / week / agenda) ----------------
type Ev = { calendar: string; uid: string; title: string; start: number; end: number; allDay: boolean; location: string };
const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const partsOf = (ms: number) => { const p: Record<string, string> = {}; for (const x of dtf.formatToParts(ms)) p[x.type] = x.value; return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute }; };
const key = (y: number, m: number, d: number) => y * 10000 + m * 100 + d;
const keyOf = (ms: number) => { const p = partsOf(ms); return key(p.y, p.m, p.d); };
const addDays = (y: number, m: number, d: number, n: number) => { const x = new Date(Date.UTC(y, m - 1, d + n)); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const midnight = (y: number, m: number, d: number) => { for (const h of [5, 6]) { const t = Date.UTC(y, m - 1, d, h); const p = partsOf(t); if (p.y === y && p.m === m && p.d === d && p.h === 0 && p.mi === 0) return t; } return Date.UTC(y, m - 1, d, 6); };
const PALETTE = ['#5ab4ff', '#ff9a4d', '#5fe08a', '#c78bff', '#ff6b8b', '#f2d14b', '#4fd8d0', '#ff7ad9', '#9bb0ff', '#b6e35a'];
const colorOf = (name: string) => { let h = 7; for (const c of name) h = (h * 33 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOUR_PX = 44;
const hourLabel = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? 'Noon' : `${h - 12} PM`);

export function CalendarPage() {
  const nowP = partsOf(Date.now());
  const [view, setView] = useState<'month' | 'week' | 'agenda'>(() => { try { return (localStorage.getItem('jv.calview') as any) || 'month'; } catch { return 'month'; } });
  const [anchor, setAnchor] = useState({ y: nowP.y, m: nowP.m, d: nowP.d });
  const [hidden, setHidden] = useState<Set<string>>(new Set()); const [sel, setSel] = useState<Ev | null>(null); const [day, setDay] = useState<number | null>(null);
  const setV = (v: typeof view) => { setView(v); try { localStorage.setItem('jv.calview', v); } catch { /* ignore */ } };
  // visible range
  const first = dow(anchor.y, anchor.m, 1), gridStart = addDays(anchor.y, anchor.m, 1, -first), wk = addDays(anchor.y, anchor.m, anchor.d, -dow(anchor.y, anchor.m, anchor.d));
  const start = view === 'month' ? gridStart : view === 'week' ? wk : { y: nowP.y, m: nowP.m, d: nowP.d };
  const span = view === 'month' ? 42 : view === 'week' ? 7 : 30;
  const from = midnight(start.y, start.m, start.d), endD = addDays(start.y, start.m, start.d, span), to = midnight(endD.y, endD.m, endD.d);
  const { data } = useLive<any>(() => api(`/api/calendar?from=${from}&to=${to}`), ['calendar-sync'], [from, to]);
  const all: Ev[] = (data?.events ?? []) as Ev[];
  const names = [...new Set(all.map((e) => e.calendar))].sort();
  const events = all.filter((e) => !hidden.has(e.calendar));
  const byDay = new Map<number, Ev[]>();
  for (const e of events) { const a = keyOf(e.start), z = keyOf(Math.max(e.start, e.end - 1)); let c = { y: Math.floor(a / 10000), m: Math.floor(a / 100) % 100, d: a % 100 }; for (let i = 0; i < 70; i++) { const k = key(c.y, c.m, c.d); (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e); if (k >= z) break; c = addDays(c.y, c.m, c.d, 1); } }
  for (const l of byDay.values()) l.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
  const todayK = key(nowP.y, nowP.m, nowP.d);
  const step = (n: number) => { if (view === 'month') { const t = new Date(Date.UTC(anchor.y, anchor.m - 1 + n, 1)); setAnchor({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: 1 }); } else setAnchor(addDays(anchor.y, anchor.m, anchor.d, n * 7)); setDay(null); };
  const title = view === 'week' ? `${MONTHS[wk.m - 1]} ${wk.d} – ${(() => { const e = addDays(wk.y, wk.m, wk.d, 6); return e.m === wk.m ? e.d : `${MONTHS[e.m - 1]} ${e.d}`; })()}, ${wk.y}` : view === 'month' ? `${MONTHS[anchor.m - 1]} ${anchor.y}` : 'Next 30 days';
  const chip = (e: Ev) => <button key={e.calendar + e.uid + e.start} className={`cal-chip ${e.allDay ? 'allday' : ''} ${sel === e ? 'on' : ''}`} style={{ ['--k' as any]: colorOf(e.calendar) }} onClick={(ev) => { ev.stopPropagation(); setSel(e); }} title={e.title}>{!e.allDay && <i>{t(e.start).replace(':00', '').replace(' ', '').toLowerCase()}</i>}<span>{e.title}</span></button>;

  const dayCol = (k: number) => {   // week view: positioned timed events with side-by-side overlap handling
    const list = (byDay.get(k) ?? []).filter((e) => !e.allDay);
    const y = Math.floor(k / 10000), m = Math.floor(k / 100) % 100, d = k % 100, d0 = midnight(y, m, d), d1 = midnight(...(Object.values(addDays(y, m, d, 1)) as [number, number, number]));
    const items = list.map((e) => ({ e, s: Math.max(e.start, d0), z: Math.min(Math.max(e.end, e.start + 20 * 60_000), d1) })).sort((a, b) => a.s - b.s);
    const cols: number[] = []; const placed = items.map((it) => { let c = cols.findIndex((end) => end <= it.s); if (c < 0) { c = cols.length; cols.push(0); } cols[c] = it.z; return { ...it, c }; });
    const n = Math.max(1, cols.length);
    return placed.map(({ e, s, z, c }) => <button key={e.calendar + e.uid + e.start} className={`cal-ev ${sel === e ? 'on' : ''}`} style={{ ['--k' as any]: colorOf(e.calendar), top: ((s - d0) / 3_600_000) * HOUR_PX, height: Math.max(18, ((z - s) / 3_600_000) * HOUR_PX - 2), left: `${(c / n) * 100}%`, width: `calc(${100 / n}% - 2px)` }} onClick={() => setSel(e)}><b>{e.title}</b><small>{t(e.start)}</small></button>);
  };

  return (
    <section className="page cal-page"><h1>Calendar</h1>
      {data && <Status st={data.state} />}
      <div className="glass pad cal">
        <div className="cal-bar">
          <div className="row"><button onClick={() => step(-1)} aria-label="Previous">‹</button><button onClick={() => { setAnchor({ y: nowP.y, m: nowP.m, d: nowP.d }); setDay(null); }}>Today</button><button onClick={() => step(1)} aria-label="Next">›</button></div>
          <h2 className="cal-title">{title}</h2>
          <div className="seg" role="tablist" aria-label="Calendar view">{(['month', 'week', 'agenda'] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setV(v)}>{v[0].toUpperCase() + v.slice(1)}</button>)}</div>
        </div>
        {names.length > 1 && <div className="cal-legend">{names.map((n) => <button key={n} className={hidden.has(n) ? 'off' : ''} style={{ ['--k' as any]: colorOf(n) }} onClick={() => setHidden((h) => { const x = new Set(h); x.has(n) ? x.delete(n) : x.add(n); return x; })}><i />{n}</button>)}</div>}

        {data?.state.status === 'planned' ? <p className="muted">No calendar connected yet. Choose one below.</p> : <>
        {view === 'month' && <div className="cal-month">
          {WD.map((w) => <div key={w} className="cal-wd">{w}</div>)}
          {Array.from({ length: 42 }, (_, i) => { const c = addDays(gridStart.y, gridStart.m, gridStart.d, i), k = key(c.y, c.m, c.d), list = byDay.get(k) ?? [];
            return <div key={k} className={`cal-cell ${c.m !== anchor.m ? 'out' : ''} ${k === todayK ? 'today' : ''} ${day === k ? 'sel' : ''}`} onClick={() => setDay(day === k ? null : k)}>
              <span className="cal-num">{c.d === 1 ? `${MONTHS[c.m - 1].slice(0, 3)} ${c.d}` : c.d}</span>
              {list.slice(0, 3).map(chip)}{list.length > 3 && <button className="cal-more" onClick={(ev) => { ev.stopPropagation(); setDay(k); }}>+{list.length - 3} more</button>}
            </div>; })}
        </div>}
        {view === 'week' && <div className="cal-week">
          <div className="cal-wk-head"><span />{Array.from({ length: 7 }, (_, i) => { const c = addDays(wk.y, wk.m, wk.d, i), k = key(c.y, c.m, c.d); return <div key={k} className={k === todayK ? 'today' : ''}><small>{WD[i]}</small><b>{c.d}</b></div>; })}</div>
          <div className="cal-wk-allday"><span>all day</span>{Array.from({ length: 7 }, (_, i) => { const c = addDays(wk.y, wk.m, wk.d, i); return <div key={i}>{(byDay.get(key(c.y, c.m, c.d)) ?? []).filter((e) => e.allDay).map(chip)}</div>; })}</div>
          <div className="cal-wk-body" ref={(el) => { if (el && !el.dataset.s) { el.dataset.s = '1'; el.scrollTop = 7 * HOUR_PX; } }}>
            <div className="cal-hours">{Array.from({ length: 24 }, (_, h) => <span key={h} style={{ height: HOUR_PX }}>{h ? hourLabel(h) : ''}</span>)}</div>
            {Array.from({ length: 7 }, (_, i) => { const c = addDays(wk.y, wk.m, wk.d, i), k = key(c.y, c.m, c.d); return <div key={k} className={`cal-day ${k === todayK ? 'today' : ''}`} style={{ height: 24 * HOUR_PX }}>{dayCol(k)}{k === todayK && <div className="cal-now" style={{ top: ((nowP.h * 60 + nowP.mi) / 60) * HOUR_PX }} />}</div>; })}
          </div>
        </div>}
        {view === 'agenda' && (byDay.size === 0 ? <p className="muted">Nothing in the next 30 days.</p> : [...byDay].sort((a, b) => a[0] - b[0]).filter(([k]) => k >= todayK).map(([k, list]) => <div key={k} className="section"><h3>{WD[dow(Math.floor(k / 10000), Math.floor(k / 100) % 100, k % 100)]}, {MONTHS[Math.floor(k / 100) % 100 - 1]} {k % 100}{k === todayK ? ' — today' : ''}</h3><ul className="plain">{list.map((e) => <li key={e.calendar + e.uid + e.start}><span className="mono">{e.allDay ? 'all day' : `${t(e.start)}–${t(e.end)}`}</span> {e.title} <span className="muted small">{e.location ? `· ${e.location} ` : ''}· <span style={{ color: colorOf(e.calendar) }}>●</span> {e.calendar}</span></li>)}</ul></div>))}
        </>}
        {day !== null && view === 'month' && <div className="cal-daylist"><h3>{MONTHS[Math.floor(day / 100) % 100 - 1]} {day % 100}</h3>{(byDay.get(day) ?? []).length === 0 ? <p className="muted">Nothing this day.</p> : <ul className="plain">{(byDay.get(day) ?? []).map((e) => <li key={e.calendar + e.uid + e.start}><span className="mono">{e.allDay ? 'all day' : `${t(e.start)}–${t(e.end)}`}</span> {e.title}</li>)}</ul>}</div>}
        {sel && <div className="cal-detail" style={{ ['--k' as any]: colorOf(sel.calendar) }}><div className="row"><b>{sel.title}</b><button onClick={() => setSel(null)} aria-label="Close details">✕</button></div>
          <div className="muted small">{dayKey(sel.start)} · {sel.allDay ? 'all day' : `${t(sel.start)}–${t(sel.end)}`}</div>{sel.location && <div className="small">📍 {sel.location}</div>}<div className="muted small"><i className="dot" /> {sel.calendar}</div></div>}
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>A read-only copy of your Apple Calendar (about a month back and two months ahead). Jarvis plans work around these appointments but never changes your calendar. Repeating events are worked out from their repeat rule; a few unusual patterns may still be missed.</p>
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
