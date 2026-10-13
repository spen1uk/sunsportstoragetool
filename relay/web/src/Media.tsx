import { useCallback, useEffect, useState } from 'react';
import { api, get, post, upload } from './api';

export function Attachment({ id, filename, type }: { id: string; filename: string; type: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { get(`/api/media/${id}/link`).then((r) => setUrl(r.url)).catch(() => setUrl(null)); }, [id]);
  if (!url) return <span className="small muted">[attachment: {filename}]</span>;
  return type.startsWith('image/') ? <a href={url} target="_blank" rel="noreferrer"><img className="thumb" src={url} alt={filename} /></a> : <a href={url} target="_blank" rel="noreferrer">📎 {filename}</a>;
}

export function MediaLibrary() {
  const [items, setItems] = useState<any[] | null>(null); const [search, setSearch] = useState(''); const [err, setErr] = useState(''); const [category, setCategory] = useState('general');
  const load = useCallback(() => get('/api/media?search=' + encodeURIComponent(search)).then(setItems).catch((e) => setErr(e.message)), [search]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  return (
    <div className="page">
      <h2>Media library</h2>
      <p className="muted small">Private storage. Files are only reachable through short-lived signed links; deleting a file revokes its links immediately. Allowed: JPEG, PNG, GIF, WebP, MP4, PDF (≤25 MB; ≤5 MB when texting — provider limits still to be verified). Files are <b>not malware-scanned</b> yet.</p>
      <div className="addrow media">
        <input placeholder="Search files…" aria-label="Search media" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input placeholder="Category" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} />
        <label className="filebtn">Upload<input type="file" hidden accept="image/*,video/mp4,application/pdf" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setErr(''); try { await upload(f, { category }); load(); } catch (x: any) { setErr(x.message); } e.target.value = ''; }} /></label>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {items === null ? <p className="muted">Loading…</p> : items.length === 0 ? <p className="muted">No files yet. Upload photos, brochures or directions to reuse in messages.</p> :
        <ul className="grid">{items.map((m) => (
          <li key={m.id} className="card tile"><Attachment id={m.id} filename={m.filename} type={m.content_type} />
            <div className="small"><b>{m.filename}</b><br /><span className="muted">{m.category} · {(m.size_bytes / 1024).toFixed(0)} KB · {m.scan_status}</span></div>
            <div className="btns"><button onClick={async () => { await post(`/api/media/${m.id}/favorite`, { favorite: !m.is_favorite }); load(); }}>{m.is_favorite ? '★' : '☆'}</button>
              <button onClick={async () => { if (confirm('Delete this file? Existing links stop working.')) { await api('DELETE', `/api/media/${m.id}`); load(); } }}>Delete</button></div></li>))}</ul>}
    </div>
  );
}
