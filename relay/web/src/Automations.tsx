import { useCallback, useEffect, useState } from 'react';
import { get, post, put, fmtTime, nameOf } from './api';
import type { Me } from './App';

type Step = any;
const FIELDS: [string, string][] = [['department', 'Department (key, e.g. sales)'], ['tag', 'Has tag'], ['handling_mode', 'Handling mode'], ['responsibility', 'Responsibility state'], ['business_hours', 'Business hours (open/closed)'], ['message_contains', 'Customer message contains'], ['assigned', 'Is assigned']];
const STEP_TYPES: [string, string][] = [['wait', 'Wait'], ['send_message', 'Send text to customer'], ['add_tag', 'Add tag'], ['create_task', 'Create task'], ['notify_staff', 'Notify staff'], ['set_responsibility', 'Set who owes the next move'], ['branch', 'If / else'], ['assign', 'Assign to…']];
const blank = (type: string): Step => ({ wait: { type, minutes: 60 }, send_message: { type, body: '', kind: 'workflow' }, add_tag: { type, tag: '' }, create_task: { type, title: '', dueInHours: 24 }, notify_staff: { type, message: '' }, set_responsibility: { type, state: 'waiting_on_customer' }, branch: { type, if: { field: 'tag', op: 'is', value: '' }, then: [], else: [] }, assign: { type, userId: '' } } as any)[type];
const newDef = () => ({ trigger: { type: 'inbound_message' }, conditions: [], steps: [{ type: 'wait', minutes: 60 }], limits: { maxSendsPerContactPerDay: 2, respectQuietHours: true, staffWaitReminderHours: 4, staffWaitEscalateHours: 24 } });

export function Automations({ me, onOpenConversation }: { me: Me; onOpenConversation: (id: string) => void }) {
  const [list, setList] = useState<any[] | null>(null); const [edit, setEdit] = useState<{ id?: string; name: string; def: any } | null>(null); const [runsFor, setRunsFor] = useState<any | null>(null); const [settings, setSettings] = useState<any>(null); const [err, setErr] = useState('');
  const mgr = me.user.role !== 'staff'; const admin = me.user.role === 'owner' || me.user.role === 'admin';
  const load = useCallback(() => { get('/api/workflows').then(setList); get('/api/automation/settings').then(setSettings); }, []); useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <h2>Automations</h2>
      {settings?.globalPause && <div className="banner bad" role="alert">GLOBAL PAUSE IS ON — no automation, auto-response or broadcast is sending. {admin && <button onClick={async () => { await post('/api/automation/global-pause', { paused: false }); load(); }}>Resume everything</button>}</div>}
      <p className="muted small">Automations are made of bounded steps — no code. They stop automatically when the customer replies, an employee takes over, the thread closes, or the customer opts out. Every run keeps a plain-language log. Nothing runs until you activate it. {admin && !settings?.globalPause && <button onClick={async () => { if (confirm('Pause ALL automation, auto-responses and broadcasts?')) { await post('/api/automation/global-pause', { paused: true }); load(); } }}>Global pause</button>}</p>
      {err && <p className="error" role="alert">{err}</p>}
      {mgr && !edit && <button className="primary" onClick={() => setEdit({ name: '', def: newDef() })}>+ New automation</button>}
      {edit && <Editor me={me} initial={edit} onClose={() => { setEdit(null); load(); }} />}
      {list === null ? <p className="muted">Loading…</p> : list.length === 0 && !edit ? <p className="muted">No automations yet.</p> : list.map((w) => (
        <div key={w.id} className="card section">
          <div className="rowtop"><b>{w.name}</b><span className={`chip ${w.status === 'active' ? 'good' : w.status === 'paused' ? 'warn' : ''}`}>{w.status}</span></div>
          <div className="small muted">Trigger: {w.definition.trigger.type.replaceAll('_', ' ')} · version {w.current_version} · {w.active_runs} active run(s), {w.total_runs} total{!settings?.triggerAdapters?.[w.definition.trigger.type]?.verified && ' · ⚠ trigger source not connected'}</div>
          <div className="btns">
            {mgr && <button onClick={() => setEdit({ id: w.id, name: w.name, def: w.definition })}>Edit (new version)</button>}
            {mgr && (w.status === 'active' ? <button onClick={async () => { await post(`/api/workflows/${w.id}/status`, { status: 'paused' }); load(); }}>Pause</button> : <button className="primary" onClick={async () => { setErr(''); try { await post(`/api/workflows/${w.id}/status`, { status: 'active' }); load(); } catch (e: any) { setErr(e.message); } }}>Activate</button>)}
            <button onClick={() => setRunsFor(runsFor?.id === w.id ? null : w)}>Runs &amp; log</button></div>
          {runsFor?.id === w.id && <Runs wid={w.id} onOpenConversation={onOpenConversation} />}
        </div>))}
    </div>
  );
}

