import { useState } from 'react';
import { api, useLive, usd } from './api.ts';

const when = (t: number | null) => (t ? new Date(t).toLocaleString() : 'never');
/** The big red switch, shown in the top bar: pauses Jarvis and removes every outside way in. Your own sign-in and your data stay. */
export function StopButton({ reload }: { reload: () => void }) {
  const [msg, setMsg] = useState('');
  return (
    <>
      <button className="danger" title="Pause Jarvis and revoke every device key, the Mac helper and every standing permission" onClick={async () => {
        if (!confirm('STOP EVERYTHING?\n\nThis pauses Jarvis and revokes every device key, the Mac-helper credential and every standing permission, and turns web search off. Your data and your own sign-in stay. You can resume afterwards and set things up again.')) return;
        try { const r = await api('/api/emergency-stop', 'POST', { confirm: true }); setMsg(`Stopped. Revoked ${r.devicesRevoked} device key(s), ${r.standingRevoked} standing permission(s)${r.helperRevoked ? ', and the Mac helper' : ''}.${r.jobsStillFinishing ? ` ${r.jobsStillFinishing} job(s) already running will finish their current step.` : ''}`); reload(); }
        catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
      }}>Stop everything</button>
      {msg && <span className="small" role="status" style={{ marginLeft: 8 }}>{msg}</span>}
    </>
  );
}

/** One read-only page showing who and what may do what right now. */
export function PermissionsPage() {
  const { data: d } = useLive<any>(() => api('/api/permissions'), ['system', 'approvals', 'devices']);
  if (!d) return <section className="page"><h1>Permissions</h1><p className="muted">Loading…</p></section>;
  const sw = d.switches;
  return (
    <section className="page"><h1>Permissions</h1>
      <p className="muted">Everything that is allowed to act, in one place. This page only shows; change things on the pages linked in each box. The server enforces all of this; none of it is just a request to the model.</p>
      <div className="glass pad section"><h2>Switches</h2>
        <ul className="plain small">
          <li>Jarvis: <b className={sw.paused ? 'warn' : ''}>{sw.paused ? 'PAUSED (no new automated work)' : 'running'}</b></li>
          <li>Web search: <b>{sw.webSearch.enabled ? `on (${sw.webSearch.usedToday}/${sw.webSearch.perDay} today)` : 'off'}</b> · Passkeys set up: <b>{sw.passkeys}</b> <a href="#/settings">Settings ›</a></li>
        </ul>
      </div>
      <div className="glass pad section"><h2>Devices <a className="small" href="#/settings">manage ›</a></h2>
        {d.devices.length === 0 ? <p className="muted small">No devices.</p> : <table className="small"><thead><tr><th>Name</th><th>Kind</th><th>Can do</th><th>Status</th><th>Last seen</th><th>This month</th></tr></thead><tbody>{d.devices.map((x: any) => <tr key={x.id}><td>{x.name}</td><td>{x.kind}</td><td>{x.scopes.join(', ')}</td><td>{x.status}</td><td>{when(x.lastSeen)}</td><td>{usd(x.spentMicroUsd)} of {usd(x.limitMicroUsd)}</td></tr>)}</tbody></table>}
        <p className="muted small">Mac helper: {d.helper.configured ? `credential active, last seen ${when(d.helper.lastSeen)}` : 'no credential'} (it can only read Calendar and Notes and fetch encrypted backups).</p>
      </div>
      <div className="glass pad section"><h2>Standing permissions <a className="small" href="#/approvals">manage ›</a></h2>
        {d.standing.length === 0 ? <p className="muted small">None. Every chat suggestion needs your Confirm click.</p> : <ul className="plain small">{d.standing.map((s: any) => <li key={s.id}>{s.type}: up to {s.perDay}/day on {s.channels.join(', ')} · {s.status}{s.status === 'active' ? ` until ${when(s.expiresAt)}` : ''}</li>)}</ul>}
        <p className="muted small">Only these kinds can ever be granted: {d.standingEligible.join(', ')}.</p>
      </div>
      <div className="glass pad section"><h2>Protected actions (always need your approval)</h2>
        <ul className="plain small">{d.protectedActions.map((a: any) => <li key={a.type}><b>{a.type}</b> · {a.risk} risk · {a.runnable ? 'can run once approved' : <span className="warn">cannot run: {a.why}</span>}</li>)}</ul>
        <p className="muted small">Chat suggestions Jarvis can make (each waits for your Confirm): {d.chatSuggestionKinds.join(', ')}.</p>
      </div>
      <div className="glass pad section"><h2>Skills <a className="small" href="#/skills">manage ›</a></h2>
        <p className="small">Every capability agents have is catalogued on the Skills page: who may use each one, which version is live, and the history. Agents can never grant themselves a skill.</p>
      </div>
      <div className="glass pad section"><h2>Websites Jarvis may fetch ({d.domains.length})</h2>
        {d.domains.length === 0 ? <p className="muted small">None yet; each new site asks you first.</p> : <p className="small">{d.domains.map((x: any) => x.host).join(' · ')}</p>}
      </div>
      <div className="glass pad section"><h2>Temporary agents &amp; missions <a className="small" href="#/missions">manage ›</a></h2>
        <p className="small">{d.tempAgents.length === 0 ? 'No temporary agents are running.' : `${d.tempAgents.length} temporary agent(s) running: ${d.tempAgents.map((a: any) => a.name).join(', ')}.`} Each has its own small allowance, may use only the read-only skills it was given, and is removed automatically.</p>
        <p className="small">Self-started research this month: {usd(d.exploration.spent)} of {usd(d.exploration.cap)} (nothing starts by itself except the watches you create).</p>
      </div>
      <div className="glass pad section"><h2>Mission budgets</h2>
        <p className="small">Defaults: quick lookup {usd(d.budgetDefaults.quickMicro)} · deep project {usd(d.budgetDefaults.deepMicro)} · self-started exploration {usd(d.budgetDefaults.exploreMonthlyMicro)} a month in total. The monthly cap and daily ceiling always apply on top.</p>
        {d.missionBudgets.length > 0 && <ul className="plain small">{d.missionBudgets.map((m: any) => <li key={m.ref}>{m.label}: {usd(m.spentMicroUsd)} of {usd(m.capMicroUsd)}{m.closed ? ' (closed)' : ''}</li>)}</ul>}
      </div>
      <div className="glass pad section"><h2>Never grantable</h2>
        <ul className="small">{d.neverGrantable.map((x: string) => <li key={x}>{x}</li>)}</ul>
      </div>
    </section>
  );
}
