import { useEffect, useRef, useState } from 'react';
import { api, useLive } from './api.ts';

type Msg = { id: number | string; role: 'luke' | 'jarvis'; content: string };

export function Chat({ open, setOpen, navigate, setThinking }: { open: boolean; setOpen: (b: boolean) => void; navigate: (h: string) => void; setThinking: (b: boolean) => void }) {
  const { data } = useLive<Msg[]>(() => api('/api/chat'), ['chat']);
  const [local, setLocal] = useState<Msg[]>([]); // private-mode turns live only in this component's memory
  const [text, setText] = useState(''), [priv, setPriv] = useState(false), [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const msgs = [...(data ?? []), ...local];
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, open]);
  useEffect(() => { if (!priv) setLocal([]); }, [priv]);

  async function send(e: React.FormEvent) {
    e.preventDefault(); const t = text.trim(); if (!t || busy) return;
    setText(''); setBusy(true); setThinking(true);
    try {
      const r = await api<{ text: string; action?: { navigate?: string }; persisted: boolean }>('/api/chat', 'POST', { text: t, private: priv });
      if (priv) setLocal((l) => [...l, { id: 'l' + Math.random(), role: 'luke', content: t }, { id: 'l' + Math.random(), role: 'jarvis', content: r.text }]);
      if (r.action?.navigate) navigate(r.action.navigate);
    } catch (x) { setLocal((l) => [...l, { id: 'e' + Math.random(), role: 'jarvis', content: `Error: ${(x as Error).message}` }]); }
    finally { setBusy(false); setThinking(false); }
  }

  if (!open) return <button className="chat-fab primary" onClick={() => setOpen(true)}>Talk to Jarvis</button>;
  return (
    <aside className={`chat glass ${priv ? 'private' : ''}`} aria-label="Conversation with Jarvis">
      <div className="chat-head">
        <strong>Jarvis</strong><span className="muted">command mode · no language model</span>
        <span className="grow" />
        <label className="check"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private</label>
        <button onClick={() => setOpen(false)} aria-label="Minimise conversation">–</button>
      </div>
      {priv && <p className="note">Private mode: this session is not saved, indexed, logged or used for memory, and Jarvis will not create or change records. The browser keeps it only until you leave private mode. (No external model provider is connected yet, so nothing leaves this machine.)</p>}
      <div className="chat-log" role="log" aria-live="polite">
        {msgs.length === 0 && <p className="muted">Try: <em>research “dry stack storage costs” from https://…</em>, <em>add task call the marina</em>, <em>status</em>, <em>show me Sales</em>.</p>}
        {msgs.map((m) => <div key={m.id} className={`msg ${m.role}`}>{m.content}</div>)}
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
