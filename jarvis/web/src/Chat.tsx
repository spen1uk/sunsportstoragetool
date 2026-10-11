import { useEffect, useRef, useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { speak, stop, supported } from './speech.ts';

type Msg = { id: number | string; role: 'luke' | 'jarvis'; content: string };

export function Chat({ open, setOpen, navigate, setThinking }: { open: boolean; setOpen: (b: boolean) => void; navigate: (h: string) => void; setThinking: (b: boolean) => void }) {
  const { data } = useLive<Msg[]>(() => api('/api/chat'), ['chat']);
  const [local, setLocal] = useState<Msg[]>([]); // private-mode turns live only in this component's memory
  const [text, setText] = useState(''), [priv, setPriv] = useState(false), [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const { data: persona } = useLive<any>(() => api('/api/persona'), []);
  const [aloud, setAloud] = useState(() => localStorage.getItem('jv.aloud') === '1');
  const [meta, setMeta] = useState('');
  useEffect(() => { try { localStorage.setItem('jv.aloud', aloud ? '1' : '0'); } catch { /* ignore */ } }, [aloud]);
  const msgs = [...(data ?? []), ...local];
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, open]);
  useEffect(() => { if (!priv) setLocal([]); }, [priv]);

  async function send(e: React.FormEvent) {
    e.preventDefault(); const t = text.trim(); if (!t || busy) return;
    stop(); // anything still being spoken is stale the moment you speak again
    setText(''); setBusy(true); setThinking(true);
    try {
      const r = await api<{ text: string; action?: { navigate?: string }; persisted: boolean; source?: string; model?: string; costMicroUsd?: number }>('/api/chat', 'POST', { text: t, private: priv });
      setMeta(r.source === 'model' ? `${r.model} · ${usd(r.costMicroUsd ?? 0)}` : 'command (free)');
      if (aloud && persona) speak(r.text, persona.voice);
      if (priv) setLocal((l) => [...l, { id: 'l' + Math.random(), role: 'luke', content: t }, { id: 'l' + Math.random(), role: 'jarvis', content: r.text }]);
      if (r.action?.navigate) navigate(r.action.navigate);
    } catch (x) { setLocal((l) => [...l, { id: 'e' + Math.random(), role: 'jarvis', content: `Error: ${(x as Error).message}` }]); }
    finally { setBusy(false); setThinking(false); }
  }

  if (!open) return <button className="chat-fab primary" onClick={() => setOpen(true)}>Talk to Jarvis</button>;
  return (
    <aside className={`chat glass ${priv ? 'private' : ''}`} aria-label="Conversation with Jarvis">
      <div className="chat-head">
        <strong>Jarvis</strong><span className="muted">{meta ? `last: ${meta}` : 'command mode unless a model is configured'}</span>
        <span className="grow" />
        {supported() && <label className="check" title="Read replies aloud with a British voice on this Mac"><input type="checkbox" checked={aloud} onChange={(e) => { setAloud(e.target.checked); if (!e.target.checked) stop(); }} /> Speak</label>}
        <label className="check"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private</label>
        <button onClick={() => setOpen(false)} aria-label="Minimise conversation">–</button>
      </div>
      {priv && <p className="note">Private mode: this session is not saved, indexed, logged or used for memory, and Jarvis will not create or change records. The browser keeps it only until you leave private mode. (No external model provider is connected yet, so nothing leaves this machine.)</p>}
      <div className="chat-log" role="log" aria-live="polite">
        {msgs.length === 0 && <p className="muted">Try: <em>research “dry stack storage costs” from https://…</em>, <em>add task call the marina</em>, <em>status</em>, <em>show me Sales</em>. Start a message with <em>deep:</em> for the stronger model.</p>}
        {msgs.map((m) => <div key={m.id} className={`msg ${m.role}`}>{m.content}{m.role === 'jarvis' && supported() && persona && <button className="link small say" onClick={() => speak(m.content, persona.voice)} aria-label="Read aloud">🔊</button>}</div>)}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="chat-form">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type to Jarvis…" aria-label="Message" maxLength={2000} />
        <button type="button" disabled title="Push-to-talk arrives with the voice adapter (Phase 2). Not faked here.">🎙 soon</button>
        <button className="primary" disabled={busy || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}
