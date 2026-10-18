import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, connection, setCsrf, startEvents, stopEvents, useLive, usd, subscribe, type AppState } from './api.ts';
import { onSpeech, speechState } from './speech.ts';
import { Universe, type CoreState, type Route } from './Universe.tsx';
import { Chat, useConversation } from './Chat.tsx';
import { CommandCenter } from './CommandCenter.tsx';
import { Detail } from './Detail.tsx';
import { passkeySupported, signInWithPasskey } from './passkey.ts';
import { CalendarPage, NotesPage } from './mac.tsx';
import { LifePage } from './life.tsx';
import { PermissionsPage, StopButton } from './permissions.tsx';
import { ResearchPage } from './research.tsx';
import { SkillsPage } from './skills.tsx';
import { MissionsPage } from './missions.tsx';
import { WorkspacePage } from './workspace.tsx';
import { BriefingsPage, OvernightPage, ModeControl, Notifications } from './today.tsx';
import { TasksPage, ReviewPage, ApprovalsPage, MemoryPage, ConnectionsPage, ActivityPage, SettingsPage, PlannedPage } from './pages.tsx';

export const NAV: { hash: string; label: string; planned?: string }[] = [
  { hash: '#/command', label: 'Command Center' },
  { hash: '#/life', label: 'My Life' },
  { hash: '#/workspace', label: 'Modular Workspace' },
  { hash: '#/universe', label: 'Agent Universe' },
  { hash: '#/tasks', label: 'Tasks & Projects' },
  { hash: '#/calendar', label: 'Calendar' },
  { hash: '#/notes', label: 'Notes' },
  { hash: '#/briefings', label: 'Briefings' },
  { hash: '#/overnight', label: 'Overnight Plan' },
  { hash: '#/research', label: 'Prometheus' },
  { hash: '#/missions', label: 'Missions' },
  { hash: '#/review', label: 'Ready for Review' },
  { hash: '#/approvals', label: 'Approvals' },
  { hash: '#/memory', label: 'Memory' },
  { hash: '#/connections', label: 'Connections' },
  { hash: '#/skills', label: 'Skills' },
  { hash: '#/permissions', label: 'Permissions' },
  { hash: '#/activity', label: 'Activity' },
  { hash: '#/settings', label: 'Settings' },
];

