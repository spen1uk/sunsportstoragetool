import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, connection, setCsrf, startEvents, stopEvents, useLive, usd, type AppState } from './api.ts';
import { Universe, type CoreState, type Route } from './Universe.tsx';
import { Chat } from './Chat.tsx';
import { Detail } from './Detail.tsx';
import { TasksPage, ReviewPage, ApprovalsPage, MemoryPage, ConnectionsPage, ActivityPage, SettingsPage, PlannedPage } from './pages.tsx';

export const NAV: { hash: string; label: string; planned?: string }[] = [
  { hash: '#/universe', label: 'Command Center' },
  { hash: '#/life', label: 'My Life', planned: 'Phase 2. Personal life command center: habits, health and family context. Nothing is connected yet.' },
  { hash: '#/workspace', label: 'Modular Workspace', planned: 'Phase 2. Movable, resizable panels (conversation, calendar, previews, reports, files, tasks, charts, approvals) with saved layouts.' },
  { hash: '#/universe-full', label: 'Agent Universe' },
  { hash: '#/tasks', label: 'Tasks & Projects' },
  { hash: '#/calendar', label: 'Calendar', planned: 'Phase 2. Needs the Apple Calendar route verified first (provider backing, recurring events, busy/free, write behavior). A separate "Jarvis Tasks" calendar will hold Jarvis-owned blocks.' },
  { hash: '#/briefings', label: 'Briefings', planned: 'Phase 2. 8:00 a.m. briefing (2–3 min), 10:00 p.m. recap, guided tour. Needs manager reports and the contact-hours engine.' },
  { hash: '#/overnight', label: 'Overnight Plan', planned: 'Phase 2. Overnight queue with owner, desired morning result, dependencies, budget and approval holds. The task queue it will build on exists today.' },
  { hash: '#/review', label: 'Ready for Review' },
  { hash: '#/approvals', label: 'Approvals' },
  { hash: '#/memory', label: 'Memory' },
  { hash: '#/connections', label: 'Connections' },
  { hash: '#/activity', label: 'Activity' },
  { hash: '#/settings', label: 'Settings' },
];

