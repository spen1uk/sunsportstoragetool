import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtTime, get, post, subscribe } from './api';
import type { Me } from './App';
import { Attachment } from './Media';

export function TeamChat({ me, onOpenConversation, initialChannel }: { me: Me; onOpenConversation: (id: string) => void; initialChannel?: string | null }) {
  const [view, setView] = useState<'chat' | 'tasks'>('chat');
  return (
    <div className="chatshell">
      <div className="tabs"><button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>Chat</button><button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>Tasks</button>
        <span className="badge right">Internal only — never sent to customers</span></div>
      {view === 'chat' ? <Chat me={me} initial={initialChannel ?? null} /> : <Tasks me={me} onOpenConversation={onOpenConversation} />}
    </div>
  );
}

function Chat({ me, initial }: { me: Me; initial: string | null }) {
  const [chs, setChs] = useState<any[]>([]); const [sel, setSel] = useState<string | null>(initial); const [msgs, setMsgs] = useState<any[]>([]); const [thread, setThread] = useState<any | null>(null); const [threadMsgs, setThreadMsgs] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]); const [draft, setDraft] = useState(''); const [mentions, setMentions] = useState<{ id: string; name: string }[]>([]); const [err, setErr] = useState(''); const [taskFor, setTaskFor] = useState<any | null>(null); const [q, setQ] = useState(''); const [hits, setHits] = useState<any[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const loadCh = useCallback(() => get('/api/chat/channels').then(setChs), []);
  const loadMsgs = useCallback(() => { if (!sel) return; get(`/api/chat/channels/${sel}/messages`).then((m) => { setMsgs(m); post(`/api/chat/channels/${sel}/read`).then(loadCh).catch(() => {}); }).catch((e) => setErr(e.message)); if (thread) get(`/api/chat/channels/${sel}/messages?thread=${thread.id}`).then(setThreadMsgs).catch(() => {}); }, [sel, thread, loadCh]);
  useEffect(() => { loadCh(); get('/api/users').then(setUsers); }, [loadCh]);
  useEffect(() => { loadMsgs(); }, [loadMsgs]);
  useEffect(() => subscribe((e) => { if (e.type === 'chat.message' || e.type === 'resync') { loadCh(); if (e.type === 'resync' || e.channelId === sel) loadMsgs(); } }), [sel, loadCh, loadMsgs]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [msgs.length]);
  useEffect(() => { if (q.trim().length < 2) { setHits([]); return; } const t = setTimeout(() => get('/api/chat/search?q=' + encodeURIComponent(q)).then(setHits), 250); return () => clearTimeout(t); }, [q]);
  const post1 = async (body: string, parentId?: string) => { setErr(''); try { await post(`/api/chat/channels/${sel}/messages`, { body, parentId: parentId ?? null, mentions: mentions.map((m) => m.id) }); setDraft(''); setMentions([]); loadMsgs(); } catch (e: any) { setErr(e.message); } };
  const cur = chs.find((c) => c.id === sel);
  const groups: [string, any[]][] = [['Departments', chs.filter((c) => c.kind === 'department')], ['Direct messages', chs.filter((c) => c.kind === 'dm')], ['Groups', chs.filter((c) => c.kind === 'group')], ['Customer discussions', chs.filter((c) => c.kind === 'customer')]];
  return (
    <div className={`chatgrid ${sel ? 'has-sel' : ''} ${thread || taskFor ? 'has-side' : ''}`}>
      <section className="pane list">
        <div className="pane-head"><input placeholder="Search team chat…" aria-label="Search team chat" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="filters"><select aria-label="Start a direct message" value="" onChange={async (e) => { if (e.target.value) { const r = await post('/api/chat/dm', { userId: e.target.value }); await loadCh(); setSel(r.id); } }}><option value="">+ Direct message…</option>{users.filter((u) => u.id !== me.user.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <button onClick={async () => { const name = prompt('Group name?'); if (!name) return; const ids = prompt('Member names, comma separated (from: ' + users.map((u) => u.name).join(', ') + ')'); const memberIds = users.filter((u) => ids?.split(',').map((x) => x.trim().toLowerCase()).includes(u.name.toLowerCase())).map((u) => u.id); if (!memberIds.length) return setErr('No matching members'); const r = await post('/api/chat/groups', { name, memberIds }); await loadCh(); setSel(r.id); }}>+ Group</button></div></div>
        {hits.length > 0 && <ul className="rows">{hits.map((h) => <li key={h.id}><button className="row" onClick={() => { setSel(h.channelId); setQ(''); }}><span className="small muted">{h.authorName} · {fmtTime(h.createdAt)}</span><span className="preview">{h.body}</span></button></li>)}</ul>}
        {hits.length === 0 && <div className="scroll">{groups.map(([title, list]) => list.length > 0 && <div key={title}><div className="grouphead small muted">{title}</div><ul className="rows">{list.map((c) => <li key={c.id}><button className={`row ${sel === c.id ? 'sel' : ''}`} onClick={() => { setSel(c.id); setThread(null); }}><span className="rowtop"><strong># {c.name}</strong>{c.unread > 0 && <span className="chip count">{c.unread}</span>}</span></button></li>)}</ul></div>)}</div>}
      </section>
      <section className="pane thread">
        {!cur ? <p className="muted pad">Pick a channel or start a conversation. Customer discussions are opened from a customer's record.</p> : <div className="threadwrap">
          <div className="thread-head"><button className="linkbtn show-m" onClick={() => setSel(null)} aria-label="Back to channels">←</button><strong># {cur.name}</strong><span className="muted small">{cur.kind === 'customer' ? 'Private discussion about this customer — visible only to staff who can see the customer' : cur.kind === 'department' ? 'Department channel' : 'Private'}</span></div>
          <div className="msgs" role="log" aria-live="polite">
            {msgs.length === 0 && <p className="muted pad">No messages yet.</p>}
            {msgs.map((m) => <ChatMsg key={m.id} m={m} me={me} onReply={() => { setThread(m); get(`/api/chat/channels/${sel}/messages?thread=${m.id}`).then(setThreadMsgs); }} onTask={() => setTaskFor(m)} onDelete={async () => { await api('DELETE', `/api/chat/messages/${m.id}`); loadMsgs(); }} />)}
            <div ref={endRef} /></div>
          {err && <div className="banner bad" role="alert">{err}</div>}
          <form className="composer" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) post1(draft); }}>
            <div className="tools"><select aria-label="Mention a teammate" value="" onChange={(e) => { const u = users.find((x) => x.id === e.target.value); if (u) { setMentions([...mentions, { id: u.id, name: u.name }]); setDraft((d) => d + `@${u.name} `); } }}><option value="">@ mention…</option>{users.filter((u) => u.id !== me.user.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            <textarea rows={2} aria-label="Team message" placeholder="Message the team (internal)…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim()) { e.preventDefault(); post1(draft); } }} />
            <button className="primary" disabled={!draft.trim()}>Post</button></form></div>}
      </section>
      <section className="pane side">
        {thread && <div className="scroll pad"><div className="rowtop"><b>Thread</b><button className="linkbtn" onClick={() => setThread(null)}>Close</button></div>
          {threadMsgs.map((m) => <ChatMsg key={m.id} m={m} me={me} compact onTask={() => setTaskFor(m)} />)}
          <ThreadReply onSend={(b) => post1(b, thread.id)} /></div>}
        {taskFor && <TaskForm users={users} msg={taskFor} onDone={() => { setTaskFor(null); loadMsgs(); }} />}
      </section>
    </div>
  );
}

function ChatMsg({ m, me, onReply, onTask, onDelete, compact }: { m: any; me: Me; onReply?: () => void; onTask: () => void; onDelete?: () => void; compact?: boolean }) {
  if (m.deleted_at) return <div className="small muted pad">(message deleted)</div>;
  return (
    <div className="chatmsg"><div className="meta small muted"><b>{m.author_name}</b> · {fmtTime(m.created_at)}{m.edited_at ? ' · edited' : ''}</div>
      <div className="text pre">{m.body}</div>
      {m.attachments?.map((a: any) => <Attachment key={a.id} id={a.id} filename={a.filename} type={a.content_type} />)}
      <div className="small actions">{!compact && onReply && <button className="linkbtn" onClick={onReply}>{m.reply_count ? `${m.reply_count} replies` : 'Reply'}</button>}
        {m.task_id ? <span className="chip good">Task created</span> : <button className="linkbtn" onClick={onTask}>Make task</button>}
        {onDelete && (m.author_id === me.user.id || me.user.role === 'owner' || me.user.role === 'admin') && <button className="linkbtn" onClick={onDelete}>Delete</button>}</div></div>
  );
}
function ThreadReply({ onSend }: { onSend: (b: string) => void }) { const [t, setT] = useState(''); return <form onSubmit={(e) => { e.preventDefault(); if (t.trim()) { onSend(t); setT(''); } }}><textarea rows={2} aria-label="Thread reply" value={t} onChange={(e) => setT(e.target.value)} /><button>Reply</button></form>; }

function TaskForm({ users, msg, onDone }: { users: any[]; msg: any; onDone: () => void }) {
  const [assignee, setAssignee] = useState(''); const [due, setDue] = useState(''); const [title, setTitle] = useState(msg.body.slice(0, 120)); const [err, setErr] = useState('');
  return (
    <form className="pad controls" onSubmit={async (e) => { e.preventDefault(); try { await post(`/api/chat/messages/${msg.id}/task`, { assigneeId: assignee, dueAt: due ? new Date(due).toISOString() : null, title }); onDone(); } catch (x: any) { setErr(x.message); } }}>
      <b>Turn into task</b><label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Assign to<select value={assignee} onChange={(e) => setAssignee(e.target.value)} required><option value="">Choose…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label>Due<input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <p className="small muted">The assignee must be able to see this channel. Tasks link back to the customer and conversation.</p>
      {err && <p className="error" role="alert">{err}</p>}<div className="btns"><button className="primary">Create task</button><button type="button" onClick={onDone}>Cancel</button></div></form>
  );
}

function Tasks({ me, onOpenConversation }: { me: Me; onOpenConversation: (id: string) => void }) {
  const [scope, setScope] = useState<'mine' | 'created' | 'all'>('mine'); const [status, setStatus] = useState('open'); const [rows, setRows] = useState<any[] | null>(null); const [title, setTitle] = useState('');
  const load = useCallback(() => get(`/api/tasks?scope=${scope}&status=${status}`).then(setRows).catch(() => setRows([])), [scope, status]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page"><div className="filters"><select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value as any)}><option value="mine">Assigned to me</option><option value="created">Created by me</option>{me.user.role !== 'staff' && <option value="all">Everyone</option>}</select>
      <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="open">Open</option><option value="done">Done</option></select></div>
      <form className="addrow tasknew" onSubmit={async (e) => { e.preventDefault(); if (title.trim()) { await post('/api/tasks', { title }); setTitle(''); load(); } }}><input placeholder="New task for myself…" aria-label="New task" value={title} onChange={(e) => setTitle(e.target.value)} /><button className="primary">Add</button></form>
      {rows === null ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">No tasks here.</p> : rows.map((t) => (
        <div key={t.id} className="trow"><div><label className="inline"><input type="checkbox" checked={t.status === 'done'} onChange={async (e) => { await api('PATCH', `/api/tasks/${t.id}`, { status: e.target.checked ? 'done' : 'open' }); load(); }} /> <b>{t.title}</b></label>
          <div className="small muted">{t.assignee_name}{t.due_at ? ` · due ${fmtTime(t.due_at)}` : ''} {t.overdue && <span className="chip bad">Overdue</span>}{t.first_name && ` · ${t.first_name} ${t.last_name ?? ''}`}</div></div>
          {t.conversation_id && <button onClick={() => onOpenConversation(t.conversation_id)}>Open customer thread</button>}</div>))}
    </div>
  );
}
