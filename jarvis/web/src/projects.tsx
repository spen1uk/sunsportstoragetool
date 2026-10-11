import { useState } from 'react';
import { api, ago, useLive } from './api.ts';

const STATUS_LABEL: Record<string, string> = { done: 'Done', canceled: 'Canceled', blocked: 'Blocked', overdue: 'Overdue', ready_to_confirm: 'Ready to confirm', at_risk: 'At risk', in_progress: 'In progress', not_started: 'Not started' };
const HEALTH_LABEL: Record<string, string> = { no_plan: 'No plan', complete: 'Complete', overdue: 'Overdue', blocked: 'Blocked', at_risk: 'At risk', on_track: 'On track' };
const day = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'no date');
const toMs = (v: string) => (v ? new Date(v + 'T17:00:00').getTime() : null);
const toInput = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '');
const Err = ({ m }: { m: string }) => (m ? <p className="err" role="alert">{m}</p> : null);

function Segments({ items }: { items: { status: string; title: string }[] }) {
  if (!items.length) return <div className="segs empty" aria-label="No milestones defined">no milestones</div>;
  return <div className="segs" role="img" aria-label={`${items.filter((i) => i.status === 'done').length} of ${items.length} milestones complete`}>{items.map((i, k) => <span key={k} className={`seg ${i.status}`} title={`${i.title}: ${STATUS_LABEL[i.status]}`} />)}</div>;
}

function ProjectDetail({ id, reloadList }: { id: string; reloadList: () => void }) {
  const { data: d, reload } = useLive<any>(() => api(`/api/projects/${id}`), ['projects', 'tasks'], [id]);
  const [err, setErr] = useState(''), [open, setOpen] = useState<string | null>(null), [ev, setEv] = useState('');
  const [title, setTitle] = useState(''), [due, setDue] = useState(''), [dep, setDep] = useState('');
  const run = async (f: () => Promise<unknown>) => { try { setErr(''); await f(); reload(); reloadList(); } catch (e) { setErr((e as Error).message); } };
  if (!d) return <p className="muted">Loading…</p>;
  const ms: any[] = d.milestones, openMs = ms.filter((m) => m.state === 'open');
  const unlinked = (d.tasks as any[]).filter((t) => !t.milestone_id && !['completed', 'canceled'].includes(t.state));
  return (
    <div className="pdetail">
      <Err m={err} />
      {ms.length === 0 && <p className="muted">No milestones yet. Add the checkpoints that prove this project is moving: Jarvis reports progress only from these, never from a guessed percentage.</p>}
      <ol className="mslist">
        {ms.map((m) => (
          <li key={m.id} className={`ms ${m.status}`}>
            <div className="row wrap">
              <span className={`mdot ${m.status}`} aria-hidden="true" />
              <strong className="grow">{m.title}</strong>
              <span className={`badge mstat ${m.status}`}>{STATUS_LABEL[m.status]}</span>
            </div>
            <div className="muted small">Due {day(m.due)}{m.blockedBy ? ` · waits for "${m.blockedBy}"` : ''} · tasks {m.tasks.done}/{m.tasks.total}{m.completed_at ? ` · completed ${ago(m.completed_at)}` : ''}</div>
            {m.linked.length > 0 && <ul className="plain small">{m.linked.map((t: any) => <li key={t.id}>{t.state === 'completed' ? '✓' : '○'} {t.title} <span className={`state ${t.state}`}>{t.state.replace('_', ' ')}</span></li>)}</ul>}
            {m.evidence && <pre className="evidence"><b>Evidence</b>{'\n'}{m.evidence}</pre>}
            {m.state === 'open' && (
              <div className="row wrap">
                {open === m.id ? (
                  <div className="grow">
                    {m.status === 'ready_to_confirm' && <p className="note small">Every linked task is finished. Confirm to record them as the evidence (add a note if you like).</p>}
                    <textarea rows={2} value={ev} onChange={(e) => setEv(e.target.value)} placeholder={m.status === 'ready_to_confirm' ? 'Optional note…' : 'What proves this is done? (required, 10+ characters)'} />
                    <div className="row"><button className="primary" onClick={() => run(async () => { await api(`/api/milestones/${m.id}/complete`, 'POST', { evidence: ev || undefined }); setOpen(null); setEv(''); })}>Confirm done</button><button onClick={() => { setOpen(null); setEv(''); }}>Cancel</button></div>
                  </div>
                ) : (<>
                  <button className={m.status === 'ready_to_confirm' ? 'primary' : ''} disabled={!!m.blockedBy} onClick={() => { setOpen(m.id); setEv(''); }}>{m.status === 'ready_to_confirm' ? 'Confirm done…' : 'Mark done…'}</button>
                  <label className="inline">Due <input type="date" style={{ width: 150 }} value={toInput(m.due)} onChange={(e) => run(() => api(`/api/milestones/${m.id}`, 'PATCH', { due: toMs(e.target.value) }))} /></label>
                  <button className="danger" onClick={() => run(() => api(`/api/milestones/${m.id}/cancel`, 'POST', {}))}>Cancel milestone</button>
                </>)}
              </div>
            )}
            {m.state !== 'open' && <button onClick={() => run(() => api(`/api/milestones/${m.id}/reopen`, 'POST', {}))}>Reopen</button>}
          </li>
        ))}
      </ol>
      <form className="row wrap addms" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api(`/api/projects/${id}/milestones`, 'POST', { title, due: toMs(due), dependsOn: dep || null }); setTitle(''); setDue(''); setDep(''); }); }}>
        <input className="grow" placeholder="New milestone (a checkpoint with a clear proof of done)" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <input type="date" style={{ width: 150 }} value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <select style={{ width: 190 }} value={dep} onChange={(e) => setDep(e.target.value)} aria-label="Depends on"><option value="">No dependency</option>{openMs.map((m) => <option key={m.id} value={m.id}>after: {m.title}</option>)}</select>
        <button className="primary" disabled={!title.trim()}>Add milestone</button>
      </form>
      {unlinked.length > 0 && openMs.length > 0 && (
        <details><summary>{unlinked.length} task(s) in this project aren't attached to a milestone</summary>
          <ul className="plain">{unlinked.map((t: any) => <li key={t.id} className="row">{t.title}<span className="grow" /><select style={{ width: 200 }} defaultValue="" onChange={(e) => e.target.value && run(() => api(`/api/tasks/${t.id}/milestone`, 'POST', { milestoneId: e.target.value }))}><option value="">Attach to…</option>{openMs.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></li>)}</ul></details>
      )}
    </div>
  );
}

