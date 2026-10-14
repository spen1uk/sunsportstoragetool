import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fmtTime, get, nameOf, post, subscribe, uuid } from './api';
import type { Me } from './App';
import { ContactCard } from './Customers';
import { Attachment } from './Media';
import { upload } from './api';
import { SummaryBox } from './Summary';
import { VoicePanel } from './Voice';
import { fmtTime as fmt2 } from './api';

const RESP: Record<string, string> = { needs_our_reply: 'Needs our reply', waiting_on_customer: 'Waiting on customer', waiting_on_staff: 'Waiting on staff', scheduled: 'Scheduled', closed: 'Closed' };
const MODE: Record<string, string> = { human: 'Human handling', sandra: 'Sandra handling', draft_only: 'Draft assistance only', paused: 'Automation paused' };
// Delivery states are shown exactly as the system knows them — "provider accepted" is NOT "delivered".
const STATUS: Record<string, string> = { received: '', queued: 'Queued', sending: 'Sending…', provider_accepted: 'Accepted by provider', delivered: 'Delivered', failed: 'Failed', unknown: 'Outcome unknown — verify before resending', suppressed: 'Not sent' };
const REASON: Record<string, string> = { package_price_changed: 'a price changed since this package was drafted — rebuild it from Inventory Matches', package_boat_sold: 'a boat in this package is no longer available — rebuild it', package_inventory_stale: 'inventory data is stale and availability is unverified', package_already_sent: 'this package was already sent', package_boat_unavailable: 'a boat in this package is pending or on hold', unresolved_template_variables: 'the message still has unfilled {{variables}}', empty_message: 'the message is empty', attachment_too_large_for_mms: 'attachments are too large for texting', attachment_type_not_allowed: 'that attachment type cannot be texted', attachment_not_found: 'attachment not found', attachment_unavailable: 'attachment unavailable', customer_replied_since_scheduling: 'customer replied after it was scheduled', global_pause: 'automation is globally paused', sms_opted_out: 'customer opted out', do_not_text: 'do-not-text is set', outbound_blocked: 'outbound is blocked', no_marketing_consent: 'no marketing consent', employee_takeover: 'employee took over', stale_revision: 'conversation changed', conversation_closed: 'conversation closed', handling_mode_changed: 'handling mode changed' };

