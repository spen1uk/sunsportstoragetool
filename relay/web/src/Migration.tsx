import { useCallback, useEffect, useState } from 'react';
import { get, post, put, fmtTime } from './api';
import type { Me } from './App';

const KIND_HELP: Record<string, string> = { contacts: 'Customer list (names, numbers, opt-out flags)', messages: 'Message history (one row per text)', consents: 'Opt-out / opt-in list', templates: 'Saved reply templates' };

export function Migration({ me }: { me: Me }) {
  const [tab, setTab] = useState<'imports' | 'checklist'>('imports');
  return (
    <div className="page">
      <h2>Kenect migration</h2>
      <div className="banner" role="note">Preparation only. Nothing here sends a text, changes your phone number or routing, contacts Kenect or RingCentral, or cancels anything. Imports are staged and previewed first; opt-outs are always kept.</div>
      <div className="tabs" role="tablist">{(['imports', 'checklist'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t === 'imports' ? 'Import data' : 'Cutover checklist'}</button>)}</div>
      {tab === 'imports' ? <Imports /> : <Checklist isOwner={me.user.role === 'owner'} />}
    </div>
  );
}

function Imports() {
  const [list, setList] = useState<any[]>([]); const [cur, setCur] = useState<any>(null); const [up, setUp] = useState<any>(null); const [kind, setKind] = useState('contacts');
  const [mapping, setMapping] = useState<Record<string, string>>({}); const [tz, setTz] = useState(''); const [dirWords, setDirWords] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(''); const [rows, setRows] = useState<{ status: string; items: any[] } | null>(null);
  const load = useCallback(() => get('/api/migration/imports').then(setList).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>) => { setErr(''); setBusy(true); try { await fn(); await load(); } catch (e: any) { setErr(e.body?.problems ? `${e.message}: ${e.body.problems.join('; ')}` : e.message); } finally { setBusy(false); } };
  const open = async (id: string) => { setUp(null); setRows(null); setConfirm(''); setCur(await get(`/api/migration/imports/${id}`)); };
  const options = () => ({ timezone: tz || undefined, directionMap: dirWords.trim() ? Object.fromEntries(dirWords.split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2 && ['inbound', 'outbound'].includes(p[1]))) : undefined });
  const c = cur?.counts;

  return (
    <>
      <section className="card section"><h3>1. Upload a CSV</h3>
        <p className="muted small">Kenect’s real export format has not been seen. Upload what Kenect gives you; you’ll map its columns next. The original file is kept untouched.</p>
        <div className="formgrid"><label>What is in the file?<select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND_HELP).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>CSV file<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; run(async () => { const fd = new FormData(); fd.append('kind', kind); fd.append('file', f); const res = await fetch('/api/migration/imports', { method: 'POST', headers: { 'x-relay-csrf': '1' }, body: fd, credentials: 'same-origin' }); const d = await res.json(); if (!res.ok) throw new Error(d.error); setUp(d); setCur(null); setMapping(d.suggestedMapping); setRows(null); }); e.target.value = ''; }} /></label></div>
      </section>

      {up && (
        <section className="card section"><h3>2. Match the columns</h3>
          <p className="small muted">{up.rowCount} rows, columns: {up.headers.join(', ')}. Check each suggestion; required fields are marked *.</p>
          <div className="formgrid">{up.fields.map((f: any) => <label key={f.key}>{f.label}{f.required ? ' *' : ''}<select value={mapping[f.key] ?? ''} onChange={(e) => { const m = { ...mapping }; if (e.target.value) m[f.key] = e.target.value; else delete m[f.key]; setMapping(m); }}><option value="">— not in file —</option>{up.headers.map((h: string) => <option key={h}>{h}</option>)}</select></label>)}</div>
          {(up.kind === 'messages' || up.kind === 'consents' || up.kind === 'contacts') && <div className="formgrid"><label>Time zone for dates without one (blank = business timezone)<input value={tz} placeholder="America/Chicago" onChange={(e) => setTz(e.target.value)} /></label>{up.kind === 'messages' && <label>Extra direction words (e.g. agent=outbound, lead=inbound)<input value={dirWords} onChange={(e) => setDirWords(e.target.value)} /></label>}</div>}
          <details><summary className="small">First rows of the file</summary><table className="tbl"><tbody>{up.sample.map((r: string[], i: number) => <tr key={i}>{r.map((x, j) => <td key={j} className="small">{x}</td>)}</tr>)}</tbody></table></details>
          <button className="primary" disabled={busy} onClick={() => run(async () => { const b = await post(`/api/migration/imports/${up.id}/stage`, { mapping, options: options() }); setCur(b); setUp(null); })}>Check the file (nothing is imported yet)</button>
        </section>
      )}
      {err && <div className="banner warn" role="alert">{err}</div>}

      {cur && (
        <section className="card section"><h3>3. Preview — {cur.filename} <span className="small muted">({cur.kind}, {cur.status})</span></h3>
          {cur.status === 'uploaded' ? <p className="muted">Not checked yet.</p> : (<>
            {c?.warnings && Object.keys(c.warnings).map((w) => <div key={w} className="banner warn" role="alert">⚠ {w.replaceAll('_', ' ')}{c.warnings[w] > 1 ? ` (${c.warnings[w]} rows)` : ''}</div>)}
            <table className="tbl"><tbody>
              <tr><td>Rows in file</td><td>{c.total}</td></tr><tr><td>Will be imported</td><td>{c.valid}</td></tr><tr><td>Need a look (shared numbers, odd tokens)</td><td>{c.review}</td></tr><tr><td>Duplicates (skipped)</td><td>{c.duplicate}</td></tr><tr><td>Errors (skipped)</td><td>{c.error}</td></tr>
              <tr><td>New contacts / matching existing</td><td>{c.contactsToCreate ?? 0} / {c.contactsMatched ?? 0}</td></tr><tr><td>Opt-outs that will be kept</td><td>{c.optOuts ?? 0}</td></tr>
              {c.dateRange && <tr><td>Messages dated</td><td>{c.dateRange.map((d: string) => fmtTime(d)).join(' → ')} · read in {c.timezoneAssumed} when no zone is given</td></tr>}
              {c.noHistoryContacts > 0 && <tr><td>New contacts without any message history</td><td>{c.noHistoryContacts}</td></tr>}
            </tbody></table>
            {c.byReason && Object.keys(c.byReason).length > 0 && <p className="small">Why rows are skipped: {Object.entries(c.byReason).map(([k, v]) => `${k.replaceAll('_', ' ')} ×${v}`).join(' · ')}</p>}
            <div className="row">{['error', 'review', 'duplicate'].map((s) => <button key={s} onClick={async () => setRows({ status: s, items: await get(`/api/migration/imports/${cur.id}/rows?status=${s}&limit=100`) })}>Show {s} rows</button>)}<a href={`/api/migration/imports/${cur.id}/not-imported.csv`} className="btn">Download “not imported” list</a></div>
            {rows && <table className="tbl"><tbody>{rows.items.length === 0 ? <tr><td className="muted">None.</td></tr> : rows.items.map((r) => <tr key={r.row_no}><td>row {r.row_no}</td><td className="small">{r.reason}</td><td className="small muted">{Object.values(r.raw).join(' · ')}</td></tr>)}</tbody></table>}
            {cur.status === 'staged' && <div className="card section"><h4>4. Import for real</h4><p className="small">This creates the contacts / history shown above. Imported history is closed, unassigned and silent: no texts are sent, nobody is notified, no follow-ups start. You can roll it back afterwards (opt-outs are never rolled back).</p>
              <label>Type COMMIT to confirm<input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label> <button className="primary" disabled={busy || confirm !== 'COMMIT'} onClick={() => run(async () => { await post(`/api/migration/imports/${cur.id}/commit`, { confirm }); await open(cur.id); })}>Import now</button></div>}
            {cur.status === 'committed' && <div className="card section"><h4>Imported</h4><pre className="small">{JSON.stringify(cur.result, null, 1)}</pre><label>Type ROLLBACK to undo what this import created<input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label> <button className="danger" disabled={busy || confirm !== 'ROLLBACK'} onClick={() => run(async () => { await post(`/api/migration/imports/${cur.id}/rollback`, { confirm }); await open(cur.id); })}>Roll back</button></div>}
            {cur.status === 'rolled_back' && <div className="banner">Rolled back {fmtTime(cur.rolledBackAt)}: <code>{JSON.stringify(cur.result?.rollback)}</code></div>}
          </>)}
        </section>
      )}

      <section className="card section"><h3>Previous imports</h3>
        {list.length === 0 ? <p className="muted">None yet.</p> : list.map((b) => <div key={b.id} className="trow"><span>{b.filename} · {b.kind} · <strong>{b.status}</strong> · {fmtTime(b.createdAt)}</span><button onClick={() => open(b.id)}>Open</button></div>)}
      </section>
    </>
  );
}