export function ProjectsPanel() {
  const { data: projects, reload } = useLive<any[]>(() => api('/api/projects'), ['projects', 'tasks']);
  const [sel, setSel] = useState<string | null>(null), [title, setTitle] = useState(''), [err, setErr] = useState('');
  const [segs, setSegs] = useState<Record<string, any[]>>({});
  const loadSegs = async (id: string) => { try { const d = await api(`/api/projects/${id}`); setSegs((s) => ({ ...s, [id]: d.milestones.filter((m: any) => m.state !== 'canceled') })); } catch { /* ignore */ } };
  return (
    <div className="glass pad section">
      <h2>Projects &amp; milestones</h2><Err m={err} />
      <p className="muted small">Progress here is counted in finished milestones and the evidence behind them. There are no percentages: a project with no milestones says so.</p>
      {(projects ?? []).length === 0 && <p className="muted">No projects yet.</p>}
      <ul className="projects">
        {(projects ?? []).map((p) => {
          const pr = p.progress; if (!segs[p.id]) void loadSegs(p.id);
          return (
            <li key={p.id} className={`proj ${p.id === sel ? 'sel' : ''}`}>
              <button className="projhead" aria-expanded={p.id === sel} onClick={() => setSel(p.id === sel ? null : p.id)}>
                <span className="grow"><strong>{p.title}</strong> <span className="muted small">{p.scope}</span> {p.is_demo ? <span className="badge demo sm">DEMO</span> : null}</span>
                <span className={`badge health ${pr.health}`}>{HEALTH_LABEL[pr.health]}</span>
              </button>
              <div className="projbody">
                <Segments items={(segs[p.id] ?? []).map((m: any) => ({ status: m.status, title: m.title }))} />
                <div className="small">{pr.label}{pr.next ? <> · next: <b>{pr.next.title}</b> ({day(pr.next.due)})</> : null}{pr.overdue ? <span className="err"> · {pr.overdue} overdue</span> : null}{pr.readyToConfirm ? <span className="ok"> · {pr.readyToConfirm} ready to confirm</span> : null}</div>
              </div>
              {p.id === sel && <ProjectDetail id={p.id} reloadList={() => { reload(); void loadSegs(p.id); }} />}
            </li>
          );
        })}
      </ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); api('/api/projects', 'POST', { title }).then(() => { setTitle(''); reload(); }).catch((x) => setErr(x.message)); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New project" maxLength={200} /><button disabled={!title.trim()}>Add project</button>
      </form>
    </div>
  );
}