type Compose = { conversationId: string; body: string; mediaIds: string[]; packageId: string };
export function Inbox({ me, focus, compose, onComposeUsed, onOpenTeam }: { me: Me; focus?: string | null; compose?: Compose | null; onComposeUsed?: () => void; onOpenTeam?: (channelId: string) => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [filters, setFilters] = useState({ status: 'open', responsibility: '', assignee: '', search: '', unread: false });
  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [panel, setPanel] = useState<'list' | 'thread' | 'info'>(focus ? 'thread' : 'list');
  const [typing, setTyping] = useState<Record<string, { name: string; at: number }>>({});
  const selRef = useRef(sel); selRef.current = sel;
  const [tick, setTick] = useState(0);

  const loadList = useCallback(() => {
    const q = new URLSearchParams(); if (filters.status) q.set('status', filters.status); if (filters.responsibility) q.set('responsibility', filters.responsibility);
    if (filters.assignee) q.set('assignee', filters.assignee); if (filters.search) q.set('search', filters.search); if (filters.unread) q.set('unread', '1');
    get('/api/conversations?' + q).then(setList).catch(() => setList([]));
  }, [filters]);
  useEffect(() => { const t = setTimeout(loadList, 150); return () => clearTimeout(t); }, [loadList]);
  useEffect(() => subscribe((e) => {
    if (e.type === 'typing' && e.userId !== me.user.id) setTyping((t) => ({ ...t, [e.conversationId]: { name: e.name, at: Date.now() } }));
    else if (e.type === 'notification' || e.type === 'chat.message' || e.type === 'inventory.updated') { /* handled elsewhere */ }
    else { loadList(); if (e.type === 'resync' || e.conversationId === selRef.current) setTick((n) => n + 1); }
  }), [loadList, me.user.id]);

  const open = (id: string) => { setSel(id); setPanel('thread'); };
  return (
    <div className={`inbox panel-${panel}`}>
      <section className="pane list">
        <div className="pane-head">
          <input placeholder="Search conversations…" aria-label="Search conversations" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          <div className="filters">
            <select aria-label="Status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="open">Open</option><option value="closed">Closed</option><option value="">All</option></select>
            <select aria-label="Responsibility" value={filters.responsibility} onChange={(e) => setFilters({ ...filters, responsibility: e.target.value })}><option value="">Any state</option>{Object.entries(RESP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <select aria-label="Assignee" value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}><option value="">Anyone</option><option value="me">Mine</option><option value="unassigned">Unassigned</option></select>
            <label className="inline"><input type="checkbox" checked={filters.unread} onChange={(e) => setFilters({ ...filters, unread: e.target.checked })} /> Unread</label>
          </div>
        </div>
        {list === null ? <p className="muted pad">Loading…</p> : list.length === 0 ? <div className="pad muted"><p>No conversations match.</p><p className="small">Customer texts appear here automatically. {me.simulated && 'In demo mode, open any conversation… or use “Simulate customer text” below.'}</p></div> :
          <ul className="rows">{list.map((c) => (
            <li key={c.id}><button className={`row ${sel === c.id ? 'sel' : ''} ${c.unread ? 'unread' : ''}`} onClick={() => open(c.id)}>
              <span className="rowtop"><strong>{nameOf(c)}</strong><span className="muted small">{fmtTime(c.last_message_at)}</span></span>
              <span className="preview">{c.last_preview ?? <i>No messages yet</i>}</span>
              <span className="chips">
                {c.unread > 0 && <span className="chip count">{c.unread}</span>}
                <span className={`chip ${c.responsibility === 'needs_our_reply' ? 'warn' : ''}`}>{RESP[c.responsibility]}</span>
                {c.department_name && <span className="chip">{c.department_name}</span>}
                <span className="chip">{c.assignee_name ?? 'Unassigned'}</span>
                {c.handling_mode !== 'human' && <span className="chip info">{MODE[c.handling_mode]}</span>}
                <span className="chip">SMS{c.is_simulated ? ' (demo)' : ''}</span>
              </span>
            </button></li>))}</ul>}
        {me.simulated && <Simulate onDone={loadList} />}
      </section>
      <section className="pane thread">
        {sel ? <Thread key={sel} id={sel} tz={me.workspace.timezone} compose={compose?.conversationId === sel ? compose : null} onComposeUsed={onComposeUsed} tick={tick} typing={typing[sel]} onBack={() => setPanel('list')} onInfo={() => setPanel('info')} onChanged={loadList} /> : <p className="muted pad">Select a conversation.</p>}
      </section>
      <section className="pane side">
        {sel && <SideInfo key={sel + tick} id={sel} me={me} onOpenTeam={onOpenTeam} onBack={() => setPanel('thread')} onChanged={() => { loadList(); setTick((n) => n + 1); }} />}
      </section>
    </div>
  );
}

function Simulate({ onDone }: { onDone: () => void }) {
  const [from, setFrom] = useState('(414) 201-0199'); const [body, setBody] = useState('Hi, is the 2019 pontoon still available?'); const [msg, setMsg] = useState('');
  return (
    <details className="sim"><summary>Simulate customer text (DEMO)</summary>
      <input value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Simulated sender number" />
      <input value={body} onChange={(e) => setBody(e.target.value)} aria-label="Simulated message" />
      <button onClick={async () => { try { await post('/api/dev/simulate-inbound', { from, body }); setMsg('Sent through the signed webhook path.'); onDone(); } catch (e: any) { setMsg(e.message); } }}>Simulate</button>
      {msg && <p className="small muted">{msg}</p>}
    </details>
  );
}

function Thread({ id, tz, compose, onComposeUsed, tick, typing, onBack, onInfo, onChanged }: { id: string; tz: string; compose: Compose | null; onComposeUsed?: () => void; tick: number; typing?: { name: string; at: number }; onBack: () => void; onInfo: () => void; onChanged: () => void }) {
  const [data, setData] = useState<any>(null); const [draft, setDraft] = useState(''); const [err, setErr] = useState(''); const [loadErr, setLoadErr] = useState(''); const [warn, setWarn] = useState<string | null>(null);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]); const [showTpl, setShowTpl] = useState(false); const [showSched, setShowSched] = useState(false); const [tpls, setTpls] = useState<any[]>([]); const [tplSearch, setTplSearch] = useState('');
  const [sched, setSched] = useState<any[]>([]); const [when, setWhen] = useState(''); const [tplMissing, setTplMissing] = useState<string[]>([]);
  const [packageId, setPackageId] = useState<string | null>(null); const [showVoice, setShowVoice] = useState(false); const [aDrafts, setADrafts] = useState<any[]>([]);
  const keyRef = useRef(uuid());
  useEffect(() => { if (compose) { setDraft(compose.body); setPackageId(compose.packageId || null); setFiles([]); onComposeUsed?.(); } }, [compose]);
  const endRef = useRef<HTMLDivElement>(null); const typingTimer = useRef<number>(0);
  const load = useCallback(() => get(`/api/conversations/${id}`).then((d) => { setData(d); post(`/api/conversations/${id}/read`).catch(() => {}); }).catch((e) => setLoadErr(e.message)), [id]);
  const loadDrafts = useCallback(() => get(`/api/conversations/${id}/assistant-drafts`).then(setADrafts).catch(() => setADrafts([])), [id]);
  const loadSched = useCallback(() => get(`/api/conversations/${id}/scheduled`).then(setSched).catch(() => {}), [id]);
  useEffect(() => { load(); loadSched(); loadDrafts(); }, [load, loadSched, loadDrafts, tick]);
  useEffect(() => { if (showTpl) get('/api/templates?search=' + encodeURIComponent(tplSearch)).then(setTpls); }, [showTpl, tplSearch]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [data?.messages?.length]);
  const [, force] = useState(0); useEffect(() => { const t = setInterval(() => force((n) => n + 1), 2000); return () => clearInterval(t); }, []);
  if (loadErr) return <p className="error pad">{loadErr}</p>; if (!data) return <p className="muted pad">Loading…</p>;
  const c = data.conversation; const lastSeq = data.messages.length ? data.messages[data.messages.length - 1].seq : 0;
  const send = async (force = false) => {
    setErr(''); setWarn(null);
    try { await post(`/api/conversations/${id}/messages`, { body: draft, idempotencyKey: keyRef.current, ifLastSeq: lastSeq, force, mediaIds: [...files.map((f) => f.id), ...(packageId && compose?.mediaIds ? compose.mediaIds : [])], packageId: packageId || undefined }); setDraft(''); setFiles([]); setTplMissing([]); setPackageId(null); keyRef.current = uuid(); load(); onChanged(); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) setWarn('New activity arrived in this conversation while you were typing. Review it, then send anyway if still appropriate.');
      else if (e instanceof ApiError && e.status === 422) { setErr(`Not sent: ${REASON[e.body?.error] ?? e.body?.error}.`); keyRef.current = uuid(); load(); }
      else setErr((e as Error).message);
    }
  };
  const showTyping = typing && Date.now() - typing.at < 4000;
  return (
    <div className="threadwrap">
      <div className="thread-head">
        <button className="linkbtn show-m" onClick={onBack} aria-label="Back to list">←</button>
        <div><strong>{c.contact_name || 'Conversation'}</strong> <span className="muted small">{RESP[c.responsibility]} · {MODE[c.handling_mode]}</span></div>
        <button className="linkbtn show-m right" onClick={onInfo}>Customer ⓘ</button>
      </div>
      {c.is_simulated && <div className="banner">DEMO conversation — messages here never leave Relay.</div>}
      <div className="msgs" role="log" aria-live="polite">
        {data.messages.length === 0 && <p className="muted pad">No messages yet. Write the first one below.</p>}
        {data.messages.map((m: any) => (
          <div key={m.id} className={`bubble ${m.direction}`}>
            <div className="meta">{m.direction === 'inbound' ? 'Customer' : m.sender_type === 'staff' ? (m.sender_name ?? 'Staff') : m.sender_type === 'sandra' ? 'Sandra' : m.sender_type === 'automation' ? 'Automation' : 'System'}{m.purpose !== 'conversational' ? ` · ${m.purpose}` : ''} · {fmtTime(m.created_at)}{m.imported_batch_id ? ' · imported history' : ''}</div>
            <div className="text">{m.body}</div>
            {m.attachments?.map((a: any) => <Attachment key={a.id} id={a.id} filename={a.filename} type={a.content_type} />)}
            {m.direction === 'outbound' && <div className={`status s-${m.status}`}>{STATUS[m.status]}{m.status_detail ? ` — ${REASON[m.status_detail] ?? m.status_detail}` : ''}</div>}
          </div>))}
        <div ref={endRef} />
      </div>
      {showTyping && <div className="typing small muted">{typing!.name} is typing…</div>}
      {warn && <div className="banner warn" role="alert">{warn} <button onClick={() => { load(); setWarn(null); }}>Review</button> <button onClick={() => send(true)}>Send anyway</button></div>}
      {err && <div className="banner bad" role="alert">{err}</div>}
      {c.status === 'closed' && <div className="banner">This conversation is closed. Sending a message reopens it.</div>}
      {sched.filter((x) => x.status === 'pending' || x.status === 'needs_review').map((x) => (
        <div key={x.id} className={`banner ${x.status === 'needs_review' ? 'warn' : ''}`}>Scheduled for {new Date(x.run_at).toLocaleString([], { timeZone: x.timezone, dateStyle: 'medium', timeStyle: 'short' })} ({x.timezone}) by {x.created_by_name}{x.status === 'needs_review' ? ' — NOT sent: customer replied since; review' : ''}: “{x.body.slice(0, 60)}” {x.status === 'pending' && <button onClick={async () => { try { await post(`/api/scheduled/${x.id}/cancel`); loadSched(); load(); } catch (e: any) { setErr(e.message); } }}>Cancel</button>}</div>))}
      {tplMissing.length > 0 && <div className="banner warn" role="alert">This template needs details we don't have: {tplMissing.join(', ')}. Fill them in (Settings / customer record) or edit the text. It cannot be sent with {'{{…}}'} left in.</div>}
      {aDrafts.map((d) => <div key={d.id} className={`banner ${d.reason ? 'warn' : ''}`} role="note"><strong>{d.assistant_name ?? 'Assistant'} suggests{d.reason ? ` (held for a person: ${String(d.reason).replace('authority:', '').replaceAll('_', ' ')})` : ''}:</strong> “{d.body}”
        {d.current_revision !== d.base_revision && <div className="small muted">The conversation has changed since this was written — check it still fits.</div>}
        <div><button className="primary" onClick={async () => { try { const r = await post(`/api/assistant-drafts/${d.id}/use`); setDraft(r.body); loadDrafts(); } catch (e: any) { setErr(e.message); } }}>Use as my draft</button> <button onClick={async () => { await post(`/api/assistant-drafts/${d.id}/dismiss`).catch(() => {}); loadDrafts(); }}>Dismiss</button></div></div>)}
      {packageId && <div className="banner">Boat package draft — review and edit, then Send. Price and availability are re-verified when you send; the send is refused if anything changed.</div>}
      {showVoice && <VoicePanel conversationId={id} onClose={() => setShowVoice(false)} onSent={() => { setShowVoice(false); load(); onChanged(); }} />}
      {showTpl && <div className="popover"><input placeholder="Search templates…" aria-label="Search templates" value={tplSearch} onChange={(e) => setTplSearch(e.target.value)} />
        {tpls.length === 0 ? <p className="muted small">No templates.</p> : tpls.map((t) => <div key={t.id} className="trow"><button className="linkbtn" onClick={async () => { await post(`/api/templates/${t.id}/favorite`, { favorite: !t.favorite }); setTplSearch((x) => x + ''); get('/api/templates?search=' + encodeURIComponent(tplSearch)).then(setTpls); }} aria-label="Toggle favorite">{t.favorite ? '★' : '☆'}</button>
          <button className="row" onClick={async () => { const r = await post(`/api/templates/${t.id}/render`, { conversationId: id }); setDraft(r.text); setTplMissing(r.missing); setShowTpl(false); }}><b>{t.name}</b><span className="small muted">{t.category}</span></button></div>)}</div>}
      {showSched && <div className="popover"><label>Send at ({tz})<input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <p className="small muted">Consent, handling mode and replies are re-checked when it is due. If the customer writes first, it will NOT send and you'll be asked to review.</p>
        <button className="primary" disabled={!when || (!draft.trim() && !files.length)} onClick={async () => { try { const r = await post(`/api/conversations/${id}/scheduled`, { body: draft, localTime: when, mediaIds: files.map((f) => f.id) }); setDraft(''); setFiles([]); setShowSched(false); setErr(r.dst !== 'none' ? `Note: that local time hits a daylight-saving change (${r.dst.replaceAll('_', ' ')}).` : ''); loadSched(); load(); } catch (e: any) { setErr(e.message); } }}>Schedule</button></div>}
      {files.length > 0 && <div className="chips pad">{files.map((f) => <span key={f.id} className="chip">📎 {f.name} <button className="linkbtn" onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`}>×</button></span>)}</div>}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); if (draft.trim() || files.length) send(); }}>
        <div className="tools"><button type="button" onClick={() => { setShowTpl(!showTpl); setShowSched(false); }} aria-label="Templates">Templates</button>
          <label className="filebtn" title="Attach image/PDF (texting limit 5 MB)">📎<input type="file" hidden accept="image/*,application/pdf,video/mp4" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { const r = await upload(f, { category: 'message' }); setFiles([...files, { id: r.id, name: f.name }]); } catch (x: any) { setErr(x.message); } e.target.value = ''; }} /></label>
          <button type="button" onClick={() => { setShowSched(!showSched); setShowTpl(false); setShowVoice(false); }} aria-label="Schedule">⏰</button>
          <button type="button" onClick={() => { setShowVoice(!showVoice); setShowTpl(false); setShowSched(false); }} aria-label="Voice message">🎤</button></div>
        <textarea rows={2} placeholder="Write a message…" aria-label="Message" value={draft} maxLength={1600}
          onChange={(e) => { setDraft(e.target.value); window.clearTimeout(typingTimer.current); post(`/api/conversations/${id}/typing`, { typing: true }).catch(() => {}); typingTimer.current = window.setTimeout(() => {}, 3000); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (draft.trim() || files.length) send(); } }} />
        <button className="primary" type="submit" disabled={!draft.trim() && !files.length}>Send</button>
      </form>
      <p className="hint small muted">Ctrl/⌘+Enter to send. “Accepted by provider” means the provider took the message; it is not proof of delivery.</p>
    </div>
  );
}

function SideInfo({ id, me, onBack, onChanged, onOpenTeam }: { id: string; me: Me; onBack: () => void; onChanged: () => void; onOpenTeam?: (id: string) => void }) {
  const [d, setD] = useState<any>(null); const [users, setUsers] = useState<any[]>([]); const [deps, setDeps] = useState<any[]>([]); const [note, setNote] = useState(''); const [err, setErr] = useState('');
  useEffect(() => { get(`/api/conversations/${id}`).then(setD).catch((e) => setErr(e.message)); get('/api/users').then(setUsers); get('/api/departments').then(setDeps); }, [id]);
  if (err) return <p className="error pad">{err}</p>; if (!d) return null;
  const c = d.conversation; const act = async (p: string, body: object = {}) => { try { setErr(''); await post(`/api/conversations/${id}/${p}`, body); onChanged(); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="scroll">
      <button className="linkbtn show-m pad" onClick={onBack}>← Conversation</button>
      <div className="pad controls">
        <label>Assigned to<select value={c.assignee_user_id ?? ''} onChange={(e) => act('assign', { userId: e.target.value || null })}><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Department<select value={c.department_id ?? ''} onChange={(e) => act('department', { departmentId: e.target.value || null })}><option value="">None</option>{deps.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Who owes the next move<select value={c.responsibility === 'closed' || c.responsibility === 'scheduled' ? '' : c.responsibility} disabled={c.status === 'closed'} onChange={(e) => e.target.value && act('responsibility', { state: e.target.value })}>
          {(c.responsibility === 'closed' || c.responsibility === 'scheduled') && <option value="">{RESP[c.responsibility]}</option>}
          {['needs_our_reply', 'waiting_on_customer', 'waiting_on_staff'].map((k) => <option key={k} value={k}>{RESP[k]}</option>)}</select></label>
        <label>Handling mode<select value={c.handling_mode} onChange={(e) => act('handling-mode', { mode: e.target.value })}>{Object.entries(MODE).filter(([k]) => k !== 'sandra' || me.user.role !== 'staff').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <div className="btns"><button onClick={() => act('takeover')}>Take over</button>{c.status === 'open' ? <button onClick={() => act('status', { open: false })}>Close</button> : <button onClick={() => act('status', { open: true })}>Reopen</button>}</div>
        {err && <p className="error" role="alert">{err}</p>}
        <p className="muted small">Sandra is not connected. Handling modes are recorded and enforced by the server for when she is.</p>
      </div>
      <div className="pad"><h3>Internal notes</h3><p className="muted small">Only staff see notes. They can never be sent to the customer.</p>
        <form onSubmit={async (e) => { e.preventDefault(); if (note.trim()) { await act('notes', { body: note }); setNote(''); } }}><textarea rows={2} aria-label="New internal note" value={note} onChange={(e) => setNote(e.target.value)} /><button>Add note</button></form>
        <ul className="notes">{d.notes.map((n: any) => <li key={n.id}><span className="muted small">{n.author_name} · {fmtTime(n.created_at)}</span><br />{n.body}</li>)}</ul></div>
      <AutomationPanel conversationId={id} onChanged={onChanged} />
      <SummaryBox contactId={c.contact_id} tick={0} />
      <div className="pad"><button onClick={async () => { const r = await post('/api/chat/customer', { contactId: c.contact_id }); onOpenTeam?.(r.id); }}>Open private team discussion about this customer</button></div>
      <ContactCard id={c.contact_id} me={me} />
    </div>
  );
}

function AutomationPanel({ conversationId, onChanged }: { conversationId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const load = useCallback(() => get(`/api/conversations/${conversationId}/automation`).then(setRows).catch(() => {}), [conversationId]); useEffect(() => { load(); }, [load]);
  if (!rows.length) return null;
  return (
    <section className="pad" aria-label="Automation activity"><h3>Automation activity</h3>
      {rows.map((r) => <div key={r.id} className="small trow"><div><b>{r.workflow}</b> <span className={`chip ${r.status === 'completed' ? 'good' : r.status === 'stopped' || r.status === 'failed' ? 'bad' : 'warn'}`}>{r.status}</span>{r.stopReason && <span className="muted"> ({r.stopReason.replaceAll('_', ' ')})</span>}{r.next && <div className="muted">Next: {r.next}{r.nextRunAt ? ` — ${fmt2(r.nextRunAt)}` : ''}</div>}</div>
        {['waiting', 'running'].includes(r.status) && <button onClick={async () => { await post(`/api/workflow-runs/${r.id}/stop`); load(); onChanged(); }}>Stop</button>}</div>)}
      <p className="small muted">Replying yourself or taking over stops pending automated steps.</p></section>
  );
}
