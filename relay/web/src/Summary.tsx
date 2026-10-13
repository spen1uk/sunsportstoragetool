import { useCallback, useEffect, useState } from 'react';
import { get, post, fmtTime } from './api';

const LABELS: [string, string][] = [['goal', 'Customer goal'], ['boat', 'Boats discussed'], ['budget', 'Budget'], ['preference', 'Preferences stated'], ['trade', 'Trade details'], ['date', 'Important dates mentioned'], ['decision', 'Decisions'], ['promise', 'Promises we made'], ['question_unanswered', 'Unanswered questions'], ['owes_next', 'Who owes the next response'], ['current_situation', 'Current situation'], ['next_action', 'Suggested next action']];
const STATUS_TEXT: Record<string, string> = { complete: 'Complete', partial: 'Partial', stale: 'Updating (stale)', failed: 'Failed', none: 'Not built yet' };

export function SummaryBox({ contactId, tick }: { contactId: string; tick: number }) {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => get(`/api/contacts/${contactId}/summary`).then(setD).catch((e) => setErr(e.message)), [contactId]);
  useEffect(() => { load(); }, [load, tick]);
  if (err) return <p className="error pad">{err}</p>; if (!d) return null;
  const cov = d.coverage;
  return (
    <section className="summary pad" aria-label="Conversation summary">
      <div className="rowtop"><h3>Summary — all history</h3><span className={`chip ${d.status === 'complete' ? 'good' : d.status === 'failed' ? 'bad' : 'warn'}`}>{STATUS_TEXT[d.status] ?? d.status}</span></div>
      {cov ? <p className="small muted">Covers {cov.messagesCovered} of {cov.messagesTotal} messages · {fmtTime(cov.historyStart)} → {fmtTime(cov.historyEnd)} · {cov.channels.join(', ') || 'sms'} · v{d.version}, updated {fmtTime(d.createdAt)} · {d.provider?.label}</p> : <p className="small muted">No summary yet. {d.status === 'none' ? 'It is built automatically once there are messages.' : ''}</p>}
      {d.status === 'partial' && <p className="banner warn small">Partial: processing stopped ({d.lastError}). Facts after the covered range are not included.</p>}
      {d.status === 'failed' && <p className="banner bad small">The last update failed ({d.lastError}); showing the previous version.</p>}
      {d.restricted && <p className="small muted">{d.restrictedNote}</p>}
      {LABELS.map(([k, label]) => d.fields[k] && (
        <div key={k} className="fact"><b>{label}</b>
          <ul>{d.fields[k].map((f: any) => (
            <li key={f.id} className={f.status === 'superseded' ? 'superseded' : ''}>
              <span>{f.value}</span>{f.status === 'superseded' && <span className="chip warn"> superseded</span>}{f.origin === 'derived' && <span className="chip"> derived</span>}
              {f.note && <div className="small muted">{f.note}</div>}
              {f.citations.length > 0 && <button className="linkbtn small" onClick={() => setOpen(open === f.id ? null : f.id)}>{open === f.id ? 'Hide' : 'Show'} source{f.citations.length > 1 ? 's' : ''} ({f.citations.length})</button>}
              {open === f.id && <ul className="cites">{f.citations.map((c: any) => <li key={c.messageId} className="small"><span className="muted">{c.direction === 'inbound' ? 'Customer' : 'Us'} · {fmtTime(c.at)}:</span> “{c.snippet}”</li>)}</ul>}
            </li>))}</ul></div>))}
      {d.status !== 'none' && <button onClick={async () => { await post(`/api/contacts/${contactId}/summary/rebuild`, { force: true }); load(); }}>Rebuild from scratch</button>}
    </section>
  );
}
