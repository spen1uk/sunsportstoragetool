import { useEffect, useState } from 'react';
import { api } from './api.ts';

const when = (t: number | null) => (t ? new Date(t).toLocaleDateString() : '');
const mark = (text: string, terms: string[]) => {
  if (!terms.length) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return text.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p));
};

/** One box over everything Jarvis holds for you. Each result says where it came from and takes you there. */
export function SearchPage() {
  const [q, setQ] = useState(''), [imports, setImports] = useState(false), [res, setRes] = useState<any>(null), [err, setErr] = useState('');
  const go = async (text = q) => { setErr(''); if (text.trim().length < 2) { setRes(null); return; } try { setRes(await api(`/api/search?q=${encodeURIComponent(text.trim())}${imports ? '&imports=1' : ''}`)); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { const t = setTimeout(() => void go(), 300); return () => clearTimeout(t); }, [q, imports]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="page"><h1>Search</h1>
      <p className="muted">Looks through your memory, tasks, notes, calendar, research, decisions, missions, reports, people and past conversations. It matches words you type (every word must appear), runs on this machine and sends nothing anywhere.</p>
      <div className="glass pad section">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="What are you looking for?" aria-label="Search everything" style={{ width: '100%' }} />
        <label className="small"><input type="checkbox" checked={imports} onChange={(e) => setImports(e.target.checked)} /> Include chats I imported from ChatGPT (private; only you see these here)</label>
      </div>
      {err && <p className="err small" role="alert">{err}</p>}
      {res && res.excluded && <p className="muted small">You asked me never to keep anything about that.</p>}
      {res && !res.excluded && res.total === 0 && <p className="muted small">Nothing found for “{res.query}”. Try fewer or different words.</p>}
      {res?.groups.map((g: any) => (
        <div key={g.kind} className="glass pad section"><h2>{g.label} <span className="muted small">({g.items.length})</span></h2>
          <ul className="plain">{g.items.map((h: any) => <li key={g.kind + h.id + h.title} style={{ marginBottom: 8 }}><a href={h.link}><b>{mark(h.title, res.terms)}</b></a> <span className="muted small">{when(h.at)}</span>
            {h.snippet && h.snippet !== h.title && <div className="small muted">{mark(h.snippet, res.terms)}</div>}</li>)}</ul></div>))}
    </section>);
}