function useHash() {
  const [h, setH] = useState(location.hash || '#/universe');
  useEffect(() => { const f = () => setH(location.hash || '#/universe'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

function Login({ onDone, configured }: { onDone: () => void; configured: boolean }) {
  const [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <form className="glass" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { const r = await api<{ csrf: string }>('/api/login', 'POST', { passphrase: pw }); setCsrf(r.csrf); onDone(); }
        catch (x) { setErr((x as Error).message); } finally { setBusy(false); setPw(''); }
      }}>
        <h1>JARVIS</h1>
        {!configured && <p className="warn">Not set up yet. Run <code>npm run setup</code> in the jarvis folder to create your passphrase.</p>}
        <label>Owner passphrase<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="primary" disabled={busy || !pw}>Unlock</button>
      </form>
    </main>
  );
}

export function App() {
  const [auth, setAuth] = useState<'loading' | 'out' | 'in'>('loading');
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    api<any>('/api/me').then((m) => { if (m.authenticated) { setCsrf(m.csrf); setAuth('in'); } else { setConfigured(m.configured); setAuth('out'); } }).catch(() => setAuth('out'));
  }, []);
  if (auth === 'loading') return <div className="boot">Starting…</div>;
  if (auth === 'out') return <Login configured={configured} onDone={() => setAuth('in')} />;
  return <Shell onLogout={async () => { await api('/api/logout', 'POST', {}).catch(() => {}); stopEvents(); setAuth('out'); }} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const hash = useHash();
  const { data: st, reload } = useLive<AppState>(() => api('/api/state'), ['tasks', 'approvals', 'artifacts', 'system', 'budget']);
  const [, force] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>(() => (localStorage.getItem('jv.quality') as any) || 'medium');
  const osReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [reduced, setReduced] = useState(() => (localStorage.getItem('jv.reduced') ?? String(osReduced)) === 'true');
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [chatOpen, setChatOpen] = useState(true);
  useEffect(() => { startEvents(); const f = () => { force((n) => n + 1); reload(); }; connection.subs.add(f); return () => { connection.subs.delete(f); }; }, [reload]);
  useEffect(() => localStorage.setItem('jv.quality', quality), [quality]);
  useEffect(() => localStorage.setItem('jv.reduced', String(reduced)), [reduced]);
  const navigate = useCallback((h: string) => { location.hash = h; }, []);

  const route: Route = useMemo(() => {
    const m = hash.match(/^#\/(system|dept)\/([\w-]+)/);
    if (!m || !st) return { level: 'universe' };
    if (m[1] === 'system') return { level: 'system', systemId: m[2] };
    const a = st.agents.find((x) => x.id === m[2]); return a?.parent_id ? { level: 'dept', systemId: a.parent_id, deptId: a.id } : { level: 'universe' };
  }, [hash, st]);

  const isUniverse = hash === '#/universe' || hash === '#/universe-full' || /^#\/(system|dept)\//.test(hash) || hash === '' ;
  const coreState: CoreState = !connection.up ? 'disconnected' : st?.pause.paused ? 'paused' : thinking ? 'thinking' : (st?.running.length ?? 0) > 0 ? 'working' : (st && (st.counts.approvals > 0 || st.counts.blocked > 0)) ? 'blocked' : 'idle';
  const active = useMemo(() => new Set((st?.running ?? []).length ? ['proj'] : []), [st]);
  const pageNav = NAV.find((n) => n.hash === hash);
  const crumbs: { label: string; hash: string }[] = [{ label: 'Universe', hash: '#/universe' }];
  if (st && route.systemId) crumbs.push({ label: st.agents.find((a) => a.id === route.systemId)?.name ?? '', hash: `#/system/${route.systemId}` });
  if (st && route.deptId) crumbs.push({ label: st.agents.find((a) => a.id === route.deptId)?.name ?? '', hash: `#/dept/${route.deptId}` });
  const back = () => navigate(crumbs.length > 1 ? crumbs[crumbs.length - 2].hash : '#/universe');

  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">JARVIS</strong>
        <span className={`pill ${connection.up ? 'ok' : 'bad'}`}>{connection.up ? 'live link' : 'disconnected'}</span>
        {st?.pause.paused && <span className="pill warn">PAUSED{st.pause.inflight ? ` · ${st.pause.inflight} in flight` : ''}</span>}
        {st && <span className={`pill ${st.budget.level === 'ok' ? '' : 'warn'}`} title={st.budget.note}>{usd(st.budget.committedMicroUsd)} / {usd(st.budget.capMicroUsd)} this month</span>}
        {st && st.counts.approvals > 0 && <a className="pill warn" href="#/approvals">{st.counts.approvals} approval{st.counts.approvals > 1 ? 's' : ''} pending</a>}
        <span className="grow" />
        <button className={st?.pause.paused ? 'primary' : 'danger'} onClick={() => api('/api/pause', 'POST', { paused: !st?.pause.paused }).then(reload)}>{st?.pause.paused ? 'Resume Jarvis' : 'Pause Jarvis'}</button>
        <button onClick={onLogout}>Lock</button>
      </header>
      <nav className="sidenav" aria-label="Main">
        {NAV.map((n) => {
          const cur = n.hash === hash || (n.hash === '#/universe' && isUniverse && hash !== '#/universe-full') || (n.hash === '#/universe-full' && hash === '#/universe-full');
          return <a key={n.hash} href={n.hash} aria-current={cur ? 'page' : undefined} className={n.planned ? 'planned' : ''}>{n.label}{n.planned && <small>planned</small>}</a>;
        })}
      </nav>
      <main className="main">
        {isUniverse && st && (
          <section className="stage" aria-label="Agent universe">
            <Universe agents={st.agents} coreState={coreState} quality={quality} reducedMotion={reduced} route={route} active={active} navigate={navigate} layoutVersion={layoutVersion} />
            <div className="crumbs glass">
              {crumbs.map((c, i) => <span key={c.hash}>{i > 0 && ' → '}{i === crumbs.length - 1 ? <b>{c.label}</b> : <a href={c.hash}>{c.label}</a>}</span>)}
              {crumbs.length > 1 && <button onClick={back} aria-label="Zoom out one level">Zoom out</button>}
              {crumbs.length === 1 && <button onClick={() => { api('/api/layout', 'DELETE').then(() => setLayoutVersion((v) => v + 1)); }}>Reset layout</button>}
            </div>
            {hash !== '#/universe-full' && <Detail st={st} route={route} navigate={navigate} />}
            <div className="hint">Drag a system to rearrange · click to zoom in · Esc to zoom out</div>
          </section>
        )}
        {!isUniverse && pageNav?.planned && <PlannedPage title={pageNav.label} text={pageNav.planned} />}
        {hash === '#/tasks' && <TasksPage />}
        {hash === '#/review' && <ReviewPage />}
        {hash === '#/approvals' && <ApprovalsPage />}
        {hash === '#/memory' && <MemoryPage />}
        {hash === '#/connections' && <ConnectionsPage />}
        {hash === '#/activity' && <ActivityPage />}
        {hash === '#/settings' && st && <SettingsPage st={st} reload={reload} quality={quality} setQuality={setQuality} reduced={reduced} setReduced={setReduced} osReduced={osReduced} resetLayout={() => api('/api/layout', 'DELETE').then(() => setLayoutVersion((v) => v + 1))} />}
      </main>
      <Chat open={chatOpen} setOpen={setChatOpen} navigate={navigate} setThinking={setThinking} />
      <Esc back={back} enabled={isUniverse && crumbs.length > 1} />
    </div>
  );
}

function Esc({ back, enabled }: { back: () => void; enabled: boolean }) {
  useEffect(() => { if (!enabled) return; const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).matches('input,textarea')) back(); }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, [back, enabled]);
  return null;
}
void ApiError;
