import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, useLive, usd, type AppState } from './api.ts';
import { greeting, statusLine } from './greeting.ts';
import type { Conversation } from './Chat.tsx';
import { supported } from './speech.ts';
import type { CoreState } from './Universe.tsx';

const TZ = 'America/Chicago';
const clock = (d: Date) => d.toLocaleTimeString('en-US', { timeZone: TZ, hour12: false });
const dateLine = (d: Date) => d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
const due = (t: number) => new Date(t).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });

function useClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => { const i = setInterval(() => { if (!document.hidden) setT(new Date()); }, 1000); return () => clearInterval(i); }, []);
  return t;
}

/** Holographic panel: numbered header, corner ticks, staggered boot-in. */
function Holo({ n, title, delay, children, className = '' }: { n: number; title: string; delay: number; children: ReactNode; className?: string }) {
  return (
    <section className={`holo ${className}`} style={{ animationDelay: `${delay}ms` }} aria-label={title}>
      <header><i>{String(n).padStart(2, '0')}</i><span>{title}</span></header>
      <div className="holo-body">{children}</div>
    </section>
  );
}

/** Reveals text like a terminal readout, for replies that arrive while you are looking. Instant when reduced motion is on. */
function Typed({ text, animate }: { text: string; animate: boolean }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) { setN(text.length); return; }
    let raf = 0; const t0 = performance.now();
    const f = (t: number) => { const k = Math.min(text.length, Math.floor(((t - t0) / 1000) * 110)); setN(k); if (k < text.length) raf = requestAnimationFrame(f); };
    raf = requestAnimationFrame(f); return () => cancelAnimationFrame(raf);
  }, [text, animate]);
  return <>{text.slice(0, n)}{n < text.length && <span className="caret">▌</span>}</>;
}

const RING_LABELS: { a: number; key: string }[] = [{ a: -38, key: 'core' }, { a: -8, key: 'link' }, { a: 22, key: 'tasks' }, { a: 62, key: 'model' }, { a: 118, key: 'approvals' }, { a: 242, key: 'mode' }];

