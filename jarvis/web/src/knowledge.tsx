import { useState } from 'react';
import { api, useLive } from './api.ts';
import { stepUpWithPasskey } from './passkey.ts';

const REL = (r: string) => r.replace('_', ' ');
const RATING: Record<string, string> = { better: 'Better than expected', as_expected: 'About as expected', worse: 'Worse than expected' };
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/** A small radial picture of one record and what it is connected to. */
function EgoGraph({ centre, edges, onPick }: { centre: any; edges: any[]; onPick: (id: string) => void }) {
  const W = 360, H = 260, cx = W / 2, cy = H / 2, R = 95, n = Math.min(edges.length, 10);
  const pts = edges.slice(0, n).map((e, i) => ({ e, x: cx + R * 1.3 * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), y: cy + R * Math.sin((2 * Math.PI * i) / n - Math.PI / 2) }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${centre.name} and its connections`} style={{ width: '100%', maxWidth: 420 }}>
      {pts.map(({ e, x, y }) => <g key={e.edge}><line x1={cx} y1={cy} x2={x} y2={y} stroke="currentColor" strokeOpacity={0.15 + 0.4 * e.confidence} strokeDasharray={e.origin === 'derived' ? '4 3' : undefined} />
        <text x={(cx + x) / 2} y={(cy + y) / 2} fontSize="8" textAnchor="middle" fill="currentColor" opacity="0.6">{REL(e.rel)}</text></g>)}
      {pts.map(({ e, x, y }) => <g key={e.entity.id} onClick={() => onPick(e.entity.id)} style={{ cursor: 'pointer' }} tabIndex={0} onKeyDown={(k) => { if (k.key === 'Enter') onPick(e.entity.id); }}><circle cx={x} cy={y} r="22" fill="none" stroke="currentColor" strokeOpacity="0.5" /><text x={x} y={y + 3} fontSize="8.5" textAnchor="middle" fill="currentColor">{e.entity.name.length > 12 ? e.entity.name.slice(0, 11) + '…' : e.entity.name}</text></g>)}
      <circle cx={cx} cy={cy} r="30" fill="currentColor" fillOpacity="0.12" stroke="currentColor" /><text x={cx} y={cy + 3} fontSize="10" fontWeight="600" textAnchor="middle" fill="currentColor">{centre.name.length > 14 ? centre.name.slice(0, 13) + '…' : centre.name}</text>
    </svg>
  );
}

export function KnowledgePage() {
  const { data, reload } = useLive<any>(() => api('/api/knowledge'), ['knowledge', 'memory']);
  const dec = useLive<any>(() => api('/api/decisions'), ['knowledge']);
  const ret = useLive<any>(() => api('/api/knowledge/retention'), ['knowledge']);
  const exc = useLive<any>(() => api('/api/exclusions'), ['knowledge']);
  const [q, setQ] = useState(''), [res, setRes] = useState<any>(null), [sel, setSel] = useState<any>(null), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [pw, setPw] = useState('');
  const [ne, setNe] = useState({ kind: 'topic', name: '', notes: '' }), [pattern, setPattern] = useState(''), [edit, setEdit] = useState<{ id: string; notes: string } | null>(null);
  const [nd, setNd] = useState({ title: '', context: '', options: '', assumptions: '', expectedOutcome: '', expectedBy: '', confidence: '', scen: '' });
  const [chosen, setChosen] = useState<Record<string, string>>({}), [outcome, setOutcome] = useState<Record<string, string>>({}), [rating, setRating] = useState<Record<string, string>>({});
  const [win, setWin] = useState<Record<string, string>>({});
  if (!data || !dec.data) return <section className="page"><h1>Knowledge</h1><p className="muted">Loading…</p></section>;
  const run = async (f: () => Promise<unknown>, ok: string) => { setMsg(null); try { await f(); setMsg({ ok: true, t: ok }); } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : String(e) }); } };
  const post = (p: string, b: unknown = {}) => api(p, 'POST', b);
  const confirm1 = async () => { if (pw) { await api('/api/stepup', 'POST', { passphrase: pw }); setPw(''); } else await stepUpWithPasskey(); };
  const search = async (text = q) => { setSel(null); setRes(text.trim().length >= 2 ? await api(`/api/knowledge?q=${encodeURIComponent(text.trim())}`) : null); };
  const open = async (eid: string) => { setSel(await api(`/api/knowledge/entities/${eid}`)); };
  const parseScen = (t: string) => lines(t).map((l) => { const [option, name, p, pay] = l.split('|').map((x) => x.trim()); return { option: option ?? '', name: name ?? '', probability: Number(p), payoff: Number(pay) }; });
  const download = async () => { const f = await api('/api/knowledge/export'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(f, null, 2)], { type: 'application/json' })); a.download = `jarvis-knowledge-${new Date().toISOString().slice(0, 10)}.json`; a.click(); };
  const detail = (n: any) => (
    <div className="glass pad section"><div className="row wrap" style={{ alignItems: 'center' }}><h3 className="grow" style={{ margin: 0 }}>{n.entity.name} <span className="muted small">({n.entity.kind}{n.entity.origin === 'derived' ? ' · pieced together from your records' : ''})</span></h3><button onClick={() => setSel(null)}>Close</button></div>
      {edit && edit.id === n.entity.id ? <div className="row wrap"><input className="grow" value={edit.notes} maxLength={1000} onChange={(e) => setEdit({ id: edit.id, notes: e.target.value })} aria-label="Notes" /><button className="primary" onClick={() => void run(async () => { await api(`/api/knowledge/entities/${edit.id}`, 'PATCH', { notes: edit.notes }); setEdit(null); await open(edit.id); }, 'Saved.')}>Save</button></div>
        : <p className="small">{n.entity.notes || <span className="muted">No notes.</span>} <button onClick={() => setEdit({ id: n.entity.id, notes: n.entity.notes })}>Edit</button></p>}
      {n.edges.length > 0 && <EgoGraph centre={n.entity} edges={n.edges} onPick={(i) => void open(i)} />}
      <ul className="plain small">{n.edges.map((e: any) => <li key={e.edge}>{e.direction === 'out' ? '→' : '←'} {REL(e.rel)} <a href="#/knowledge" onClick={(ev) => { ev.preventDefault(); void open(e.entity.id); }}>{e.entity.name}</a>{e.note ? ` (${e.note})` : ''} <span className="muted">{e.origin === 'derived' ? `guess, ${Math.round(e.confidence * 100)}%` : 'yours'}</span> <button onClick={() => void run(async () => { await api(`/api/knowledge/edges/${e.edge}`, 'DELETE'); await open(n.entity.id); }, 'Link removed.')}>Remove</button></li>)}</ul>
      {n.records.length > 0 && <><div className="muted small">Linked records</div><ul className="plain small">{n.records.map((r: any) => <li key={r.kind + r.id}><b>{r.kind}</b>: {r.text}</li>)}</ul></>}
      <div className="row wrap"><button onClick={() => { if (confirm(`Never keep anything about "${n.entity.name}"? This removes it now and blocks it from being stored again.`)) void run(async () => { await post('/api/exclusions', { pattern: n.entity.name }); setSel(null); setRes(null); }, 'Excluded. It will not be stored again.'); }}>Never store this</button>
        <button onClick={() => { if (confirm(`Forget "${n.entity.name}" and its links? Your memories stay.`)) void run(async () => { await post(`/api/knowledge/entities/${n.entity.id}/forget`, { alsoMemories: false }); setSel(null); setRes(null); }, 'Forgotten.'); }}>Forget this</button>
        <button onClick={() => { if (confirm(`Forget "${n.entity.name}" AND the memories linked to it? This cannot be undone.`)) void run(async () => { await post(`/api/knowledge/entities/${n.entity.id}/forget`, { alsoMemories: true }); setSel(null); setRes(null); }, 'Forgotten, with its memories.'); }}>Forget it and its memories</button></div>
    </div>);
  return (
    <section className="page"><h1>Knowledge</h1>
      <p className="muted">What Jarvis knows about the people, projects and topics in your life, and the decisions you have made. Everything here comes from your own records and notes; nothing is sent anywhere to build it. You can ask in chat too: "what do you know about…".</p>
      {msg && <p className={msg.ok ? 'ok small' : 'err small'} role="status">{msg.t}</p>}
      <div className="glass pad section"><h2>What do we know about…</h2>
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void search(); }}><input className="grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A person, project, topic…" aria-label="Search" /><button className="primary" type="submit">Look up</button></form>
        {res?.excluded && <p className="small muted">You asked me never to keep anything about that.</p>}
        {res && !res.excluded && res.matches.length === 0 && res.memories.length === 0 && <p className="small muted">Nothing stored about that yet.</p>}
        {res?.matches.map((m: any) => <div key={m.entity.id} className="small"><a href="#/knowledge" onClick={(e) => { e.preventDefault(); void open(m.entity.id); }}><b>{m.entity.name}</b></a> <span className="muted">({m.entity.kind}) · {m.edges.length} connection{m.edges.length === 1 ? '' : 's'}, {m.records.length} record{m.records.length === 1 ? '' : 's'}</span></div>)}
        {res?.memories.length > 0 && <><div className="muted small">Also in your memory</div><ul className="plain small">{res.memories.map((m: any) => <li key={m.id}>{m.text}</li>)}</ul></>}
      </div>
      {sel && detail(sel)}
      <div className="glass pad section"><h2>Everything it knows <span className="muted small">({data.entities.length})</span></h2>
        <div className="row wrap"><button onClick={() => void run(async () => { const r = await post('/api/knowledge/refresh'); setSel(null); await reload(); if (!r.entities) throw new Error('Nothing to build from yet.'); }, 'Refreshed from your projects, people, goals, memories and tasks.')}>Refresh from my records</button><span className="muted small">Rebuilds the guesses; anything you wrote or edited yourself is kept.</span></div>
        {data.entities.length === 0 ? <p className="muted small">Nothing yet. Press Refresh, or add something below.</p> : <ul className="plain small">{data.entities.map((e: any) => <li key={e.id}><b>{e.kind}</b> · <a href="#/knowledge" onClick={(ev) => { ev.preventDefault(); void open(e.id); }}>{e.name}</a>{e.origin === 'derived' && <span className="muted"> · from records</span>}</li>)}</ul>}
        <div className="row wrap"><select value={ne.kind} onChange={(e) => setNe({ ...ne, kind: e.target.value })} style={{ width: 'auto' }} aria-label="Kind">{data.kinds.filter((k: string) => k !== 'decision').map((k: string) => <option key={k}>{k}</option>)}</select>
          <input value={ne.name} onChange={(e) => setNe({ ...ne, name: e.target.value })} placeholder="Name" aria-label="Name" /><input className="grow" value={ne.notes} onChange={(e) => setNe({ ...ne, notes: e.target.value })} placeholder="Notes (optional)" aria-label="Notes" />
          <button className="primary" disabled={ne.name.trim().length < 2} onClick={() => void run(async () => { await post('/api/knowledge/entities', ne); setNe({ ...ne, name: '', notes: '' }); }, 'Added.')}>Add</button></div></div>

      <div className="glass pad section"><h2>Decision log</h2>
        <p className="muted small">Write down what you are deciding, what you expect, and how sure you are. Later you look back; over time it shows how well your confidence matches what happens.</p>
        {dec.data.items.map((d: any) => (
          <div key={d.id} className="rcard" style={{ borderTop: '1px solid var(--line, #8883)', paddingTop: 8 }}>
            <div className="row wrap" style={{ alignItems: 'center' }}><b className="grow">{d.title}</b><span className="badge">{d.status === 'open' ? 'Open' : d.status === 'decided' ? (dec.data.due.includes(d.id) ? 'Time to look back' : 'Decided') : d.status === 'reviewed' ? 'Looked back' : 'Dropped'}</span></div>
            {d.context && <p className="small">{d.context}</p>}
            {d.options.length > 0 && <p className="small muted">Options: {d.options.join(' · ')}</p>}
            {d.assumptions.length > 0 && <p className="small muted">Assuming: {d.assumptions.join(' · ')}</p>}
            {d.summary.length > 0 && <ul className="plain small">{d.summary.map((s: any) => <li key={s.option}>{s.option || 'Scenarios'}: expected value <b>{s.expectedValue ?? '—'}</b> (best {s.best}, worst {s.worst}){!s.balanced && <span className="warn"> · probabilities add to {s.probabilityTotal}%, not 100</span>}</li>)}<li className="muted">This only does the arithmetic on your own numbers.</li></ul>}
            {d.chosen && <p className="small"><b>Chose:</b> {d.chosen}{d.rationale ? ` — ${d.rationale}` : ''}</p>}
            {d.expected_outcome && <p className="small muted">Expected: {d.expected_outcome}{d.expected_by ? ` by ${d.expected_by}` : ''}{d.confidence !== null ? ` · ${d.confidence}% sure` : ''}</p>}
            {d.status === 'reviewed' && <p className="small"><b>{RATING[d.outcome_rating]}:</b> {d.outcome}</p>}
            {d.challenge && <div className="small"><b>A model's opinion (not a fact):</b><ul>{[...d.challenge.blindSpots.map((x: string) => `Blind spot: ${x}`), ...d.challenge.questions.map((x: string) => `Ask yourself: ${x}`), ...d.challenge.againstChoice.map((x: string) => `Against: ${x}`)].map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>}
            <div className="row wrap">
              {d.status === 'open' && <><input value={chosen[d.id] ?? ''} onChange={(e) => setChosen({ ...chosen, [d.id]: e.target.value })} placeholder="What did you choose?" aria-label="Choice" /><button className="primary" disabled={!(chosen[d.id] ?? '').trim()} onClick={() => void run(() => post(`/api/decisions/${d.id}/decide`, { chosen: chosen[d.id] }), 'Recorded.')}>I decided</button><button onClick={() => void run(async () => { await post(`/api/decisions/${d.id}/challenge`); }, 'Added a second opinion below.')}>Challenge this</button></>}
              {d.status === 'decided' && <><input className="grow" value={outcome[d.id] ?? ''} onChange={(e) => setOutcome({ ...outcome, [d.id]: e.target.value })} placeholder="What actually happened?" aria-label="Outcome" /><select value={rating[d.id] ?? 'as_expected'} onChange={(e) => setRating({ ...rating, [d.id]: e.target.value })} style={{ width: 'auto' }} aria-label="How did it go">{Object.entries(RATING).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button className="primary" disabled={!(outcome[d.id] ?? '').trim()} onClick={() => void run(() => post(`/api/decisions/${d.id}/review`, { outcome: outcome[d.id], rating: rating[d.id] ?? 'as_expected' }), 'Looked back. Thank you.')}>Save look-back</button></>}
              {['open', 'decided'].includes(d.status) && <button onClick={() => void run(() => post(`/api/decisions/${d.id}/drop`), 'Dropped.')}>Drop</button>}
              <button onClick={() => { if (confirm('Delete this decision for good?')) void run(() => api(`/api/decisions/${d.id}`, 'DELETE'), 'Deleted.'); }}>Delete</button></div>
          </div>))}
        {dec.data.calibration.enough ? <div className="small"><b>How your confidence has matched reality</b><ul className="plain">{dec.data.calibration.buckets.filter((b: any) => b.count).map((b: any) => <li key={b.bucket}>When you were {b.bucket === 'high' ? 'very' : b.bucket === 'medium' ? 'fairly' : 'not very'} sure (about {b.avgConfidence}%): it went at least as expected {b.hitRate}% of the time ({b.count} decision{b.count === 1 ? '' : 's'}).</li>)}</ul></div> : <p className="muted small">After three decisions have been looked back on, this will show whether your confidence is well calibrated ({dec.data.calibration.reviewed} so far).</p>}
        <h3>New decision</h3>
        <input value={nd.title} onChange={(e) => setNd({ ...nd, title: e.target.value })} placeholder="What are you deciding?" aria-label="Decision title" maxLength={120} style={{ width: '100%' }} />
        <textarea value={nd.context} onChange={(e) => setNd({ ...nd, context: e.target.value })} rows={2} placeholder="Context (optional)" aria-label="Context" maxLength={2000} />
        <textarea value={nd.options} onChange={(e) => setNd({ ...nd, options: e.target.value })} rows={2} placeholder="Options, one per line" aria-label="Options" />
        <textarea value={nd.assumptions} onChange={(e) => setNd({ ...nd, assumptions: e.target.value })} rows={2} placeholder="What are you assuming? One per line" aria-label="Assumptions" />
        <textarea value={nd.scen} onChange={(e) => setNd({ ...nd, scen: e.target.value })} rows={2} placeholder="Scenarios (optional), one per line: option | what happens | chance % | payoff (a number, e.g. dollars)" aria-label="Scenarios" />
        <div className="row wrap"><input className="grow" value={nd.expectedOutcome} onChange={(e) => setNd({ ...nd, expectedOutcome: e.target.value })} placeholder="What do you expect to happen?" aria-label="Expected outcome" />
          <label className="small">Look back on <input type="date" value={nd.expectedBy} onChange={(e) => setNd({ ...nd, expectedBy: e.target.value })} style={{ width: 'auto' }} /></label>
          <label className="small">How sure (%) <input type="number" min={0} max={100} value={nd.confidence} onChange={(e) => setNd({ ...nd, confidence: e.target.value })} style={{ width: 70 }} /></label>
          <button className="primary" disabled={nd.title.trim().length < 3} onClick={() => void run(async () => { await post('/api/decisions', { title: nd.title.trim(), context: nd.context, options: lines(nd.options), assumptions: lines(nd.assumptions), scenarios: parseScen(nd.scen), expectedOutcome: nd.expectedOutcome, expectedBy: nd.expectedBy || null, confidence: nd.confidence === '' ? null : Number(nd.confidence) }); setNd({ title: '', context: '', options: '', assumptions: '', expectedOutcome: '', expectedBy: '', confidence: '', scen: '' }); }, 'Saved. Nothing else happens unless you ask.')}>Save decision</button></div>
        <p className="muted small">"Challenge this" sends only the decision text you wrote to the language model and stores its answer, clearly labelled as its opinion.</p>
      </div>

      <div className="glass pad section"><h2>Privacy and what is kept</h2>
        <h3>Never store</h3>
        <p className="muted small">Names or words listed here are refused everywhere: memory, suggestions, this knowledge graph and the decision log. Adding one also removes what is already in the graph (memories are counted, not deleted, so you choose).</p>
        {exc.data?.items.length > 0 && <ul className="plain small">{exc.data.items.map((x: any) => <li key={x.id} className="row wrap"><span className="grow">{x.pattern}</span><button onClick={() => void run(() => api(`/api/exclusions/${x.id}`, 'DELETE'), 'Removed. It can be stored again.')}>Remove</button></li>)}</ul>}
        <div className="row wrap"><input className="grow" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="A name or word to never store" aria-label="Exclusion" maxLength={80} /><button className="primary" disabled={pattern.trim().length < 3} onClick={() => void run(async () => { const r = await post('/api/exclusions', { pattern }); setPattern(''); setMsg({ ok: true, t: `Done. Removed ${r.entitiesRemoved} record(s) from the graph; ${r.memoriesMatching} memor${r.memoriesMatching === 1 ? 'y still mentions' : 'ies still mention'} it (see Memory).` }); }, '')}>Add</button></div>
        <h3>How long things are kept</h3>
        <p className="muted small">By default everything is kept. You can set a limit for old chat messages, finished research and finished missions. Memories, the knowledge graph and your decisions are never deleted this way. Changing this, or running it, needs your passphrase or passkey.</p>
        {ret.data && <>
          <div className="row wrap">{([['messagesDays', 'Chat messages'], ['researchDays', 'Research results'], ['missionsDays', 'Finished missions']] as const).map(([k, label]) => <label key={k} className="small">{label} <select value={win[k] ?? String(ret.data.retention[k] ?? '')} onChange={(e) => setWin({ ...win, [k]: e.target.value })} style={{ width: 'auto' }}><option value="">Keep forever</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">1 year</option></select></label>)}</div>
          <p className="small muted">Right now, with the saved settings, this would remove: {ret.data.preview.messages} message(s), {ret.data.preview.research} research result(s), {ret.data.preview.missions} mission(s).</p>
          <div className="row wrap"><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase (or leave blank for passkey)" aria-label="Passphrase" autoComplete="current-password" />
            <button className="primary" onClick={() => void run(async () => { await confirm1(); const g = (k: string) => { const v = win[k] ?? String(ret.data.retention[k] ?? ''); return v ? Number(v) : null; }; await api('/api/knowledge/retention', 'PUT', { messagesDays: g('messagesDays'), researchDays: g('researchDays'), missionsDays: g('missionsDays') }); setWin({}); }, 'Saved. It runs once a day.')}>Save</button>
            <button onClick={() => { if (confirm('Delete everything older than your saved limits now? This cannot be undone.')) void run(async () => { await confirm1(); const r = await post('/api/knowledge/retention/run'); setMsg({ ok: true, t: `Removed ${r.messages} message(s), ${r.research} research result(s), ${r.missions} mission(s).` }); }, ''); }}>Run now</button></div></>}
        <h3>Take it with you</h3>
        <p className="muted small">Export everything here (records, links, decisions, exclusions and your memories) as one file you can read, keep, or load into another Jarvis. Importing only adds; it never overwrites or deletes, and skips anything that looks like a secret or that you excluded.</p>
        <div className="row wrap"><button onClick={() => void run(download, 'Downloaded.')}>Download my knowledge</button>
          <label className="small">Import a file <input type="file" accept="application/json" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; void run(async () => { const body = JSON.parse(await f.text()); await confirm1(); const r = await post('/api/knowledge/import', body); setMsg({ ok: true, t: `Added ${r.entities} record(s), ${r.memories} memor${r.memories === 1 ? 'y' : 'ies'}, ${r.decisions} decision(s); skipped ${r.skipped}.` }); }, ''); e.target.value = ''; }} /></label>
          <span className="muted small">(type your passphrase above first, or use your passkey)</span></div>
      </div>
    </section>);
}