function Runs({ wid, onOpenConversation }: { wid: string; onOpenConversation: (id: string) => void }) {
  const [runs, setRuns] = useState<any[] | null>(null); const [log, setLog] = useState<any | null>(null);
  const load = useCallback(() => get(`/api/workflows/${wid}/runs`).then(setRuns), [wid]); useEffect(() => { load(); }, [load]);
  return (
    <div>{runs === null ? <p className="muted">Loading…</p> : runs.length === 0 ? <p className="muted small">No runs yet.</p> : runs.map((r) => (
      <div key={r.id} className="trow"><div><b>{nameOf(r)}</b> <span className={`chip ${r.status === 'completed' ? 'good' : r.status === 'stopped' || r.status === 'failed' ? 'bad' : 'warn'}`}>{r.status}</span> {r.stop_reason && <span className="small muted">({r.stop_reason.replaceAll('_', ' ')})</span>}<div className="small muted">started {fmtTime(r.created_at)} · v{r.version}{r.next_run_at ? ` · next ${fmtTime(r.next_run_at)}` : ''}</div></div>
        <div className="btns"><button onClick={() => get(`/api/workflow-runs/${r.id}/log`).then(setLog)}>Why? (log)</button><button onClick={() => onOpenConversation(r.conversation_id)}>Open thread</button>{['waiting', 'running'].includes(r.status) && <button onClick={async () => { await post(`/api/workflow-runs/${r.id}/stop`); load(); setLog(null); }}>Stop run</button>}</div></div>))}
      {log && <div className="card pad"><b>{log.run.workflow}</b> · v{log.run.version} · {log.run.status}{log.run.next && <div className="small">Next: {log.run.next}{log.run.nextRunAt ? ` at ${fmtTime(log.run.nextRunAt)}` : ''}</div>}
        <ol className="loglist">{log.log.map((l: any, i: number) => <li key={i}><span className="muted small">{fmtTime(l.at)}</span> <span className={`chip ${['stopped', 'failed'].includes(l.outcome) ? 'bad' : ['held', 'paused', 'deferred', 'reminded', 'escalated'].includes(l.outcome) ? 'warn' : ''}`}>{l.step}: {l.outcome}</span> {l.detail}</li>)}</ol></div>}
    </div>
  );
}

