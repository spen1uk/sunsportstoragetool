import { useState } from 'react';
import { api, useLive } from './api.ts';

type P = { id: string; kind: string; summary: string };
/**
 * Things Jarvis has PROPOSED. Nothing here has happened: each card does nothing until you press Confirm.
 * The wording comes from the server's validated fields, not from the model's own text.
 */
export function ProposalTray({ className = '' }: { className?: string }) {
  const { data, reload } = useLive<P[]>(() => api('/api/proposals'), ['proposals']);
  const [done, setDone] = useState<Record<string, { ok: boolean; text: string }>>({}); const [busy, setBusy] = useState('');
  const act = async (p: P, what: 'confirm' | 'dismiss') => {
    setBusy(p.id);
    try {
      const r = await api<any>(`/api/proposals/${p.id}/${what}`, 'POST', {});
      if (what === 'confirm') setDone((d) => ({ ...d, [p.id]: { ok: r.ok, text: r.message } }));
    } catch (e) { setDone((d) => ({ ...d, [p.id]: { ok: false, text: e instanceof Error ? e.message : String(e) } })); }
    finally { setBusy(''); reload(); setTimeout(() => setDone((d) => { const n = { ...d }; delete n[p.id]; return n; }), 7000); }
  };
  const pending = data ?? []; const results = Object.entries(done).filter(([id]) => !pending.some((p) => p.id === id));
  if (!pending.length && !results.length) return null;
  return (
    <div className={`props ${className}`} role="region" aria-label="Actions Jarvis is proposing">
      {pending.length > 0 && <div className="props-title">Jarvis proposes — nothing happens until you confirm</div>}
      {pending.map((p) => (
        <div key={p.id} className="prop">
          <span className="grow">{p.summary}</span>
          <button className="primary" disabled={busy === p.id} onClick={() => void act(p, 'confirm')}>Confirm</button>
          <button disabled={busy === p.id} onClick={() => void act(p, 'dismiss')}>Dismiss</button>
        </div>))}
      {results.map(([id, r]) => <div key={id} className={`prop result ${r.ok ? 'ok' : 'err'}`} role="status">{r.ok ? '✓ ' : '✕ '}{r.text}</div>)}
    </div>
  );
}
