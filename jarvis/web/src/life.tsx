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

export function LifePage() {
  const { reload } = useLive<any>(() => api('/api/life'), ['life']); const a = useAct();
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
      <div className="glass pad section"><h2>Health <span className="badge planned">Planned</span></h2><p className="muted small">No health or fitness data is connected, so nothing is shown here. Habits above are the only tracking, and you enter them yourself.</p></div>
    </section>
  );
}
