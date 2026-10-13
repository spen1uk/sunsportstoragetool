import { useCallback, useEffect, useState } from 'react';
import { get, fmtTime } from './api';
import type { Me } from './App';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const Bar = ({ v, max, label }: { v: number; max: number; label: string }) => <div className="bar" role="img" aria-label={`${label}: ${v}`}><div style={{ width: `${max ? Math.max(2, (v / max) * 100) : 0}%` }} /></div>;
const Def = ({ text }: { text: string }) => <details className="def"><summary>Definition</summary><p className="small muted">{text}</p></details>;
const n = (v: number | null | undefined, unit = '') => (v == null ? '—' : `${v}${unit}`);

export function Analytics({ me }: { me: Me }) {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 29 * 86400_000))); const [to, setTo] = useState(iso(new Date(Date.now() + 86400_000))); const [d, setD] = useState<any>(null); const [err, setErr] = useState('');
  const load = useCallback(() => { setErr(''); get(`/api/analytics?from=${from}T00:00:00Z&to=${to}T00:00:00Z`).then(setD).catch((e) => setErr(e.message)); }, [from, to]); useEffect(() => { load(); }, [load]);
  const mgr = me.user.role !== 'staff';
  const exp = (r: string) => `/api/analytics/export?report=${r}&from=${from}T00:00:00Z&to=${to}T00:00:00Z`;
  if (err) return <div className="page"><p className="error" role="alert">{err}</p></div>; if (!d) return <div className="page"><p className="muted">Loading…</p></div>;
  const maxDay = Math.max(1, ...d.volume.byDay.map((x: any) => x.inbound + x.outbound)); const r = d.responsiveness;
  return (
    <div className="page">
      <h2>Analytics</h2>
      <div className="filters"><label className="inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label className="inline">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <span className="small muted">Timezone: {d.meta.timezone} · Scope: {d.meta.scope} · Generated {fmtTime(d.meta.generatedAt)} · Latest message in scope: {fmtTime(d.meta.dataThrough) || 'none'}</span></div>
      <p className="small muted">{d.meta.note}</p>
      <div className="cards">
        <div className="card stat"><div className="big">{r.unansweredNow.total}</div><div>Need our reply now</div><div className="small muted">{r.unansweredNow.over1h} over 1h · {r.unansweredNow.over24h} over 24h</div><Def text={d.definitions.unansweredNow} /></div>
        <div className="card stat"><div className="big">{n(r.firstHumanResponse.medianMinutes, ' min')}</div><div>Median first human reply</div><div className="small muted">p90 {n(r.firstHumanResponse.p90Minutes, ' min')} · {r.firstHumanResponse.answered} answered · {r.firstHumanResponse.stillWaiting} still waiting</div><Def text={d.definitions.firstHumanResponse} /></div>
        <div className="card stat"><div className="big">{d.volume.totals.inbound} / {d.volume.totals.outbound}</div><div>Messages in / out</div><Def text={d.definitions.volume} /></div>
        <div className="card stat"><div className="big">{d.tasks.overdue}</div><div>Overdue tasks</div><div className="small muted">{d.tasks.open} open · {d.tasks.completed_in_range} completed in range</div></div>
      </div>
      <section className="card section"><h3>Volume by day <span className="small muted">({d.meta.timezone})</span></h3>{d.volume.byDay.length === 0 ? <p className="muted">No messages in this range.</p> : <table className="tbl"><tbody>{d.volume.byDay.map((x: any) => <tr key={x.date}><td>{x.date}</td><td style={{ width: '60%' }}><Bar v={x.inbound + x.outbound} max={maxDay} label={x.date} /></td><td className="small">{x.inbound} in · {x.outbound} out</td></tr>)}</tbody></table>}
        <div className="grid2"><div><b className="small">By department</b>{d.volume.byDepartment.map((x: any) => <div key={x.department} className="small">{x.department}: {x.inbound} in / {x.outbound} out</div>)}</div><div><b className="small">By channel</b>{d.volume.byChannel.map((x: any) => <div key={x.channel} className="small">{x.channel}: {x.inbound} in / {x.outbound} out</div>)}</div>{mgr && <div><b className="small">Sent by staff</b>{d.volume.byTeamMember.map((x: any) => <div key={x.user} className="small">{x.user}: {x.sent}</div>)}</div>}</div>
        {mgr && <a className="small" href={exp('volume_by_day')}>Export CSV</a>}</section>
      <section className="card section"><h3>Delivery</h3><div className="chips">{d.delivery.byStatus.map((x: any) => <span key={x.status} className="chip">{x.status.replaceAll('_', ' ')}: {x.n}</span>)}{d.delivery.byStatus.length === 0 && <span className="muted small">No outbound messages.</span>}</div><Def text={d.definitions.delivery} />
        {d.delivery.problems.length > 0 && <table className="tbl"><thead><tr><th>Problem</th><th>Status</th><th>Count</th></tr></thead><tbody>{d.delivery.problems.map((x: any, i: number) => <tr key={i}><td>{x.reason}</td><td>{x.status}</td><td>{x.n}</td></tr>)}</tbody></table>}{mgr && <a className="small" href={exp('delivery_problems')}>Export CSV</a>}</section>
      <section className="card section"><h3>Automation</h3><Def text={d.definitions.automation} />
        {d.automation.autoMessages.map((x: any) => <div key={x.kind} className="small">{x.kind.replaceAll('_', ' ')}: {x.sent} sent · customer wrote within 48h after {x.replied_48h}</div>)}
        {d.automation.runs.length === 0 ? <p className="muted small">No automation runs in this range.</p> : <table className="tbl"><thead><tr><th>Automation</th><th>Outcome</th><th>Runs</th></tr></thead><tbody>{d.automation.runs.map((x: any, i: number) => <tr key={i}><td>{x.workflow}</td><td>{x.status}{x.reason && ` — ${x.reason.replaceAll('_', ' ')}`}</td><td>{x.n}</td></tr>)}</tbody></table>}
        {mgr && d.automation.broadcasts.length > 0 && <><h4>Broadcasts</h4><table className="tbl"><thead><tr><th>Name</th><th>Recipients</th><th>Sent</th><th>Delivered</th><th>Failed</th><th>Not sent</th><th>Replied 48h</th></tr></thead><tbody>{d.automation.broadcasts.map((x: any) => <tr key={x.id}><td>{x.name}</td><td>{x.recipients}</td><td>{x.sent}</td><td>{x.delivered}</td><td>{x.failed}</td><td>{x.not_sent}</td><td>{x.replied_48h}</td></tr>)}</tbody></table></>}</section>
      <section className="card section"><h3>Estimated operating costs</h3><Def text={d.definitions.costs} />
        <p>SMS: ~{d.costs.sms.estimatedSegments} segments → {d.costs.sms.estimatedUsd != null ? `$${d.costs.sms.estimatedUsd}` : 'cost unknown'} <span className="small muted">{d.costs.sms.note}</span></p>
        {mgr && <p>AI: {d.costs.ai.byProvider.length ? d.costs.ai.byProvider.map((x: any) => `${x.provider}: ${x.calls} call(s), $${x.known_usd.toFixed(4)} recorded${x.unknown_cost_calls ? `, ${x.unknown_cost_calls} with unknown cost` : ''}`).join('; ') : 'no AI usage recorded'}</p>}</section>
      <section className="card section"><h3>Not available yet</h3><ul className="small muted">{Object.values(d.unavailable).map((t: any) => <li key={t}>{t}</li>)}</ul></section>
    </div>
  );
}