function Editor({ me, initial, onClose }: { me: Me; initial: { id?: string; name: string; def: any }; onClose: () => void }) {
  const [name, setName] = useState(initial.name); const [def, setDef] = useState<any>(JSON.parse(JSON.stringify(initial.def))); const [err, setErr] = useState(''); const [dry, setDry] = useState<any>(null); const [convs, setConvs] = useState<any[]>([]); const [convId, setConvId] = useState(''); const [users, setUsers] = useState<any[]>([]);
  useEffect(() => { get('/api/conversations').then(setConvs); get('/api/users').then(setUsers); }, []);
  const set = (patch: any) => setDef({ ...def, ...patch }); const t = def.trigger;
  const save = async () => { setErr(''); try { if (initial.id) await put(`/api/workflows/${initial.id}`, { definition: def }); else await post('/api/workflows', { name, definition: def }); onClose(); } catch (e: any) { setErr(e.message + (e.body?.issues ? ': ' + e.body.issues.join('; ') : '')); } };
  return (
    <div className="card section"><h3>{initial.id ? `Edit “${initial.name}” (saves a new version)` : 'New automation'}</h3>
      {!initial.id && <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>}
      <fieldset><legend>When this happens (trigger)</legend>
        <select aria-label="Trigger" value={t.type} onChange={(e) => set({ trigger: e.target.value === 'no_response' ? { type: 'no_response', afterHours: 24 } : e.target.value === 'inventory_update' ? { type: 'inventory_update', change: 'price_drop' } : ['appointment_event', 'service_event', 'storage_event', 'invoice_state'].includes(e.target.value) ? { type: e.target.value, event: 'created' } : { type: e.target.value } })}>
          <option value="inbound_message">Customer sends a text</option><option value="no_response">We sent a text and the customer hasn’t replied (follow-up)</option><option value="inventory_update">Inventory change (for customers who marked interest)</option>
          <option value="appointment_event">Appointment event — not connected</option><option value="service_event">Service event — not connected</option><option value="storage_event">Storage event — not connected</option><option value="invoice_state">Invoice state — not connected</option></select>
        {t.type === 'no_response' && <div className="formgrid"><label>…and no reply after (hours)<input type="number" min="1" value={t.afterHours} onChange={(e) => set({ trigger: { ...t, afterHours: Number(e.target.value) } })} /></label><label className="inline"><input type="checkbox" checked={!!t.requireQuestion} onChange={(e) => set({ trigger: { ...t, requireQuestion: e.target.checked } })} /> only if our message asked a question</label><label className="inline"><input type="checkbox" checked={!!t.businessHoursOnly} onChange={(e) => set({ trigger: { ...t, businessHoursOnly: e.target.checked } })} /> only start during business hours</label></div>}
        {t.type === 'inventory_update' && <label>Change<select value={t.change} onChange={(e) => set({ trigger: { ...t, change: e.target.value } })}><option value="price_drop">Price drops</option><option value="back_available">Boat becomes available again</option><option value="any">Any change</option></select></label>}
        {['appointment_event', 'service_event', 'storage_event', 'invoice_state'].includes(t.type) && <p className="banner warn small">This trigger needs a verified integration that isn’t connected yet. You can design and preview it, but it can’t be activated.</p>}
        {t.type === 'no_response' && <p className="small muted">Follow-up rule: customer follow-ups only go out while the customer owes us a reply. If Sun Sport Marine owes information, the follow-up is held and the assigned employee is reminded, then managers are escalated.</p>}</fieldset>
      <fieldset><legend>Only if (conditions — all must match)</legend>
        {def.conditions.map((c: any, i: number) => <div key={i} className="formgrid"><select value={c.field} onChange={(e) => { const cs = [...def.conditions]; cs[i] = { ...c, field: e.target.value }; set({ conditions: cs }); }}>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select value={c.op} onChange={(e) => { const cs = [...def.conditions]; cs[i] = { ...c, op: e.target.value }; set({ conditions: cs }); }}><option value="is">is</option><option value="is_not">is not</option><option value="contains">contains</option><option value="is_set">is set</option><option value="is_empty">is empty</option></select>
          <input value={c.value ?? ''} onChange={(e) => { const cs = [...def.conditions]; cs[i] = { ...c, value: e.target.value }; set({ conditions: cs }); }} aria-label="Condition value" /><button onClick={() => set({ conditions: def.conditions.filter((_: any, j: number) => j !== i) })}>Remove</button></div>)}
        <button onClick={() => set({ conditions: [...def.conditions, { field: 'department', op: 'is', value: '' }] })}>+ Add condition</button></fieldset>
      <fieldset><legend>Then do (steps, in order)</legend><Steps steps={def.steps} onChange={(steps) => set({ steps })} users={users} /></fieldset>
      <fieldset><legend>Safety limits</legend><div className="formgrid">
        <label>Max automated texts per customer per day<input type="number" min="1" max="10" value={def.limits.maxSendsPerContactPerDay} onChange={(e) => set({ limits: { ...def.limits, maxSendsPerContactPerDay: Number(e.target.value) } })} /></label>
        <label className="inline"><input type="checkbox" checked={def.limits.respectQuietHours} onChange={(e) => set({ limits: { ...def.limits, respectQuietHours: e.target.checked } })} /> Don’t text during quiet hours (Settings)</label>
        <label>Remind assigned staff after (hours of waiting on staff)<input type="number" min="0.1" step="0.5" value={def.limits.staffWaitReminderHours} onChange={(e) => set({ limits: { ...def.limits, staffWaitReminderHours: Number(e.target.value) } })} /></label>
        <label>Escalate to managers after (hours)<input type="number" min="1" value={def.limits.staffWaitEscalateHours} onChange={(e) => set({ limits: { ...def.limits, staffWaitEscalateHours: Number(e.target.value) } })} /></label></div></fieldset>
      <fieldset><legend>Preview (dry-run — nothing is sent or changed)</legend>
        <label>Try it against a conversation (optional)<select value={convId} onChange={(e) => setConvId(e.target.value)}><option value="">No conversation (just describe the steps)</option>{convs.map((c) => <option key={c.id} value={c.id}>{nameOf(c)} — {c.responsibility.replaceAll('_', ' ')}</option>)}</select></label>
        <button onClick={async () => { setErr(''); try { setDry(await post('/api/workflows/dry-run', { definition: def, conversationId: convId || undefined })); } catch (e: any) { setErr(e.message + (e.body?.issues ? ': ' + e.body.issues.join('; ') : '')); } }}>Run preview</button>
        {dry && <div>{dry.notes.map((n: string, i: number) => <p key={i} className="small muted">{n}</p>)}<ol className="loglist">{dry.plan.map((p: any, i: number) => <li key={i} className={p.blocked ? 'blocked' : ''}><span className="muted small">{fmtTime(p.at)}</span> <b>{p.step}</b> — {p.result}</li>)}</ol></div>}</fieldset>
      {err && <p className="error" role="alert">{err}</p>}
      <div className="btns"><button className="primary" onClick={save} disabled={!initial.id && !name.trim()}>{initial.id ? 'Save new version' : 'Save as draft'}</button><button onClick={onClose}>Cancel</button></div>
      <p className="small muted">Saved automations start as drafts. Activate from the list; {me.user.role} can manage.</p>
    </div>
  );
}

