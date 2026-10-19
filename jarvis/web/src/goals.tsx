import { useState } from 'react';
import { api, useLive } from './api.ts';

/** Suggested steps for a big task or goal. Nothing is created until you press Add. */
export function BreakdownBox({ title, detail, projectId, onDone, onClose }: { title: string; detail?: string; projectId?: string | null; onDone?: () => void; onClose: () => void }) {
  const [steps, setSteps] = useState<{ title: string; minutes: number; detail?: string; keep: boolean }[] | null>(null), [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const ask = async () => { setBusy(true); setMsg(null); try { const r = await api('/api/breakdown', 'POST', { title, detail }); setSteps(r.steps.map((s: any) => ({ ...s, keep: true }))); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); } };
  return (
    <div className="glass pad section" role="region" aria-label={`Steps for ${title}`}>
      <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">Break down: {title}</b><button onClick={onClose}>Close</button></div>
      {!steps && <><p className="muted small">Jarvis suggests a few small steps from the title and notes you wrote. It costs about a cent and creates nothing until you press Add.</p><button className="primary" disabled={busy} onClick={() => void ask()}>{busy ? 'Thinking…' : 'Suggest steps'}</button></>}
      {steps && <><ul className="plain small">{steps.map((s, i) => <li key={i}><label><input type="checkbox" checked={s.keep} onChange={() => setSteps(steps.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))} /> <b>{s.title}</b> <span className="muted">· about {s.minutes} min{s.detail ? ` · ${s.detail}` : ''}</span></label></li>)}</ul>
        <button className="primary" disabled={!steps.some((s) => s.keep)} onClick={async () => { try { const r = await api('/api/breakdown/apply', 'POST', { parentTitle: title, projectId: projectId ?? null, steps: steps.filter((s) => s.keep).map((s) => ({ title: s.title, minutes: s.minutes })) }); setMsg({ ok: true, t: `Added ${r.ids.length} task${r.ids.length === 1 ? '' : 's'}.` }); setSteps(null); onDone?.(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } }}>Add the ticked steps as tasks</button></>}
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
    </div>);
}

export function GoalsPage() {
  const { data, reload } = useLive<any>(() => api('/api/goals'), ['goals', 'tasks']);
  const { data: projects } = useLive<any[]>(() => api('/api/projects'), ['projects']);
  const [f, setF] = useState({ title: '', why: '', horizon: 'long', targetDate: '', ownerAgent: 'jarvis', projectId: '' }), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [bd, setBd] = useState<any>(null);
  if (!data) return <section className="page"><h1>Goals</h1><p className="muted">Loading…</p></section>;
  const run = async (fn: () => Promise<unknown>, ok: string) => { setMsg(null); try { await fn(); setMsg({ ok: true, t: ok }); await reload(); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } };
  const active = data.items.filter((g: any) => g.status === 'active'), past = data.items.filter((g: any) => g.status !== 'active');
  const card = (g: any) => (
    <div key={g.id} className="rcard" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
      <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{g.title}</b><span className="badge">{g.horizon === 'short' ? 'Short term' : 'Long term'}</span></div>
      {g.why && <p className="small muted">{g.why}</p>}
      <div className="small">{g.progress.linked ? (g.progress.total ? <>Milestones: <b>{g.progress.done} of {g.progress.total}</b> done{g.progress.next ? ` · next: ${g.progress.next}` : ''}</> : 'Linked to a project with no milestones yet.') : 'Not linked to a project yet.'}{g.projectTitle ? ` (${g.projectTitle})` : ''}{g.targetDate ? ` · target ${g.targetDate}` : ''} · owned by {data.agents.find((a: any) => a.id === g.ownerAgent)?.name ?? g.ownerAgent}</div>
      {g.obstacles.length > 0 && <ul className="small warn">{g.obstacles.map((o: string) => <li key={o}>{o}</li>)}</ul>}
      <div className="row wrap">
        {g.status === 'active' && <><select aria-label="Project" value={g.projectId ?? ''} onChange={(e) => void run(() => api(`/api/goals/${g.id}`, 'PATCH', { projectId: e.target.value || null }), 'Linked.')} style={{ width: 'auto' }}><option value="">No project</option>{(projects ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
          <select aria-label="Owner" value={g.ownerAgent} onChange={(e) => void run(() => api(`/api/goals/${g.id}`, 'PATCH', { ownerAgent: e.target.value }), 'Owner changed.')} style={{ width: 'auto' }}>{data.agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}<option value="prometheus">Prometheus</option></select>
          <button onClick={() => setBd(g)}>Break into steps</button><button onClick={() => void run(() => api(`/api/goals/${g.id}`, 'PATCH', { status: 'done' }), 'Marked done. Well done.')}>Done</button><button onClick={() => void run(() => api(`/api/goals/${g.id}`, 'PATCH', { status: 'dropped' }), 'Dropped.')}>Drop</button></>}
        {g.status !== 'active' && <button onClick={() => void run(() => api(`/api/goals/${g.id}`, 'PATCH', { status: 'active' }), 'Back on.')}>Reopen</button>}
        <button onClick={() => { if (confirm('Delete this goal?')) void run(() => api(`/api/goals/${g.id}`, 'DELETE'), 'Deleted.'); }}>Delete</button></div>
    </div>);
  return (
    <section className="page"><h1>Goals</h1>
      <p className="muted">What you are working towards. Link a goal to a project and its progress is the project's milestones (counted, never guessed). Jarvis points out what is in the way using your real tasks and dates.</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      {bd && <BreakdownBox title={bd.title} detail={bd.why} projectId={bd.projectId} onClose={() => setBd(null)} onDone={() => void reload()} />}
      <div className="glass pad section"><h2>Active</h2>{active.length === 0 ? <p className="muted small">No goals yet. Add one below.</p> : active.map(card)}</div>
      <div className="glass pad section"><h2>New goal</h2>
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="What do you want to achieve?" aria-label="Goal" maxLength={120} style={{ width: '100%' }} />
        <input value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} placeholder="Why it matters (optional)" aria-label="Why" maxLength={500} style={{ width: '100%' }} />
        <div className="row wrap"><select aria-label="Horizon" value={f.horizon} onChange={(e) => setF({ ...f, horizon: e.target.value })} style={{ width: 'auto' }}><option value="short">Short term</option><option value="long">Long term</option></select>
          <label className="small">Target date <input type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} style={{ width: 'auto' }} /></label>
          <select aria-label="Project" value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} style={{ width: 'auto' }}><option value="">No project yet</option>{(projects ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
          <select aria-label="Owner" value={f.ownerAgent} onChange={(e) => setF({ ...f, ownerAgent: e.target.value })} style={{ width: 'auto' }}>{data.agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}<option value="prometheus">Prometheus</option></select>
          <button className="primary" disabled={f.title.trim().length < 3} onClick={() => void run(async () => { await api('/api/goals', 'POST', { title: f.title, why: f.why, horizon: f.horizon, targetDate: f.targetDate || null, ownerAgent: f.ownerAgent, projectId: f.projectId || null }); setF({ ...f, title: '', why: '' }); }, 'Goal added.')}>Add goal</button></div></div>
      {past.length > 0 && <details className="section"><summary><b>Done and dropped ({past.length})</b></summary><div className="section">{past.map(card)}</div></details>}
    </section>);
}