function useHash() {
  const [h, setH] = useState(location.hash || '#/command');
  useEffect(() => { const f = () => setH(location.hash || '#/command'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}

function Login({ onDone, configured, passkeys, required }: { onDone: () => void; configured: boolean; passkeys: number; required: boolean }) {
  const [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const pkOk = passkeys > 0 && passkeySupported() && !/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname);
  const withPasskey = async () => { setBusy(true); setErr(''); try { await signInWithPasskey(); onDone(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); } };
  return (
    <main className="login">
      <form className="glass" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr('');
        try { const r = await api<{ csrf: string }>('/api/login', 'POST', { passphrase: pw }); setCsrf(r.csrf); onDone(); }
        catch (x) { setErr((x as Error).message); } finally { setBusy(false); setPw(''); }
      }}>
        <h1>JARVIS</h1>
        {!configured && <p className="warn">Not set up yet. Run <code>npm run setup</code> in the jarvis folder to create your passphrase.</p>}
        {pkOk && <button type="button" className="primary" disabled={busy} onClick={() => void withPasskey()}>Sign in with passkey</button>}
        {passkeys > 0 && !pkOk && <p className="muted small">Passkeys need a named address: open <code>http://localhost:{location.port}</code> rather than 127.0.0.1.</p>}
        {!required && <><label>Owner passphrase<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus={!pkOk} /></label>
        <button className="primary" disabled={busy || !pw}>Unlock</button></>}
        {required && <p className="muted small">Passphrase sign-in is turned off. To turn it back on, run <code>npm run setup -- --allow-passphrase</code> on the machine Jarvis runs on.</p>}
        {err && <p className="err" role="alert">{err}</p>}
      </form>
    </main>
  );
}

export function App() {
  const [auth, setAuth] = useState<'loading' | 'out' | 'in'>('loading');
  const [configured, setConfigured] = useState(true); const [pkInfo, setPkInfo] = useState({ passkeys: 0, required: false });
  useEffect(() => {
    api<any>('/api/me').then((m) => { if (m.authenticated) { setCsrf(m.csrf); setAuth('in'); } else { setConfigured(m.configured); setPkInfo({ passkeys: m.passkeys ?? 0, required: !!m.passkeyRequired }); setAuth('out'); } }).catch(() => setAuth('out'));
  }, []);
  useEffect(() => { if (auth === 'out') api<any>('/api/me').then((m) => { if (!m.authenticated) { setConfigured(m.configured); setPkInfo({ passkeys: m.passkeys ?? 0, required: !!m.passkeyRequired }); } }).catch(() => {}); }, [auth]);   // after Lock, learn what sign-in options exist
  if (auth === 'loading') return <div className="boot">Starting…</div>;
  if (auth === 'out') return <Login configured={configured} passkeys={pkInfo.passkeys} required={pkInfo.required} onDone={() => setAuth('in')} />;
  return <Shell onLogout={async () => { await api('/api/logout', 'POST', {}).catch(() => {}); stopEvents(); setAuth('out'); }} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const hash = useHash();
  const { data: st, reload } = useLive<AppState>(() => api('/api/state'), ['tasks', 'approvals', 'artifacts', 'system', 'budget']);
  const [, force] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [serverThinking, setServerThinking] = useState(false);
  const [, setSpeakTick] = useState(0);
  useEffect(() => subscribe((t, e) => { if (t === 'thinking') setServerThinking(!!e?.on); }), []);
  useEffect(() => onSpeech(() => setSpeakTick((n) => n + 1)), []);
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>(() => (localStorage.getItem('jv.quality') as any) || (typeof matchMedia !== 'undefined' && (matchMedia('(pointer: coarse)').matches || innerWidth < 768) ? 'low' : 'medium'));   // phones and tablets start light; Settings can raise it
  const osReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [reduced, setReduced] = useState(() => (localStorage.getItem('jv.reduced') ?? String(osReduced)) === 'true');
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [chatOpen, setChatOpen] = useState(true);
  const onUniverse = hash === '#/universe' || hash === '#/universe-full' || /^#\/(system|dept)\//.test(hash);
  useEffect(() => { setChatOpen(onUniverse); }, [onUniverse]);   // on content pages the chat folds away so it never covers buttons; one click reopens it
  useEffect(() => { startEvents(); const f = () => { force((n) => n + 1); reload(); }; connection.subs.add(f); return () => { connection.subs.delete(f); }; }, [reload]);
  useEffect(() => localStorage.setItem('jv.quality', quality), [quality]);
  useEffect(() => localStorage.setItem('jv.reduced', String(reduced)), [reduced]);
  const navigate = useCallback((h: string) => { location.hash = h; }, []);

  const route: Route = useMemo(() => {
    if (hash === '#/command') return { level: 'core' };
    const m = hash.match(/^#\/(system|dept)\/([\w-]+)/);
    if (!m || !st) return { level: 'universe' };
    if (m[1] === 'system') return { level: 'system', systemId: m[2] };
    const a = st.agents.find((x) => x.id === m[2]); return a?.parent_id ? { level: 'dept', systemId: a.parent_id, deptId: a.id } : { level: 'universe' };
  }, [hash, st]);

  const isUniverse = hash === '#/command' || hash === '#/universe' || hash === '#/universe-full' || /^#\/(system|dept)\//.test(hash);   // pages that show the 3D stage
  const isCore = route.level === 'core';
  const convo = useConversation(navigate, setThinking);
  // Travelling between Jarvis and the universe: the HUD fades out the moment the route changes and returns only after the camera has landed (no flash of it over the wrong scene).
  const [transit, setTransit] = useState(false); const prevCore = useRef(isCore);
  useLayoutEffect(() => { if (prevCore.current !== isCore) { prevCore.current = isCore; if (!reduced) setTransit(true); } }, [isCore, reduced]);
  useEffect(() => { if (!transit) return; const t = setTimeout(() => setTransit(false), 4600); return () => clearTimeout(t); }, [transit]);
  // Priority: no link > paused > speaking (real playback, momentary) > urgent alert > thinking (awaiting a reply) > executing tasks > waiting on you > idle
  const coreState: CoreState = !connection.up ? 'disconnected' : st?.pause.paused ? 'paused' : (speechState.speaking || speechState.typing) ? 'speaking' : (st?.counts.urgent ?? 0) > 0 ? 'urgent' : (thinking || serverThinking) ? 'thinking' : (st?.running.length ?? 0) > 0 ? 'working' : (st && (st.counts.approvals > 0 || st.counts.blocked > 0)) ? 'blocked' : 'idle';
  const active = useMemo(() => new Set((st?.running ?? []).length ? ['proj'] : []), [st]);
  const pageNav = NAV.find((n) => n.hash === hash);
  const crumbs: { label: string; hash: string }[] = [{ label: 'Universe', hash: '#/universe' }];
  if (st && route.systemId) crumbs.push({ label: st.agents.find((a) => a.id === route.systemId)?.name ?? '', hash: `#/system/${route.systemId}` });
  if (st && route.deptId) crumbs.push({ label: st.agents.find((a) => a.id === route.deptId)?.name ?? '', hash: `#/dept/${route.deptId}` });
  const back = () => navigate(crumbs.length > 1 ? crumbs[crumbs.length - 2].hash : '#/command');   // out of the universe = back into Jarvis

  // ---- flythrough controls: hop to the next/previous system (or department), and a guided tour of every system ----
  const mgrs = (st?.agents ?? []).filter((a) => a.role === 'manager');
  const sibs = route.level === 'system' ? mgrs : route.level === 'dept' ? (st?.agents ?? []).filter((a) => a.parent_id === route.systemId) : [];
  const curId = route.level === 'system' ? route.systemId : route.deptId;
  const hop = (d: number) => { if (sibs.length < 2) return; const i = sibs.findIndex((a) => a.id === curId); const n = sibs[(i + d + sibs.length) % sibs.length]; navigate(route.level === 'system' ? `#/system/${n.id}` : `#/dept/${n.id}`); };
  const [tour, setTour] = useState(false);
  const tourExpected = useRef('');
  useEffect(() => {
    if (!tour) return;
    const seq = ['#/universe', ...mgrs.map((m) => `#/system/${m.id}`), '#/universe']; let i = 0; let timer: number;
    const step = () => { if (i >= seq.length) { setTour(false); return; } tourExpected.current = seq[i]; navigate(seq[i]); i++; timer = window.setTimeout(step, 7000); };   // ~3s flight + ~4s to read the panel
    step(); return () => clearTimeout(timer);
  }, [tour]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tour && hash !== tourExpected.current) setTour(false); }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps  (any manual navigation ends the tour)
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.target as HTMLElement).matches('input,textarea,select')) return; if (e.key === 'ArrowRight') hop(1); else if (e.key === 'ArrowLeft') hop(-1); };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  });

  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">JARVIS</strong>
        <span className={`pill ${connection.up ? 'ok' : 'bad'}`}>{connection.up ? 'live link' : 'disconnected'}</span>
        {st?.pause.paused && <span className="pill warn">PAUSED{st.pause.inflight ? ` · ${st.pause.inflight} in flight` : ''}</span>}
        {st && <span className={`pill ${st.budget.level === 'ok' ? '' : 'warn'}`} title={st.budget.note}>{usd(st.budget.committedMicroUsd)} / {usd(st.budget.capMicroUsd)} this month</span>}
        {st && st.counts.approvals > 0 && <a className="pill warn" href="#/approvals">{st.counts.approvals} approval{st.counts.approvals > 1 ? 's' : ''} pending</a>}
        <span className="grow" />
        <ModeControl />
        <Notifications navigate={navigate} />
        <button className={st?.pause.paused ? 'primary' : 'danger'} onClick={() => api('/api/pause', 'POST', { paused: !st?.pause.paused }).then(reload)}>{st?.pause.paused ? 'Resume Jarvis' : 'Pause Jarvis'}</button>
        <StopButton reload={reload} />
        <button onClick={onLogout}>Lock</button>
      </header>
      <nav className="sidenav" aria-label="Main">
        {NAV.map((n) => {
          const cur = n.hash === hash || (n.hash === '#/universe' && isUniverse && !isCore);
          return <a key={n.hash} href={n.hash} aria-current={cur ? 'page' : undefined} className={n.planned ? 'planned' : ''}>{n.label}{n.planned && <small>planned</small>}</a>;
        })}
      </nav>
      <main className="main">
        {isUniverse && st && (
          <section className={`stage ${isCore ? 'core-mode' : ''}`} aria-label={isCore ? 'Jarvis command center' : 'Agent universe'}>
            <Universe onFlightEnd={() => setTransit(false)} agents={st.agents} coreState={coreState} quality={quality} reducedMotion={reduced} route={route} active={active} navigate={navigate} layoutVersion={layoutVersion} />
            <CommandCenter away={!isCore || transit} st={st} coreState={coreState} convo={convo} navigate={navigate} reduced={reduced} linkUp={connection.up} />
            {!isCore && !transit && <div className="crumbs glass">
              {crumbs.map((c, i) => <span key={c.hash}>{i > 0 && ' → '}{i === crumbs.length - 1 ? <b>{c.label}</b> : <a href={c.hash}>{c.label}</a>}</span>)}
              {crumbs.length > 1 && <button onClick={back} aria-label="Zoom out one level">Zoom out</button>}
              {sibs.length > 1 && <span className="tourbar"><button onClick={() => hop(-1)} aria-label={`Fly to previous ${route.level === 'system' ? 'system' : 'department'}`} title="Previous (←)">◀</button><button onClick={() => hop(1)} aria-label={`Fly to next ${route.level === 'system' ? 'system' : 'department'}`} title="Next (→)">▶</button></span>}
              {crumbs.length === 1 && <button onClick={() => { api('/api/layout', 'DELETE').then(() => setLayoutVersion((v) => v + 1)); }}>Reset layout</button>}
              {(crumbs.length === 1 || tour) && mgrs.length > 0 && <span className="tourbar">{tour ? <button className="primary" onClick={() => setTour(false)}>■ Stop tour</button> : <button onClick={() => setTour(true)} title="Fly through every system in turn">▶ Guided tour</button>}</span>}
            </div>}
            {(route.level === 'system' || route.level === 'dept') && <Detail st={st} route={route} navigate={navigate} />}
            <div className="frame" aria-hidden="true"><i /><i /><i /><i /></div>
            {!isCore && !transit && <div className="readout" aria-label="System readout">
              <span><b>{st.agents.filter((x) => x.status_kind === 'live').length}</b> LIVE</span>
              <span><b>{st.agents.filter((x) => x.status_kind === 'planned').length}</b> PLANNED</span>
              <span>TASKS <b>{st.counts.tasksActive}</b></span><span>APPROVALS <b>{st.counts.approvals}</b></span>
              <span className={connection.up ? 'up' : 'down'}>● {connection.up ? 'LINK NOMINAL' : 'LINK LOST'}</span>
              <span className="state">CORE · {coreState.toUpperCase()}</span>
            </div>}
            {!isCore && !transit && <div className="hint">Drag a system to rearrange · click to fly in · ← → hop between systems · Esc back to Jarvis</div>}
          </section>
        )}
        {!isUniverse && pageNav?.planned && <PlannedPage title={pageNav.label} text={pageNav.planned} />}
        {hash === '#/life' && <LifePage />}
        {hash === '#/workspace' && st && <WorkspacePage st={st} convo={convo} />}
        {hash === '#/calendar' && <CalendarPage />}
        {hash === '#/notes' && <NotesPage />}
        {hash === '#/briefings' && <BriefingsPage />}
        {hash === '#/overnight' && <OvernightPage />}
        {hash === '#/tasks' && <TasksPage />}
        {hash === '#/review' && <ReviewPage />}
        {hash === '#/approvals' && <ApprovalsPage />}
        {hash === '#/memory' && <MemoryPage />}
        {hash === '#/connections' && <ConnectionsPage />}
        {hash === '#/permissions' && <PermissionsPage />}
        {hash.startsWith('#/research') && <ResearchPage jobId={hash.split('/')[2]} />}
        {hash === '#/skills' && <SkillsPage />}
        {hash === '#/missions' && <MissionsPage />}
        {hash === '#/activity' && <ActivityPage />}
        {hash === '#/settings' && st && <SettingsPage st={st} reload={reload} quality={quality} setQuality={setQuality} reduced={reduced} setReduced={setReduced} osReduced={osReduced} resetLayout={() => api('/api/layout', 'DELETE').then(() => setLayoutVersion((v) => v + 1))} />}
      </main>
      <Chat open={chatOpen} setOpen={setChatOpen} convo={convo} hidden={isCore} />
      <Esc back={() => (tour ? setTour(false) : back())} enabled={isUniverse && !isCore} />
    </div>
  );
}

function Esc({ back, enabled }: { back: () => void; enabled: boolean }) {
  useEffect(() => { if (!enabled) return; const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).matches('input,textarea')) back(); }; addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, [back, enabled]);
  return null;
}
void ApiError;
