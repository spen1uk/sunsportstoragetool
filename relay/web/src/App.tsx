import { useCallback, useEffect, useState } from 'react';
import { get, post, subscribe } from './api';
import { Inbox } from './Inbox';
import { Customers } from './Customers';
import { Setup } from './Setup';
import { MediaLibrary } from './Media';
import { Settings } from './Settings';
import { TeamChat } from './TeamChat';
import { Matches } from './Matches';
import { Automations } from './Automations';
import { Broadcasts } from './Broadcasts';
import { Analytics } from './Analytics';
import { Connections } from './Connections';
import { Payments } from './Payments';
import { Reviews } from './Reviews';

export interface Me { user: { id: string; name: string; role: string; departmentIds: string[] }; workspace: { name: string; timezone: string }; channels: any[]; simulated: boolean }

const NAV: { key: string; label: string; icon: string; setup?: { phase: string; needs: string } }[] = [
  { key: 'inbox', label: 'Inbox', icon: '✉' }, { key: 'customers', label: 'Customers', icon: '☺' },
  { key: 'team', label: 'Team Chat', icon: '☷' },
  { key: 'matches', label: 'Inventory Matches', icon: '⚓' },
  { key: 'reviews', label: 'Reviews', icon: '★' },
  { key: 'payments', label: 'Payments', icon: '$' },
  { key: 'automations', label: 'Automations', icon: '⚙' },
  { key: 'broadcasts', label: 'Broadcasts', icon: '📣' },
  { key: 'media', label: 'Media', icon: '▣' },
  { key: 'analytics', label: 'Analytics', icon: '▥' },
  { key: 'connections', label: 'Connections', icon: '⇄' },
  { key: 'settings', label: 'Settings', icon: '☰' },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState('inbox');
  const [focus, setFocus] = useState<string | null>(null);
  const [compose, setCompose] = useState<{ conversationId: string; body: string; mediaIds: string[]; packageId: string } | null>(null);
  const [chatFocus, setChatFocus] = useState<string | null>(null);
  const refresh = useCallback(() => get<Me>('/api/me').then(setMe).catch(() => setMe(null)), []);
  useEffect(() => { refresh(); }, [refresh]);
  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login onDone={refresh} />;
  const cur = NAV.find((n) => n.key === tab)!;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand"><span className="logo">≈</span><span className="brand-text">Relay</span></div>
        {NAV.map((n) => (
          <button key={n.key} className={`navbtn ${tab === n.key ? 'active' : ''}`} onClick={() => setTab(n.key)} aria-current={tab === n.key ? 'page' : undefined} title={n.label}>
            <span className="navicon" aria-hidden>{n.icon}</span><span className="navlabel">{n.label}</span>
          </button>
        ))}
        <div className="spacer" />
        <button className="navbtn" onClick={async () => { await post('/api/auth/logout'); setMe(null); }}><span className="navicon">⏻</span><span className="navlabel">Sign out</span></button>
      </nav>
      <main className="main">
        <header className="topbar">
          <strong>{me.workspace.name}</strong>
          {me.simulated && <span className="badge demo" title="No real SMS provider is connected. Nothing leaves this system.">DEMO · simulated SMS — no real texts are sent</span>}
          <Bell me={me} onOpen={(cid) => { setFocus(cid); setTab('inbox'); }} onOpenChannel={(ch) => { setChatFocus(ch); setTab('team'); }} />
          <span className="muted small">{me.user.name} · {me.user.role}</span>
        </header>
        <div className="content">
          {tab === 'inbox' && <Inbox key={focus ?? 'none'} me={me} focus={focus} compose={compose} onComposeUsed={() => setCompose(null)} onOpenTeam={(id) => { setChatFocus(id); setTab('team'); }} />}
          {tab === 'team' && <TeamChat key={chatFocus ?? 'x'} me={me} initialChannel={chatFocus} onOpenConversation={(cid) => { setFocus(cid); setTab('inbox'); }} />}
          {tab === 'matches' && <Matches me={me} onCompose={(c) => { setCompose(c); setFocus(c.conversationId); setTab('inbox'); }} />}
          {tab === 'automations' && <Automations me={me} onOpenConversation={(cid) => { setFocus(cid); setTab('inbox'); }} />}
          {tab === 'broadcasts' && <Broadcasts me={me} />}
          {tab === 'analytics' && <Analytics me={me} />}
          {tab === 'reviews' && <Reviews me={me} />}
          {tab === 'payments' && <Payments me={me} onCompose={(c) => { setCompose(c); setFocus(c.conversationId); setTab('inbox'); }} />}
          {tab === 'connections' && <Connections me={me} />}
          {tab === 'media' && <MediaLibrary />}
          {tab === 'settings' && <Settings me={me} />}
          {tab === 'customers' && <Customers me={me} />}
          {cur.setup && <Setup title={cur.label} phase={cur.setup.phase} needs={cur.setup.needs} />}
        </div>
      </main>
    </div>
  );
}

function Bell({ me, onOpen, onOpenChannel }: { me: Me; onOpen: (conversationId: string) => void; onOpenChannel: (channelId: string) => void }) {
  const [d, setD] = useState<{ items: any[]; unread: number }>({ items: [], unread: 0 }); const [open, setOpen] = useState(false);
  const load = useCallback(() => get('/api/notifications').then(setD).catch(() => {}), []);
  useEffect(() => { load(); return subscribe((e) => { if (e.type === 'notification' && e.userId === me.user.id) load(); }); }, [load, me.user.id]);
  return (
    <div className="bell right"><button onClick={() => { setOpen(!open); if (!open) post('/api/notifications/read').then(load); }} aria-label={`Notifications, ${d.unread} unread`}>🔔{d.unread > 0 && <span className="chip count">{d.unread}</span>}</button>
      {open && <div className="popover drop">{d.items.length === 0 ? <p className="muted small pad">Nothing yet.</p> : d.items.map((n) => <button key={n.id} className="row" onClick={() => { setOpen(false); if (n.conversation_id) onOpen(n.conversation_id); else if (n.type === 'mention' && n.ref_id) onOpenChannel(n.ref_id); }}><span className={n.read_at ? '' : 'unreadtext'}>{n.title}</span><span className="small muted">{new Date(n.created_at).toLocaleString()}</span></button>)}
        <p className="small muted pad">In-app only. Phone/desktop push notifications are not built yet.</p></div>}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [err, setErr] = useState('');
  return (
    <div className="center">
      <form className="card login" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await post('/api/auth/login', { email, password }); onDone(); } catch (x: any) { setErr(x.message); } }}>
        <h1>Relay</h1><p className="muted">Sun Sport Marine</p>
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="primary" type="submit">Sign in</button>
      </form>
    </div>
  );
}
