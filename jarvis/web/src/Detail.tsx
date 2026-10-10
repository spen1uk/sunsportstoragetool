import { api, useLive, ago, type Agent, type AppState } from './api.ts';
import type { Route } from './Universe.tsx';

const BADGE: Record<string, string> = {
  live: 'Live (local)', connected: 'Connected', planned: 'Planned — not connected', demo: 'Demo data', stale: 'Stale', disconnected: 'Disconnected',
};

export function Detail({ st, route, navigate }: { st: AppState; route: Route; navigate: (h: string) => void }) {
  if (route.level === 'universe') {
    return (
      <div className="detail glass compact">
        <h2>Universe</h2>
        <p className="muted">Jarvis is the only live system. Everything marked PLANNED has no data source connected and shows no numbers.</p>
        <dl className="kv">
          <dt>Active tasks</dt><dd>{st.counts.tasksActive}</dd><dt>Awaiting you</dt><dd>{st.counts.blocked}</dd>
          <dt>Ready for review</dt><dd><a href="#/review">{st.counts.review}</a></dd><dt>Pending approvals</dt><dd><a href="#/approvals">{st.counts.approvals}</a></dd>
        </dl>
      </div>
    );
  }
  const sys = st.agents.find((a) => a.id === route.systemId)!;
  const emps = st.agents.filter((a) => a.parent_id === sys?.id);
  if (route.level === 'system') {
    return (
      <div className="detail glass">
        <h2>{sys.name}</h2><Badge a={sys} />
        <p>{sys.description}</p>
        <h3>Departments</h3>
        {emps.length === 0 ? <p className="muted">No employee agents exist for this system yet.</p> :
          <ul className="plain">{emps.map((e) => <li key={e.id}><a href={`#/dept/${e.id}`}>{e.name}</a> <Badge a={e} small /></li>)}</ul>}
        {sys.status_kind === 'planned' && <p className="note">Performance, deadlines and reports will appear only after a real connection is established and tested.</p>}
      </div>
    );
  }
  const dept = st.agents.find((a) => a.id === route.deptId)!;
  return <Dept dept={dept} sys={sys} navigate={navigate} />;
}

function Badge({ a, small }: { a: Agent; small?: boolean }) {
  return <span className={`badge ${a.status_kind} ${small ? 'sm' : ''}`}>{BADGE[a.status_kind] ?? a.status_kind}</span>;
}

function Dept({ dept, sys }: { dept: Agent; sys: Agent; navigate: (h: string) => void }) {
  const live = dept.status_kind === 'live';
  const { data: tasks } = useLive<any[]>(() => api('/api/tasks'), ['tasks']);
  const { data: arts } = useLive<any[]>(() => api('/api/artifacts'), ['artifacts']);
  const mine = live && dept.id === 'proj-research' ? (tasks ?? []).filter((t) => t.kind !== 'manual') : [];
  const open = mine.filter((t) => !['completed', 'canceled'].includes(t.state));
  return (
    <div className="detail glass">
      <h2>{dept.name} <small className="muted">in {sys.name}</small></h2><Badge a={dept} />
      <p>{dept.description}</p>
      {!live ? <p className="note">No data source is connected, so there is no performance, activity, deadline or report data to show. This view is a placeholder for the planned department.</p> : (
        <>
          <h3>Current activity</h3>
          {open.length === 0 ? <p className="muted">Idle.</p> : <ul className="plain">{open.map((t) => <li key={t.id}><span className={`state ${t.state}`}>{t.state.replace('_', ' ')}</span> {t.title}{t.waiting_reason && <div className="muted small">{t.waiting_reason}</div>}</li>)}</ul>}
          <h3>Blockers</h3>
          {open.filter((t) => ['waiting_input', 'waiting_approval', 'failed'].includes(t.state)).length === 0 ? <p className="muted">None.</p> :
            <p>Items above waiting on you: <a href="#/approvals">approvals</a> · <a href="#/review">review</a></p>}
          <h3>Reports &amp; outputs</h3>
          {(arts ?? []).length === 0 ? <p className="muted">No outputs yet. Ask Jarvis to research something.</p> :
            <ul className="plain">{(arts ?? []).slice(0, 6).map((a) => <li key={a.id}><a href="#/review">{a.title}</a> <span className="muted small">v{a.current_version} · {a.status.replace('_', ' ')} · {ago(a.created_at)}</span></li>)}</ul>}
          <p className="muted small">Performance metrics: none defined for this worker yet.</p>
        </>
      )}
    </div>
  );
}
