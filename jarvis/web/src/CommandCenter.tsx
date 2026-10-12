import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, useLive, usd, type AppState } from './api.ts';
import { greeting, statusLine } from './greeting.ts';
import type { Conversation } from './Chat.tsx';
import { supported, speechState, emitSpeech } from './speech.ts';
import type { CoreState } from './Universe.tsx';

const TZ = 'America/Chicago';
const clock = (d: Date) => d.toLocaleTimeString('en-US', { timeZone: TZ, hour12: false });
const dateLine = (d: Date) => d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });
const due = (t: number) => new Date(t).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });

const WAVE = <><line key="0" x1="104.0" y1="0.0" x2="110.0" y2="0.0" /><line key="1" x1="103.4" y1="10.9" x2="109.4" y2="11.5" /><line key="2" x1="101.7" y1="21.6" x2="107.6" y2="22.9" /><line key="3" x1="98.9" y1="32.1" x2="104.6" y2="34.0" /><line key="4" x1="95.0" y1="42.3" x2="100.5" y2="44.7" /><line key="5" x1="90.1" y1="52.0" x2="95.3" y2="55.0" /><line key="6" x1="84.1" y1="61.1" x2="89.0" y2="64.7" /><line key="7" x1="77.3" y1="69.6" x2="81.7" y2="73.6" /><line key="8" x1="69.6" y1="77.3" x2="73.6" y2="81.7" /><line key="9" x1="61.1" y1="84.1" x2="64.7" y2="89.0" /><line key="10" x1="52.0" y1="90.1" x2="55.0" y2="95.3" /><line key="11" x1="42.3" y1="95.0" x2="44.7" y2="100.5" /><line key="12" x1="32.1" y1="98.9" x2="34.0" y2="104.6" /><line key="13" x1="21.6" y1="101.7" x2="22.9" y2="107.6" /><line key="14" x1="10.9" y1="103.4" x2="11.5" y2="109.4" /><line key="15" x1="0.0" y1="104.0" x2="0.0" y2="110.0" /><line key="16" x1="-10.9" y1="103.4" x2="-11.5" y2="109.4" /><line key="17" x1="-21.6" y1="101.7" x2="-22.9" y2="107.6" /><line key="18" x1="-32.1" y1="98.9" x2="-34.0" y2="104.6" /><line key="19" x1="-42.3" y1="95.0" x2="-44.7" y2="100.5" /><line key="20" x1="-52.0" y1="90.1" x2="-55.0" y2="95.3" /><line key="21" x1="-61.1" y1="84.1" x2="-64.7" y2="89.0" /><line key="22" x1="-69.6" y1="77.3" x2="-73.6" y2="81.7" /><line key="23" x1="-77.3" y1="69.6" x2="-81.7" y2="73.6" /><line key="24" x1="-84.1" y1="61.1" x2="-89.0" y2="64.7" /><line key="25" x1="-90.1" y1="52.0" x2="-95.3" y2="55.0" /><line key="26" x1="-95.0" y1="42.3" x2="-100.5" y2="44.7" /><line key="27" x1="-98.9" y1="32.1" x2="-104.6" y2="34.0" /><line key="28" x1="-101.7" y1="21.6" x2="-107.6" y2="22.9" /><line key="29" x1="-103.4" y1="10.9" x2="-109.4" y2="11.5" /><line key="30" x1="-104.0" y1="0.0" x2="-110.0" y2="0.0" /><line key="31" x1="-103.4" y1="-10.9" x2="-109.4" y2="-11.5" /><line key="32" x1="-101.7" y1="-21.6" x2="-107.6" y2="-22.9" /><line key="33" x1="-98.9" y1="-32.1" x2="-104.6" y2="-34.0" /><line key="34" x1="-95.0" y1="-42.3" x2="-100.5" y2="-44.7" /><line key="35" x1="-90.1" y1="-52.0" x2="-95.3" y2="-55.0" /><line key="36" x1="-84.1" y1="-61.1" x2="-89.0" y2="-64.7" /><line key="37" x1="-77.3" y1="-69.6" x2="-81.7" y2="-73.6" /><line key="38" x1="-69.6" y1="-77.3" x2="-73.6" y2="-81.7" /><line key="39" x1="-61.1" y1="-84.1" x2="-64.7" y2="-89.0" /><line key="40" x1="-52.0" y1="-90.1" x2="-55.0" y2="-95.3" /><line key="41" x1="-42.3" y1="-95.0" x2="-44.7" y2="-100.5" /><line key="42" x1="-32.1" y1="-98.9" x2="-34.0" y2="-104.6" /><line key="43" x1="-21.6" y1="-101.7" x2="-22.9" y2="-107.6" /><line key="44" x1="-10.9" y1="-103.4" x2="-11.5" y2="-109.4" /><line key="45" x1="-0.0" y1="-104.0" x2="-0.0" y2="-110.0" /><line key="46" x1="10.9" y1="-103.4" x2="11.5" y2="-109.4" /><line key="47" x1="21.6" y1="-101.7" x2="22.9" y2="-107.6" /><line key="48" x1="32.1" y1="-98.9" x2="34.0" y2="-104.6" /><line key="49" x1="42.3" y1="-95.0" x2="44.7" y2="-100.5" /><line key="50" x1="52.0" y1="-90.1" x2="55.0" y2="-95.3" /><line key="51" x1="61.1" y1="-84.1" x2="64.7" y2="-89.0" /><line key="52" x1="69.6" y1="-77.3" x2="73.6" y2="-81.7" /><line key="53" x1="77.3" y1="-69.6" x2="81.7" y2="-73.6" /><line key="54" x1="84.1" y1="-61.1" x2="89.0" y2="-64.7" /><line key="55" x1="90.1" y1="-52.0" x2="95.3" y2="-55.0" /><line key="56" x1="95.0" y1="-42.3" x2="100.5" y2="-44.7" /><line key="57" x1="98.9" y1="-32.1" x2="104.6" y2="-34.0" /><line key="58" x1="101.7" y1="-21.6" x2="107.6" y2="-22.9" /><line key="59" x1="103.4" y1="-10.9" x2="109.4" y2="-11.5" /></>;   // 60 voice bars around the core; lengths are driven live while Jarvis speaks

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
const played = new Set<string | number>();   // replies already written out once are never replayed (e.g. when you come back to this screen)
function Typed({ id, text, animate0 }: { id: string | number; text: string; animate0: boolean }) {
  const animate = animate0 && !played.has(id);
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) { setN(text.length); return; }
    let raf = 0; const t0 = performance.now(); speechState.typing = true; emitSpeech();   // Jarvis is "talking" for as long as his reply is being written out
    const f = (t: number) => { const k = Math.min(text.length, Math.floor(((t - t0) / 1000) * 110)); setN(k); if (k < text.length) { speechState.level = Math.max(speechState.level, 0.35 + Math.random() * 0.65); raf = requestAnimationFrame(f); } else { played.add(id); speechState.typing = false; emitSpeech(); } };
    raf = requestAnimationFrame(f); return () => { cancelAnimationFrame(raf); if (speechState.typing) { speechState.typing = false; emitSpeech(); } };
  }, [text, animate, id]);
  return <>{text.slice(0, n)}{n < text.length && <span className="caret">▌</span>}</>;
}