export function CommandCenter(p: { st: AppState; coreState: CoreState; convo: Conversation; navigate: (h: string) => void; reduced: boolean; linkUp: boolean }) {
  const { st, coreState, convo, navigate, reduced, linkUp } = p;
  const now = useClock();
  const { data: today } = useLive<any>(() => api('/api/today'), ['tasks', 'approvals', 'artifacts', 'system', 'mode']);
  const { data: tasks } = useLive<any[]>(() => api('/api/tasks'), ['tasks']);
  const { data: llm } = useLive<any>(() => api('/api/llm'), ['chat', 'budget']);
  const sir: string = convo.persona?.addressAs ?? 'sir';

  // Messages that were already there when this screen opened appear instantly; only replies arriving afterwards are typed out.
  const seen = useRef<Set<string | number> | null>(null);
  if (seen.current === null && convo.msgs.length > 0) seen.current = new Set(convo.msgs.map((m) => m.id));
  const lines = convo.msgs.slice(-4);
  const lastJarvis = [...convo.msgs].reverse().find((m) => m.role === 'jarvis');

  const open = (tasks ?? []).filter((t) => t.kind === 'manual' && !t.is_demo && !['completed', 'canceled'].includes(t.state)).sort((a, b) => a.priority - b.priority).slice(0, 5);
  const blocks: any[] = today?.briefing.schedule.blocks.slice(0, 3) ?? [];
  const urgent: any[] = today?.briefing.sections[0].items.slice(0, 3) ?? [];
  const contact = today?.contact;
  const mgrs = st.agents.filter((a) => a.role === 'manager');
  const keyOk = llm?.providers?.some((x: any) => x.configured);
  const labels: Record<string, string> = {
    core: `CORE · ${coreState.toUpperCase()}`, link: linkUp ? 'LINK · NOMINAL' : 'LINK · LOST', tasks: `TASKS · ${st.counts.tasksActive}`,
    model: keyOk ? 'MODEL · ONLINE' : 'MODEL · COMMAND MODE', approvals: `DECISIONS · ${st.counts.approvals}`, mode: `MODE · ${(contact?.mode ?? 'normal').toUpperCase()}`,
  };
  const chips: [string, () => void][] = [
    ['What should I do first?', () => convo.send('What should I do first today?')], ["What's urgent?", () => convo.send("What's urgent right now?")],
    ['Status', () => convo.send('status')], ['Open the Agent Universe', () => navigate('#/universe')],
  ];

  return (
    <div className={`cc s-${coreState}`}>
      <div className="cc-top">
        <div className="cc-greet"><h1>{greeting(now, sir)}</h1><p>{statusLine({ approvals: st.counts.approvals, review: st.counts.review, blocked: st.counts.blocked, running: st.running.length, paused: st.pause.paused })}</p></div>
        <div className="cc-actions"><button className="primary" onClick={() => navigate('#/universe')}>Agent Universe ›</button><button onClick={() => navigate('#/briefings')}>Full briefing</button></div>
      </div>

      <div className="cc-rings" aria-hidden="true">
        <svg viewBox="-300 -300 600 600">
          <g className="rg a"><circle r="288" className="tick" /><circle r="288" className="thin" /></g>
          <g className="rg b"><circle r="262" className="arc a1" /><circle r="262" className="arc a2" /><circle r="262" className="arc a3" /></g>
          <g className="rg c"><circle r="236" className="dots" /></g>
          <circle r="214" className="thin" /><circle r="168" className="thin faint" />
        </svg>
        {RING_LABELS.map((l) => <span key={l.key} className="rl" style={{ ['--a' as any]: `${l.a}deg` }}><b>{labels[l.key]}</b></span>)}
        <div className="cc-name">J.A.R.V.I.S.</div>
      </div>

      <div className="cc-col left">
        <Holo n={1} title="TODAY" delay={150}>
          <div className="clock">{clock(now)}<small> CT</small></div><div className="muted small">{dateLine(now)}</div>
          {contact && <div className="row wrap small"><span className={`pill ${contact.decision.hold ? 'warn' : 'ok'}`}>{contact.decision.hold ? 'interruptions held' : contact.decision.channels.join(' · ')}</span></div>}
          <div className="mini">{blocks.length ? blocks.map((b) => <div key={b.taskId}><b>{b.day.split(',')[0]} {b.when.split('–')[0]}</b> {b.title}</div>) : <span className="muted">No work blocks proposed.</span>}</div>
        </Holo>
        <Holo n={2} title="YOUR TASKS" delay={300}>
          {open.length === 0 ? <span className="muted small">No open tasks.</span> : open.map((t) => <a key={t.id} className="trow" href="#/tasks"><i className={`pdot p${t.priority}`} />{t.title}{t.deadline ? <small>{due(t.deadline)}</small> : null}</a>)}
        </Holo>
      </div>

      <div className="cc-col right">
        <Holo n={3} title="NEEDS ATTENTION" delay={220} className={st.counts.urgent ? 'alert' : ''}>
          {st.counts.approvals === 0 && st.counts.review === 0 && urgent.length === 0 ? <span className="muted small">Nothing needs you.</span> : <>
            {st.counts.approvals > 0 && <a className="trow" href="#/approvals"><i className="pdot p1" />{st.counts.approvals} approval{st.counts.approvals > 1 ? 's' : ''} pending</a>}
            {st.counts.review > 0 && <a className="trow" href="#/review"><i className="pdot p3" />{st.counts.review} ready for review</a>}
            {urgent.filter((u) => !/^Decision needed/.test(u.text)).map((u, i) => <a key={i} className="trow" href={u.link ?? '#/briefings'}><i className="pdot p2" />{u.text}</a>)}</>}
        </Holo>
        <Holo n={4} title="SYSTEMS" delay={380}>
          {mgrs.map((m) => <button key={m.id} className="srow" onClick={() => navigate(`#/system/${m.id}`)}><i className={`dot ${m.status_kind}`} />{m.name}<small>{m.status_kind === 'live' ? 'LIVE' : m.status_kind.toUpperCase()}</small></button>)}
        </Holo>
        <Holo n={5} title="MIND & SPEND" delay={460}>
          <div className="small">{keyOk ? <><b>Language model online</b></> : <>Command mode <span className="muted">(no model key)</span></>}</div>
          {llm && <div className="small muted">Today {usd(llm.usage.today.cost)} of {usd(llm.config.dailyCeilingMicroUsd)} · {llm.usage.today.calls} calls</div>}
          <div className="small muted">Month {usd(st.budget.committedMicroUsd)} of {usd(st.budget.capMicroUsd)}{st.budget.level !== 'ok' ? ` · ${st.budget.level}` : ''}</div>
        </Holo>
      </div>

      <div className="cc-convo">
        {lines.length > 0 && <div className="cc-lines" role="log" aria-live="polite">
          {lines.map((m) => <div key={m.id} className={`cl ${m.role}`}><b>{m.role === 'jarvis' ? 'JARVIS' : 'YOU'}</b><span><Typed text={m.content} animate={!reduced && m.role === 'jarvis' && m.id === lastJarvis?.id && seen.current !== null && !seen.current.has(m.id)} /></span></div>)}
        </div>}
        <div className="cc-chips">{chips.map(([l, f]) => <button key={l} className="chip" disabled={convo.busy && l !== 'Open the Agent Universe'} onClick={f}>{l}</button>)}</div>
        <form className={`cc-input ${convo.priv ? 'private' : ''}`} onSubmit={(e) => { e.preventDefault(); void convo.send(); }}>
          <input autoFocus value={convo.text} onChange={(e) => convo.setText(e.target.value)} placeholder={convo.busy ? 'Jarvis is thinking…' : `Speak to Jarvis, ${sir}…`} aria-label="Message to Jarvis" maxLength={2000} />
          {supported() && <label className="check" title="Read replies aloud (British voice, on this Mac)"><input type="checkbox" checked={convo.aloud} onChange={(e) => convo.setAloud(e.target.checked)} /> Speak</label>}
          <label className="check" title="Private: nothing saved"><input type="checkbox" checked={convo.priv} onChange={(e) => convo.setPriv(e.target.checked)} /> Private</label>
          <button type="button" disabled title="Voice input arrives later; not faked here.">🎙</button>
          <button className="primary" disabled={convo.busy || !convo.text.trim()}>Send</button>
        </form>
        <div className="cc-foot muted small">{convo.meta ? `last reply: ${convo.meta}` : 'commands run instantly and free; anything else goes to the model'}{convo.priv ? ' · private session' : ''}</div>
      </div>
    </div>
  );
}