function Steps({ steps, onChange, users }: { steps: Step[]; onChange: (s: Step[]) => void; users: any[] }) {
  const upd = (i: number, patch: any) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => { const n = [...steps]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); };
  return (
    <div>{steps.map((s, i) => (
      <div key={i} className="step card"><div className="rowtop"><b>{i + 1}. {STEP_TYPES.find(([k]) => k === s.type)?.[1]}</b><span className="btns"><button onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button><button onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down">↓</button><button onClick={() => onChange(steps.filter((_, j) => j !== i))}>Remove</button></span></div>
        {s.type === 'wait' && <div className="formgrid"><label>Wait (minutes)<input type="number" min="1" value={s.minutes} onChange={(e) => upd(i, { minutes: Number(e.target.value) })} /></label><label className="inline"><input type="checkbox" checked={!!s.businessHoursOnly} onChange={(e) => upd(i, { businessHoursOnly: e.target.checked })} /> resume only in business hours</label></div>}
        {s.type === 'send_message' && <><label>Message (variables like {'{{first_name}}'} allowed; unfilled ones stop the run)<textarea rows={2} value={s.body ?? ''} onChange={(e) => upd(i, { body: e.target.value })} /></label>
          <div className="formgrid"><label className="inline"><input type="checkbox" checked={s.kind === 'follow_up'} onChange={(e) => upd(i, { kind: e.target.checked ? 'follow_up' : 'workflow' })} /> This is a customer follow-up (held while we owe them a reply)</label><label className="inline"><input type="checkbox" checked={!!s.requireQuestion} onChange={(e) => upd(i, { requireQuestion: e.target.checked })} /> only if our last message asked a question</label><label className="inline"><input type="checkbox" checked={!!s.expectsReply} onChange={(e) => upd(i, { expectsReply: e.target.checked })} /> expect a reply (we then wait on the customer)</label></div></>}
        {s.type === 'add_tag' && <label>Tag<input value={s.tag} onChange={(e) => upd(i, { tag: e.target.value })} /></label>}
        {s.type === 'assign' && <label>Assign to<select value={s.userId} onChange={(e) => upd(i, { userId: e.target.value })}><option value="">Choose…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>}
        {s.type === 'create_task' && <div className="formgrid"><label>Task title<input value={s.title} onChange={(e) => upd(i, { title: e.target.value })} /></label><label>Due in (hours)<input type="number" value={s.dueInHours ?? ''} onChange={(e) => upd(i, { dueInHours: e.target.value ? Number(e.target.value) : undefined })} /></label><label>Assign to (blank = conversation owner)<select value={s.assigneeId ?? ''} onChange={(e) => upd(i, { assigneeId: e.target.value || undefined })}><option value="">Conversation assignee</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label></div>}
        {s.type === 'notify_staff' && <label>Notification text<input value={s.message} onChange={(e) => upd(i, { message: e.target.value })} /></label>}
        {s.type === 'set_responsibility' && <label>Mark as<select value={s.state} onChange={(e) => upd(i, { state: e.target.value })}><option value="waiting_on_customer">Waiting on customer</option><option value="waiting_on_staff">Waiting on staff</option><option value="needs_our_reply">Needs our reply</option></select></label>}
        {s.type === 'branch' && <><div className="formgrid"><select value={s.if.field} onChange={(e) => upd(i, { if: { ...s.if, field: e.target.value } })}>{FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><select value={s.if.op} onChange={(e) => upd(i, { if: { ...s.if, op: e.target.value } })}><option value="is">is</option><option value="is_not">is not</option><option value="contains">contains</option><option value="is_set">is set</option><option value="is_empty">is empty</option></select><input value={s.if.value ?? ''} onChange={(e) => upd(i, { if: { ...s.if, value: e.target.value } })} aria-label="Branch value" /></div>
          <div className="branch"><b className="small">If true:</b><Steps steps={s.then} onChange={(x) => upd(i, { then: x })} users={users} /><b className="small">Otherwise:</b><Steps steps={s.else} onChange={(x) => upd(i, { else: x })} users={users} /></div></>}
      </div>))}
      <select aria-label="Add step" value="" onChange={(e) => e.target.value && onChange([...steps, blank(e.target.value)])}><option value="">+ Add step…</option>{STEP_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
  );
}
