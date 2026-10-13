import { useState } from 'react';
import { api, useLive } from './api.ts';

const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const ordered = (n: number) => { const now = new Date(); return Array.from({ length: n }, (_, i) => { const d = new Date(now.getTime() - (n - 1 - i) * 86_400_000); return d.toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'narrow' }); }); };

function useAct() {
  const [err, setErr] = useState('');
  return { err, run: async (f: () => Promise<unknown>) => { try { setErr(''); await f(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } } };
}

export function HabitsList({ compact = false }: { compact?: boolean }) {
  const { data, reload } = useLive<any>(() => api('/api/life'), ['life']); const a = useAct();
  const habits: any[] = data?.habits ?? []; const days = ordered(7);
  if (!data) return <p className="muted small">Loading…</p>;
  return <div>
    {a.err && <p className="err small" role="alert">{a.err}</p>}
    {habits.length === 0 ? <p className="muted small">No habits yet. Add one on the My Life page.</p> : habits.map((h) => (
      <div key={h.id} className="habit">
        <button className={`tick ${h.doneToday ? 'on' : ''}`} aria-pressed={h.doneToday} aria-label={`${h.name}: ${h.doneToday ? 'done today, click to undo' : 'mark done today'}`} onClick={() => a.run(async () => { await api(`/api/habits/${h.id}/toggle`, 'POST', {}); reload(); })}>{h.doneToday ? '✓' : ''}</button>
        <div className="grow"><b>{h.name}</b><div className="muted small">{h.streak ? `${h.streak} day streak · ` : ''}{h.weekCount}/{h.perWeek} this week</div></div>
        {!compact && <div className="dots" aria-hidden="true">{h.last7.map((d: boolean, i: number) => <span key={i} className={d ? 'on' : ''} title={days[i]}>{days[i]}</span>)}</div>}
      </div>))}
  </div>;
}

export function PeopleList({ compact = false, onlyDue = false }: { compact?: boolean; onlyDue?: boolean }) {
  const { data, reload } = useLive<any>(() => api('/api/life'), ['life']); const a = useAct();
  const all: any[] = data?.people ?? []; const people = onlyDue ? all.filter((p) => p.due) : all;
  if (!data) return <p className="muted small">Loading…</p>;
  return <div>
    {a.err && <p className="err small" role="alert">{a.err}</p>}
    {people.length === 0 ? <p className="muted small">{onlyDue ? 'Nobody is overdue.' : 'No one added yet.'}</p> : people.map((p) => (
      <div key={p.id} className={`person ${p.due ? 'due' : ''}`}>
        <div className="grow"><b>{p.name}</b>{p.relationship && <span className="muted small"> · {p.relationship}</span>}
          <div className="muted small">{p.never ? 'not contacted yet' : p.daysSince === 0 ? 'in touch today' : `${p.daysSince} day${p.daysSince === 1 ? '' : 's'} ago`}{p.everyDays ? ` · every ${p.everyDays} days${p.due ? ` — ${p.overdueBy === 0 ? 'due today' : `${p.overdueBy} overdue`}` : ''}` : ''}</div>
          {!compact && p.notes && <div className="small">{p.notes}</div>}</div>
        <button onClick={() => a.run(async () => { await api(`/api/people/${p.id}/contacted`, 'POST', {}); reload(); })}>In touch today</button>
        {!compact && <button aria-label={`Remove ${p.name}`} onClick={() => { if (confirm(`Remove ${p.name}?`)) void a.run(async () => { await api(`/api/people/${p.id}`, 'DELETE'); reload(); }); }}>✕</button>}
      </div>))}
  </div>;
}

export function LearningList({ compact = false }: { compact?: boolean }) {
  const { data, reload } = useLive<any>(() => api('/api/life'), ['life']); const a = useAct();
  const goals: any[] = data?.goals ?? [];
  if (!data) return <p className="muted small">Loading…</p>;
  return <div>
    {a.err && <p className="err small" role="alert">{a.err}</p>}
    {goals.length === 0 ? <p className="muted small">No learning goals yet. Add one on the My Life page.</p> : goals.map((g) => (
      <div key={g.id} className="goal">
        <div className="row"><b className="grow">{g.name}</b><span className={`small ${g.done ? 'ok' : 'muted'}`}>{g.weekTotal}/{g.perWeek} {g.unit}</span></div>
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={g.perWeek} aria-valuenow={Math.min(g.weekTotal, g.perWeek)} aria-label={`${g.name} this week`}><i style={{ width: `${Math.min(100, (g.weekTotal / g.perWeek) * 100)}%`, background: g.done ? '#5cf0b0' : undefined }} /></div>
        <div className="row small">
          <button className="primary" onClick={() => a.run(async () => { await api(`/api/goals/${g.id}/log`, 'POST', { amount: 1 }); reload(); })}>+1</button>
          <button onClick={() => a.run(async () => { await api(`/api/goals/${g.id}/undo`, 'POST', {}); reload(); })} disabled={g.allTime === 0}>Undo</button>
          <span className="muted grow">{g.streakWeeks ? `${g.streakWeeks} week streak · ` : ''}last 5 weeks: {g.weeks.join(' · ')}</span>
          {!compact && <button aria-label={`Archive ${g.name}`} onClick={() => { if (confirm(`Archive "${g.name}"? Its history is kept but it disappears from this list.`)) void a.run(async () => { await api(`/api/goals/${g.id}`, 'DELETE'); reload(); }); }}>✕</button>}
        </div>
      </div>))}
  </div>;
}

export function LinksList({ compact = false }: { compact?: boolean }) {
  const { data, reload } = useLive<any>(() => api('/api/life'), ['life']); const a = useAct();
  const links: any[] = data?.links ?? [];
  if (!data) return <p className="muted small">Loading…</p>;
  return <div>
    {a.err && <p className="err small" role="alert">{a.err}</p>}
    {links.length === 0 ? <p className="muted small">No links yet. Add some on the My Life page.</p> : <ul className="plain links">{links.map((l) => (
      <li key={l.id} className="row"><a className="linkcard grow" href={l.url} target="_blank" rel="noopener noreferrer"><i aria-hidden="true">{l.title.slice(0, 1).toUpperCase()}</i><span><b>{l.title}</b><small className="muted"> {l.host} ↗</small></span></a>
        {!compact && <button aria-label={`Remove ${l.title}`} onClick={() => a.run(async () => { await api(`/api/links/${l.id}`, 'DELETE'); reload(); })}>✕</button>}</li>))}</ul>}
  </div>;
}

export function LifePage() {
  const { reload } = useLive<any>(() => api('/api/life'), ['life']); const a = useAct();
  const [gn, setGn] = useState(''), [gu, setGu] = useState('lessons'), [gp, setGp] = useState('5'), [ln, setLn] = useState(''), [lu, setLu] = useState('');
  const [hn, setHn] = useState(''), [hp, setHp] = useState('7'), [pn, setPn] = useState(''), [pr, setPr] = useState(''), [pe, setPe] = useState('30'), [pt, setPt] = useState('');
  return (
    <section className="page"><h1>My Life</h1>
      <p className="muted small">Things you check off yourself. Jarvis never guesses these, never sends them to the language model, and doesn't connect to any health or family account. You can also tell him in chat: "I did gym", "I talked to David".</p>
      {a.err && <p className="err" role="alert">{a.err}</p>}
      <div className="grid2">
        <div className="glass pad"><h2>Habits</h2><HabitsList />
          <form className="row wrap section" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/habits', 'POST', { name: hn, perWeek: Number(hp) }); setHn(''); reload(); }); }}>
            <input className="grow" placeholder="New habit (e.g. Gym)" value={hn} onChange={(e) => setHn(e.target.value)} maxLength={60} aria-label="Habit name" />
            <label className="small muted">days/week <select value={hp} onChange={(e) => setHp(e.target.value)}>{[1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n}>{n}</option>)}</select></label>
            <button className="primary" disabled={!hn.trim()}>Add</button></form>
        </div>
        <div className="glass pad"><h2>Staying in touch</h2><PeopleList />
          <form className="section" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/people', 'POST', { name: pn, relationship: pr, everyDays: pe ? Number(pe) : null, notes: pt }); setPn(''); setPr(''); setPt(''); reload(); }); }}>
            <div className="row wrap"><input className="grow" placeholder="Name" value={pn} onChange={(e) => setPn(e.target.value)} maxLength={80} aria-label="Person's name" /><input placeholder="Who they are (optional)" value={pr} onChange={(e) => setPr(e.target.value)} maxLength={60} aria-label="Relationship" /></div>
            <div className="row wrap" style={{ marginTop: 8 }}><label className="small muted">remind me every <input type="number" min={1} max={365} value={pe} onChange={(e) => setPe(e.target.value)} style={{ width: 70 }} /> days (blank = never)</label>
              <input className="grow" placeholder="Note (optional)" value={pt} onChange={(e) => setPt(e.target.value)} maxLength={500} aria-label="Note" /><button className="primary" disabled={!pn.trim()}>Add</button></div></form>
        </div>
      </div>
      <div className="grid2 section">
        <div className="glass pad"><h2>Learning goals</h2><p className="muted small">Weekly targets you log yourself, such as lessons, books or practice sessions. Weeks run Monday to Sunday.</p><LearningList />
          <form className="row wrap section" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/goals', 'POST', { name: gn, unit: gu || 'sessions', perWeek: Number(gp) || 1 }); setGn(''); reload(); }); }}>
            <input className="grow" placeholder="Goal (e.g. Campus lessons)" value={gn} onChange={(e) => setGn(e.target.value)} maxLength={60} aria-label="Goal name" />
            <input style={{ width: 90 }} value={gu} onChange={(e) => setGu(e.target.value)} maxLength={20} aria-label="Unit" placeholder="unit" />
            <label className="small muted">per week <input type="number" min={1} max={50} value={gp} onChange={(e) => setGp(e.target.value)} style={{ width: 64 }} /></label>
            <button className="primary" disabled={!gn.trim()}>Add</button></form></div>
        <div className="glass pad"><h2>Quick links</h2><p className="muted small">Bookmarks that open in a new tab. Jarvis doesn't visit them, log in, or read them: it's just a launcher.</p><LinksList />
          <form className="row wrap section" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { await api('/api/links', 'POST', { title: ln, url: lu }); setLn(''); setLu(''); reload(); }); }}>
            <input style={{ width: 150 }} placeholder="Name" value={ln} onChange={(e) => setLn(e.target.value)} maxLength={60} aria-label="Link name" />
            <input className="grow" placeholder="Web address (https://…)" value={lu} onChange={(e) => setLu(e.target.value)} maxLength={500} aria-label="Link address" />
            <button className="primary" disabled={!ln.trim() || !lu.trim()}>Add</button></form></div>
      </div>
      <div className="glass pad section"><h2>Health <span className="badge planned">Planned</span></h2><p className="muted small">No health or fitness data is connected, so nothing is shown here. Habits above are the only tracking, and you enter them yourself.</p></div>
    </section>
  );
}