function Checklist({ isOwner }: { isOwner: boolean }) {
  const [cl, setCl] = useState<any>(null); const [ev, setEv] = useState<Record<string, string>>({}); const [err, setErr] = useState(''); const [days, setDays] = useState(14);
  const load = useCallback(() => get('/api/migration/checklist').then((d) => { setCl(d); setDays(d.validationDays); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const set = async (key: string, status: string) => { setErr(''); try { await put(`/api/migration/checklist/${key}`, { status, evidence: ev[key] }); await load(); } catch (e: any) { setErr(`${key}: ${e.message}`); } };
  if (!cl) return <p className="muted">{err || 'Loading…'}</p>;
  const cats = [...new Set(cl.items.map((i: any) => i.category))] as string[];
  return (
    <>
      <div className="banner" role="note">{cl.notice}</div>
      <p className="small">Progress: {cl.summary.done} of {cl.summary.required} required items recorded. {cl.readiness.readyForOwnerGoDecision ? '✔ Everything before the owner go decision is recorded.' : 'Not ready for the owner go decision yet.'} {cl.readiness.kenectCancellationApproved ? 'Kenect cancellation approval is recorded.' : 'Kenect cancellation is NOT approved.'}</p>
      {isOwner && <div className="row"><label className="inline">Validation window after cutover (days)<input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 70 }} /></label><button onClick={async () => { try { await put('/api/migration/validation-days', { days }); await load(); } catch (e: any) { setErr(e.message); } }}>Save</button></div>}
      {err && <div className="banner warn" role="alert">{err}</div>}
      {cats.map((cat) => (
        <section key={cat} className="card section"><h3>{cat}</h3>
          {cl.items.filter((i: any) => i.category === cat).map((i: any) => (
            <div key={i.key} className="card section" style={{ marginTop: 8 }}>
              <div className="trow"><strong>{i.status === 'passed' ? '✔ ' : i.status === 'waived' ? '⊘ ' : '○ '}{i.title}{i.optional ? ' (optional)' : ''}</strong><span className="small muted">{i.ownerOnly ? 'owner only · ' : ''}{i.status}{i.updatedAt ? ` ${fmtTime(i.updatedAt)}` : ''}</span></div>
              <p className="small muted">{i.detail}</p>
              {i.autoCheck && <p className={`small ${i.autoCheck.ok ? '' : 'warn'}`}>Relay’s own check: {i.autoCheck.ok ? '✔' : '✖'} {i.autoCheck.detail}</p>}
              {i.blockedBy.length > 0 && i.status === 'pending' && <p className="small muted">Waiting for: {i.blockedBy.join(', ')}</p>}
              {i.waitUntil && <p className="small muted">Validation window open until {fmtTime(i.waitUntil)}.</p>}
              {i.evidence && <p className="small">Evidence: {i.evidence}</p>}
              {i.status === 'pending' ? <><textarea rows={2} placeholder="Evidence: what was checked, by whom, when" value={ev[i.key] ?? ''} onChange={(e) => setEv({ ...ev, [i.key]: e.target.value })} aria-label={`Evidence for ${i.title}`} />
                <div className="row"><button className="primary" disabled={i.ownerOnly && !isOwner} onClick={() => set(i.key, 'passed')}>Record as done</button>{isOwner && <button onClick={() => set(i.key, 'waived')}>Waive (owner)</button>}</div></>
                : <button onClick={() => set(i.key, 'pending')} disabled={i.ownerOnly && !isOwner}>Reopen</button>}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
