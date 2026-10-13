import { useRef, useState } from 'react';
import { ApiError, api, get, post } from './api';

const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

/** Voice → draft. Recording NEVER sends: the draft is shown with the original transcript and needs an explicit Send click. */
export function VoicePanel({ conversationId, onSent, onClose }: { conversationId: string; onSent: () => void; onClose: () => void }) {
  const [rec, setRec] = useState(false); const [transcript, setTranscript] = useState(''); const [draft, setDraft] = useState<any>(null); const [text, setText] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const mr = useRef<MediaRecorder | null>(null); const chunks = useRef<Blob[]>([]); const sr = useRef<any>(null); const blob = useRef<Blob | null>(null);
  const canRecord = typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  const start = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks.current = []; const r = new MediaRecorder(stream); mr.current = r;
      r.ondataavailable = (e) => chunks.current.push(e.data);
      r.onstop = () => { blob.current = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }); stream.getTracks().forEach((t) => t.stop()); };
      r.start(); setRec(true);
      if (SR) { const s = new SR(); s.continuous = true; s.interimResults = false; s.onresult = (e: any) => setTranscript((t) => (t + ' ' + Array.from(e.results).slice(e.resultIndex).map((x: any) => x[0].transcript).join(' ')).trim()); s.onerror = () => {}; s.start(); sr.current = s; }
    } catch { setErr('Microphone permission was denied or no microphone is available. You can type the message instead.'); }
  };
  const stop = () => { mr.current?.stop(); sr.current?.stop(); setRec(false); };
  const make = async () => {
    setBusy(true); setErr('');
    try {
      const fd = new FormData(); if (transcript.trim()) { fd.append('transcript', transcript); fd.append('transcriptSource', SR && blob.current ? 'browser_speech' : 'typed'); }
      if (blob.current) fd.append('audio', blob.current, 'voice.webm');
      const res = await fetch(`/api/conversations/${conversationId}/voice-drafts`, { method: 'POST', headers: { 'x-relay-csrf': '1' }, body: fd }); const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data.error);
      setDraft(data); setText(data.cleanedText ?? '');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="popover voice">
      <b>Voice message</b>
      <p className="small muted">Nothing is sent until you review the draft and press Send. {canRecord ? (SR ? 'Your browser provides speech recognition (audio may be processed by the browser vendor).' : 'This browser has no speech recognition: type or paste the words below.') : 'Recording is not supported here: type the message.'} No audio goes to any AI provider.</p>
      {!draft && <>
        {canRecord && (rec ? <button className="primary" onClick={stop}>■ Stop recording</button> : <button onClick={start}>● Record</button>)}
        <textarea rows={3} aria-label="Transcript" placeholder="Transcript (spoken text appears here; you can also type)" value={transcript} onChange={(e) => setTranscript(e.target.value)} />
        <div className="btns"><button className="primary" disabled={busy || rec || (!transcript.trim() && !blob.current)} onClick={make}>Make draft</button><button onClick={onClose}>Cancel</button></div></>}
      {draft && <>
        {draft.needsTranscript && <p className="banner warn small">No transcript yet — no transcription provider is configured. Type what was said below.</p>}
        {draft.transcriptOriginal && <><label>Original transcript<textarea rows={2} readOnly value={draft.transcriptOriginal} /></label></>}
        <label>Draft to send (edit freely)<textarea rows={3} aria-label="Draft to send" value={text} onChange={(e) => setText(e.target.value)} /></label>
        <p className="small muted">Cleanup only removes filler words and fixes capitalization/punctuation — it never adds words. Check prices, dates and promises yourself.</p>
        <div className="btns"><button className="primary" disabled={!text.trim() || busy} onClick={async () => { if (!confirm('Send this message to the customer now?')) return; setBusy(true); try { await post(`/api/voice-drafts/${draft.id}/send`, { finalText: text, confirm: true }); onSent(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }}>Send to customer</button>
          <button onClick={async () => { await api('DELETE', `/api/voice-drafts/${draft.id}`).catch(() => {}); onClose(); }}>Discard</button></div></>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}
void get;
