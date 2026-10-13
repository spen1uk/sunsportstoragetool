import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, useLive, usd, type AppState } from './api.ts';
import type { Conversation } from './Chat.tsx';
import { ProposalTray } from './Proposals.tsx';
import { HabitsList, PeopleList, LearningList, LinksList } from './life.tsx';

export type Widget = { id: string; type: string; x: number; y: number; w: number; h: number };
const COLS = 12, ROW = 40, GAP = 8;
const TITLES: Record<string, string> = { conversation: 'Conversation', today: 'Today', calendar: 'Next up', tasks: 'My tasks', approvals: 'Decisions', review: 'Ready for review', habits: 'Habits', people: 'Stay in touch', learning: 'Learning', links: 'Quick links', spend: 'Mind & spend', systems: 'Systems' };
const MIN: Record<string, [number, number]> = { conversation: [3, 6], today: [3, 4], calendar: [3, 4], tasks: [3, 4], approvals: [2, 3], review: [2, 3], habits: [2, 4], people: [2, 4], learning: [3, 4], links: [2, 3], spend: [2, 3], systems: [2, 4] };
const SIZE: Record<string, [number, number]> = { conversation: [6, 12], today: [6, 6], calendar: [4, 6], tasks: [4, 6], approvals: [3, 5], review: [3, 5], habits: [3, 6], people: [3, 6], learning: [4, 6], links: [3, 4], spend: [3, 5], systems: [3, 6] };

const hit = (a: Widget, b: Widget) => a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Keep a layout tidy after one panel moved/resized: the moved panel wins its spot, others are pushed down out of the way, then everything floats up into free space. */
export function resolve(layout: Widget[], movedId?: string): Widget[] {
  const moved = movedId ? layout.find((w) => w.id === movedId) : undefined;
  const placed: Widget[] = moved ? [{ ...moved }] : [];
  for (const w of [...layout].filter((x) => x.id !== movedId).sort((a, b) => a.y - b.y || a.x - b.x)) {
    const n = { ...w };
    while (placed.some((p) => hit(n, p))) n.y++;
    while (n.y > 0 && !placed.some((p) => hit({ ...n, y: n.y - 1 }, p))) n.y--;
    placed.push(n);
  }
  return layout.map((w) => placed.find((p) => p.id === w.id)!);
}

function Empty({ children }: { children: ReactNode }) { return <p className="muted small">{children}</p>; }
const hm = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });

function Body({ type, st, convo }: { type: string; st: AppState; convo: Conversation }) {
  const today = useLive<any>(() => api('/api/today'), ['tasks', 'approvals', 'artifacts', 'system', 'mode', 'calendar-sync'], []);
  const tasks = useLive<any[]>(() => (type === 'tasks' ? api('/api/tasks') : Promise.resolve([])), ['tasks'], [type]);
  const apprs = useLive<any>(() => (type === 'approvals' ? api('/api/approvals') : Promise.resolve(null)), ['approvals'], [type]);
  const arts = useLive<any[]>(() => (type === 'review' ? api('/api/artifacts') : Promise.resolve([])), ['artifacts'], [type]);
  const cal = useLive<any>(() => (type === 'calendar' ? api(`/api/calendar?from=${Date.now() - 3_600_000}&to=${Date.now() + 3 * 86_400_000}`) : Promise.resolve(null)), ['calendar-sync'], [type]);
  const b = today.data?.briefing;
  if (type === 'conversation') {
    const lines = convo.msgs.slice(-14);
    return <div className="ws-chat"><div className="ws-lines" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>{lines.length === 0 ? <Empty>Say something to Jarvis below.</Empty> : lines.map((m) => <div key={m.id} className={`wl ${m.role}`}><b>{m.role === 'jarvis' ? 'JARVIS' : 'YOU'}</b><span>{m.content}</span></div>)}{convo.busy && <div className="wl jarvis"><b>JARVIS</b><span className="muted">thinking…</span></div>}</div>
      <ProposalTray />
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (convo.text.trim()) void convo.send(convo.text); }}><input className="grow" value={convo.text} onChange={(e) => convo.setText(e.target.value)} placeholder="Speak to Jarvis, sir…" aria-label="Message Jarvis" /><button className="primary" disabled={convo.busy || !convo.text.trim()}>Send</button></form></div>;
  }
  if (type === 'today') {
    if (!b) return <Empty>Loading…</Empty>;
    const urgent = b.sections[0].items as any[], appts = (b.schedule.appointments ?? []) as any[];
    return <div>{urgent.length ? <><h4>Needs you</h4><ul className="plain">{urgent.slice(0, 4).map((i, k) => <li key={k} className="small">{i.text}</li>)}</ul></> : <p className="small">All quiet. Nothing needs you right now.</p>}
      {appts.length > 0 && <><h4>Appointments</h4><ul className="plain">{appts.slice(0, 5).map((a, k) => <li key={k} className="small"><span className="mono">{a.day.split(',')[0]} {a.when === 'all day' ? 'all day' : a.when.split('–')[0]}</span> {a.title}</li>)}</ul></>}
      {b.sections[2].items.length > 0 && <><h4>Suggested</h4><ul className="plain">{b.sections[2].items.slice(0, 3).map((i: any, k: number) => <li key={k} className="small">{i.text}</li>)}</ul></>}</div>;
  }
  if (type === 'calendar') {
    const ev: any[] = cal.data?.events ?? []; if (cal.data?.state.status === 'planned') return <Empty>Calendar isn't connected. Connect it on the Calendar page.</Empty>;
    return ev.length === 0 ? <Empty>Nothing in the next three days.</Empty> : <ul className="plain">{ev.slice(0, 12).map((e) => <li key={e.calendar + e.uid + e.start} className="small"><span className="mono">{new Date(e.start).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short' })} {e.allDay ? 'all day' : hm(e.start)}</span> {e.title}</li>)}</ul>;
  }
  if (type === 'tasks') {
    const open = (tasks.data ?? []).filter((t) => t.kind === 'manual' && !['completed', 'canceled'].includes(t.state));
    return open.length === 0 ? <Empty>No open tasks.</Empty> : <ul className="plain">{open.slice(0, 10).map((t) => <li key={t.id} className="row small"><button className="tick sm" aria-label={`Complete ${t.title}`} onClick={async () => { await api(`/api/tasks/${t.id}/complete`, 'POST', {}); tasks.reload(); }} /><span className="grow">{t.title}</span><span className="muted">P{t.priority}</span></li>)}</ul>;
  }
  if (type === 'approvals') {
    const p = (apprs.data?.items ?? []).filter((a: any) => a.status === 'pending');
    return p.length === 0 ? <Empty>Nothing waiting for your decision.</Empty> : <div><ul className="plain">{p.slice(0, 5).map((a: any) => <li key={a.id} className="small">{a.summary}</li>)}</ul><a href="#/approvals">Decide on the Approvals page ›</a></div>;
  }
  if (type === 'review') {
    const r = (arts.data ?? []).filter((a) => a.status === 'in_review');
    return r.length === 0 ? <Empty>No drafts waiting.</Empty> : <div><ul className="plain">{r.slice(0, 6).map((a) => <li key={a.id} className="small">{a.title} <span className="muted">v{a.current_version}</span></li>)}</ul><a href="#/review">Open Ready for Review ›</a></div>;
  }
  if (type === 'habits') return <HabitsList compact />;
  if (type === 'people') return <PeopleList compact onlyDue />;
  if (type === 'learning') return <LearningList compact />;
  if (type === 'links') return <LinksList compact />;
  if (type === 'spend') return <div className="small"><div>Month <b>{usd(st.budget.committedMicroUsd)}</b> of {usd(st.budget.capMicroUsd)}</div><div className="meter"><i style={{ width: `${Math.min(100, st.budget.pctCommitted * 100)}%` }} /></div><div className="muted">{st.budget.level === 'ok' ? 'Well within budget.' : st.budget.level}</div></div>;
  if (type === 'systems') return <ul className="plain">{st.agents.filter((a) => a.role === 'manager').map((a) => <li key={a.id} className="row small"><span className={`dot ${a.status_kind}`} /><span className="grow">{a.name}</span><span className="badge sm">{a.status_kind}</span></li>)}</ul>;
  return null;
}

export function WorkspacePage({ st, convo }: { st: AppState; convo: Conversation }) {
  const { data, reload } = useLive<any>(() => api('/api/workspaces'), []);
  const [name, setName] = useState('Main'); const [layout, setLayout] = useState<Widget[]>([]); const [edit, setEdit] = useState(false); const [dirty, setDirty] = useState(false); const [msg, setMsg] = useState('');
  const loaded = useRef(false); const box = useRef<HTMLDivElement>(null); const [width, setWidth] = useState(1000);
  useEffect(() => { if (data && !loaded.current) { loaded.current = true; setName(data.active); setLayout(data.layouts[data.active]); } }, [data]);
  useEffect(() => { const el = box.current; if (!el) return; const ro = new ResizeObserver(() => setWidth(el.clientWidth)); ro.observe(el); setWidth(el.clientWidth); return () => ro.disconnect(); }, [data]);
  const colW = width / COLS; const rows = Math.max(8, ...layout.map((w) => w.y + w.h));
  const names: string[] = data ? Object.keys(data.layouts) : [];
  const drag = useRef<null | { id: string; mode: 'move' | 'size'; px: number; py: number; o: Widget }>(null);
  const begin = (e: React.PointerEvent, w: Widget, mode: 'move' | 'size') => { if (!edit) return; e.preventDefault(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { id: w.id, mode, px: e.clientX, py: e.clientY, o: { ...w } }; };
  const move = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return; const dx = Math.round((e.clientX - d.px) / colW), dy = Math.round((e.clientY - d.py) / (ROW + 0));
    const [mw, mh] = MIN[d.o.type] ?? [2, 3];
    setLayout((l) => resolve(l.map((w) => w.id !== d.id ? w : d.mode === 'move'
      ? { ...w, x: Math.max(0, Math.min(COLS - w.w, d.o.x + dx)), y: Math.max(0, d.o.y + dy) }
      : { ...w, w: Math.max(mw, Math.min(COLS - w.x, d.o.w + dx)), h: Math.max(mh, Math.min(24, d.o.h + dy)) }), d.id)); setDirty(true);
  };
  const end = () => { drag.current = null; };
  const add = (type: string) => { const [w, h] = SIZE[type]; setLayout((l) => resolve([...l, { id: type, type, x: 0, y: 0, w, h }], type)); setDirty(true); };
  const present = new Set(layout.map((w) => w.type));
  const call = async (f: () => Promise<unknown>, ok: string) => { try { await f(); setMsg(ok); await reload(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } };
  const switchTo = async (n: string) => { if (dirty && !confirm('Discard unsaved changes to this layout?')) return; await call(() => api(`/api/workspaces/${encodeURIComponent(n)}/activate`, 'POST', {}), `Switched to ${n}.`); const d = await api('/api/workspaces'); setName(n); setLayout(d.layouts[n]); setDirty(false); };
  const sorted = useMemo(() => [...layout].sort((a, b) => a.y - b.y || a.x - b.x), [layout]);
  if (!data) return <section className="page"><h1>Modular Workspace</h1><p className="muted">Loading…</p></section>;
  return (
    <section className="page ws-page"><h1>Modular Workspace</h1>
      <div className="ws-bar glass">
        <label className="small muted">Layout <select value={name} onChange={(e) => void switchTo(e.target.value)} aria-label="Saved layout">{names.map((n) => <option key={n}>{n}</option>)}</select></label>
        <button className={edit ? 'primary' : ''} onClick={() => setEdit(!edit)} aria-pressed={edit}>{edit ? 'Done arranging' : 'Arrange panels'}</button>
        {edit && <>
          <label className="small muted">Add <select value="" onChange={(e) => e.target.value && add(e.target.value)} aria-label="Add a panel"><option value="">panel…</option>{Object.keys(TITLES).filter((t) => !present.has(t)).map((t) => <option key={t} value={t}>{TITLES[t]}</option>)}</select></label>
          <button onClick={() => { const n = prompt('Save this layout as:', name === 'Main' ? 'Focus' : name); if (n) void call(async () => { await api(`/api/workspaces/${encodeURIComponent(n.trim())}`, 'PUT', layout); await api(`/api/workspaces/${encodeURIComponent(n.trim())}/activate`, 'POST', {}); setName(n.trim()); setDirty(false); }, `Saved as ${n.trim()}.`); }}>Save as…</button>
          <button className="primary" disabled={!dirty} onClick={() => void call(async () => { await api(`/api/workspaces/${encodeURIComponent(name)}`, 'PUT', layout); setDirty(false); }, `Saved ${name}.`)}>Save</button>
          <button onClick={() => { if (confirm('Put this layout back to the standard arrangement?')) { setLayout(data.default as Widget[]); setDirty(true); } }}>Reset</button>
          {name !== 'Main' && <button onClick={() => { if (confirm(`Delete layout "${name}"?`)) void call(async () => { await api(`/api/workspaces/${encodeURIComponent(name)}`, 'DELETE'); const d = await api('/api/workspaces'); setName(d.active); setLayout(d.layouts[d.active]); setDirty(false); }, 'Deleted.'); }}>Delete layout</button>}
        </>}
        {dirty && <span className="badge planned">unsaved</span>}{msg && <span className="small muted" role="status">{msg}</span>}
      </div>
      <div ref={box} className={`ws-grid ${edit ? 'editing' : ''}`} style={{ height: rows * ROW }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        {sorted.map((w) => <div key={w.id} className="ws-panel glass" style={{ left: w.x * colW, top: w.y * ROW, width: w.w * colW - GAP, height: w.h * ROW - GAP }}>
          <header onPointerDown={(e) => begin(e, w, 'move')}><span>{TITLES[w.type]}</span>{edit && <button aria-label={`Remove ${TITLES[w.type]}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => { setLayout((l) => resolve(l.filter((x) => x.id !== w.id))); setDirty(true); }}>✕</button>}</header>
          <div className="ws-body"><Body type={w.type} st={st} convo={convo} /></div>
          {edit && <i className="ws-resize" aria-label="Resize" onPointerDown={(e) => begin(e, w, 'size')} />}
        </div>)}
        {layout.length === 0 && <p className="muted" style={{ padding: 20 }}>No panels. Choose "Arrange panels", then add some.</p>}
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>Panels show the same real data as the rest of Jarvis. Arranging only changes what you see; it never changes any task, approval or setting.</p>
    </section>
  );
}