const RING_LABELS: { a: number; key: string }[] = [{ a: -30, key: 'core' }, { a: -2, key: 'link' }, { a: 26, key: 'tasks' }, { a: 128, key: 'approvals' }, { a: 235, key: 'mode' }];

export function CommandCenter(p: { away: boolean; st: AppState; coreState: CoreState; convo: Conversation; navigate: (h: string) => void; reduced: boolean; linkUp: boolean }) {
  const { st, coreState, convo, navigate, reduced, linkUp, away } = p;
  const now = useClock();
  const wave = useRef<SVGGElement>(null);
  // Voice ring: while Jarvis is speaking (real playback, or his reply being written out) the bars dance to the live speech level; otherwise they rest flat.
  useEffect(() => {
    const g = wave.current; if (!g) return; const bars = Array.from(g.children) as SVGLineElement[]; let raf = 0;
    const tick = (t: number) => {
      const on = speechState.speaking || speechState.typing, lvl = on ? Math.max(0.25, speechState.level) : 0;
      speechState.level *= 0.9;
      bars.forEach((b, i) => {
        const a = (i * 6 * Math.PI) / 180, n = 0.5 + 0.5 * Math.sin(t / 90 + i * 1.7) * Math.sin(t / 230 - i * 0.6), len = 6 + lvl * 34 * (0.25 + 0.75 * n);
        b.setAttribute('x2', (Math.cos(a) * (104 + len)).toFixed(1)); b.setAttribute('y2', (Math.sin(a) * (104 + len)).toFixed(1));
      });
      g.style.opacity = on ? '1' : '0'; if (!reduced || on) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [reduced, coreState]);
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
  const appts: any[] = (today?.briefing?.schedule?.appointments ?? []).filter((a: any) => a.day === today?.briefing?.schedule?.appointments?.[0]?.day);
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
    <div className={`cc s-${coreState}${away ? ' away' : ''}`} aria-hidden={away}>
      <div className="cc-top">
        <div className="cc-greet"><h1>{greeting(now, sir)}</h1><p>{statusLine({ approvals: st.counts.approvals, review: st.counts.review, blocked: st.counts.blocked, running: st.running.length, paused: st.pause.paused })}</p></div>
        <div className="cc-actions"><button className="primary" onClick={() => navigate('#/universe')}>Agent Universe ›</button><button onClick={() => navigate('#/briefings')}>Full briefing</button></div>
      </div>

      <div className="cc-rings" aria-hidden="true">
        <svg viewBox="-300 -300 600 600">
          <g className="spokes"><line x1="150.0" y1="0.0" x2="298.0" y2="0.0" /><line x1="129.9" y1="75.0" x2="258.1" y2="149.0" /><line x1="75.0" y1="129.9" x2="149.0" y2="258.1" /><line x1="0.0" y1="150.0" x2="0.0" y2="298.0" /><line x1="-75.0" y1="129.9" x2="-149.0" y2="258.1" /><line x1="-129.9" y1="75.0" x2="-258.1" y2="149.0" /><line x1="-150.0" y1="0.0" x2="-298.0" y2="0.0" /><line x1="-129.9" y1="-75.0" x2="-258.1" y2="-149.0" /><line x1="-75.0" y1="-129.9" x2="-149.0" y2="-258.1" /><line x1="-0.0" y1="-150.0" x2="-0.0" y2="-298.0" /><line x1="75.0" y1="-129.9" x2="149.0" y2="-258.1" /><line x1="129.9" y1="-75.0" x2="258.1" y2="-149.0" /><line x1="-300" y1="0" x2="-130" y2="0" className="o" /><line x1="130" y1="0" x2="300" y2="0" className="o" /></g>
          <g ref={wave} className="wave">{WAVE}</g>
          <g className="rg a"><circle r="292" className="tick" /><circle r="286" className="thin" /></g>
          <g className="rg b"><circle r="270" className="arc a1" /><circle r="270" className="arc a2" /><circle r="270" className="arc a3" /></g>
          <g className="rg d"><circle r="252" className="arc o1" /><circle r="252" className="arc o2" /><circle r="252" className="dash" /></g>
          <g className="rg c"><circle r="228" className="dots" /><circle r="205" className="tick2" /></g>
          <g className="rg e"><circle r="186" className="arc a2" /><circle r="186" className="arc o3" /></g>
          <circle r="160" className="thin" /><circle r="132" className="thin faint" />
          <g className="rg b"><circle cx="0" cy="-270" r="4" className="node" /><circle cx="270" cy="0" r="3" className="node o" /><circle cx="-190" cy="190" r="3.5" className="node" /></g>
        </svg>
        {RING_LABELS.map((l) => <span key={l.key} className="rl" style={{ ['--a' as any]: `${l.a}deg` }}><b>{labels[l.key]}</b></span>)}
        <div className="cc-name">J.A.R.V.I.S.</div>
      </div>

      <div className="cc-col left">
        <Holo n={1} title="TODAY" delay={150}>
          <div className="clock">{clock(now)}<small> CT</small></div><div className="muted small">{dateLine(now)}</div>
          {contact && <div className="row wrap small"><span className={`pill ${contact.decision.hold ? 'warn' : 'ok'}`}>{contact.decision.hold ? 'interruptions held' : contact.decision.channels.join(' · ')}</span></div>}
          {appts.length > 0 && <div className="mini">{appts.slice(0, 3).map((a: any) => <div key={a.calendar + a.start + a.title}><b>{a.when === 'all day' ? 'All day' : a.when.split('–')[0]}</b> {a.title}</div>)}</div>}
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
          {lines.map((m) => <div key={m.id} className={`cl ${m.role}`}><b>{m.role === 'jarvis' ? 'JARVIS' : 'YOU'}</b><span><Typed id={m.id} text={m.content} animate0={!reduced && m.role === 'jarvis' && m.id === lastJarvis?.id && !away && seen.current !== null && !seen.current.has(m.id)} /></span></div>)}
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
