import { useEffect, useRef, useState } from 'react';
import { api, useLive, usd } from './api.ts';
import { ProposalTray } from './Proposals.tsx';
import { speak, stop, supported } from './speech.ts';

export type Msg = { id: number | string; role: 'luke' | 'jarvis'; content: string; rating?: 'up' | 'down' | null };

/** All conversation behaviour in one place, shared by the small dock and the Command Center console. */
export function useConversation(navigate: (h: string) => void, setThinking: (b: boolean) => void) {
  const { data, reload: reloadChat } = useLive<Msg[]>(() => api('/api/chat'), ['chat']);
  const { data: persona } = useLive<any>(() => api('/api/persona'), []);
  const [local, setLocal] = useState<Msg[]>([]); // private-mode turns live only in this component's memory
  const [text, setText] = useState(''), [priv, setPriv] = useState(false), [busy, setBusy] = useState(false), [meta, setMeta] = useState('');
  const [aloud, setAloud] = useState(() => { try { return localStorage.getItem('jv.aloud') === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('jv.aloud', aloud ? '1' : '0'); } catch { /* ignore */ } }, [aloud]);
  useEffect(() => { if (!priv) setLocal([]); }, [priv]);
  const msgs = [...(data ?? []), ...local];

  async function send(raw?: string) {
    const t = (raw ?? text).trim(); if (!t || busy) return;
    stop(); // anything still being spoken is stale the moment you speak again
    setText(''); setBusy(true); setThinking(true);
    try {
      const r = await api<{ text: string; action?: { navigate?: string }; persisted: boolean; source?: string; model?: string; costMicroUsd?: number }>('/api/chat', 'POST', { text: t, private: priv });
      setMeta(r.source === 'model' ? `${r.model} · ${usd(r.costMicroUsd ?? 0)}` : 'command (free)');
      if (priv) setLocal((l) => [...l, { id: 'l' + Math.random(), role: 'luke', content: t }, { id: 'l' + Math.random(), role: 'jarvis', content: r.text }]);
      if (aloud && persona) speak(r.text, persona.voice);
      if (r.action?.navigate) navigate(r.action.navigate);
    } catch (x) { setLocal((l) => [...l, { id: 'e' + Math.random(), role: 'jarvis', content: `Error: ${(x as Error).message}` }]); }
    finally { setBusy(false); setThinking(false); }
  }
  return { msgs, reloadChat, text, setText, priv, setPriv, busy, meta, aloud, setAloud, persona, send, speakMsg: (m: string) => persona && speak(m, persona.voice) };
}
export type Conversation = ReturnType<typeof useConversation>;

/** The small floating dock used on the Agent Universe and as the "Talk to Jarvis" button on other pages. */
export function Chat({ open, setOpen, convo, hidden }: { open: boolean; setOpen: (b: boolean) => void; convo: Conversation; hidden?: boolean }) {
  const { msgs, reloadChat, text, setText, priv, setPriv, busy, meta, aloud, setAloud, persona, send, speakMsg } = convo;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length, open]);
  if (hidden) return null;
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
      {priv && <p className="note">Private mode: this session is not saved, indexed, logged or used for memory, and Jarvis will not create or change records. The browser keeps it only until you leave private mode. (The model is off in private mode unless you allow it in Settings.)</p>}
      <div className="chat-log" role="log" aria-live="polite">
        {msgs.length === 0 && <p className="muted">Try: <em>research “dry stack storage costs” from https://…</em>, <em>add task call the marina</em>, <em>status</em>, <em>show me Sales</em>. Start a message with <em>deep:</em> for the stronger model.</p>}
        {msgs.map((m) => <div key={m.id} className={`msg ${m.role}`}>{m.content}{m.role === 'jarvis' && supported() && persona && <button className="link small say" onClick={() => speakMsg(m.content)} aria-label="Read aloud">🔊</button>}{m.role === 'jarvis' && typeof m.id === 'number' && <span className="rate"><button className="link small" aria-label="Good answer" aria-pressed={m.rating === 'up'} title="Good answer" onClick={() => void api(`/api/chat/${m.id}/feedback`, 'POST', { rating: 'up' }).then(() => reloadChat())}>{m.rating === 'up' ? '👍' : '👍🏻'}</button><button className="link small" aria-label="Wrong answer" aria-pressed={m.rating === 'down'} title="Wrong answer" onClick={() => void api(`/api/chat/${m.id}/feedback`, 'POST', { rating: 'down' }).then(() => reloadChat())}>{m.rating === 'down' ? '👎' : '👎🏻'}</button></span>}</div>)}
        <div ref={end} />
      </div>
      <ProposalTray className="dock-props" />
      <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="chat-form">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type to Jarvis…" aria-label="Message" maxLength={2000} />
        <button type="button" disabled title="Push-to-talk arrives with the voice adapter (Phase 2). Not faked here.">🎙 soon</button>
        <button className="primary" disabled={busy || !text.trim()}>Send</button>
      </form>
    </aside>
  );
}
