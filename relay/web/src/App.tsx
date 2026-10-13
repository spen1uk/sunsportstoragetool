import { useCallback, useEffect, useState } from 'react';
import { get, post } from './api';
import { Inbox } from './Inbox';
import { Customers } from './Customers';
import { Setup } from './Setup';

export interface Me { user: { id: string; name: string; role: string; departmentIds: string[] }; workspace: { name: string; timezone: string }; channels: any[]; simulated: boolean }

const NAV: { key: string; label: string; icon: string; setup?: { phase: string; needs: string } }[] = [
  { key: 'inbox', label: 'Inbox', icon: '✉' }, { key: 'customers', label: 'Customers', icon: '☺' },
  { key: 'team', label: 'Team Chat', icon: '☷', setup: { phase: 'Phase 3', needs: 'Internal channels, DMs and tasks are planned next. Internal messages will use a separate data type that can never reach SMS.' } },
  { key: 'matches', label: 'Inventory Matches', icon: '⚓', setup: { phase: 'Phase 3', needs: 'Needs an inventory source of truth (your inventory system or a manual import). Nothing is shown until real inventory is connected — stale data is never presented as available.' } },
  { key: 'reviews', label: 'Reviews', icon: '★', setup: { phase: 'Phase 5', needs: 'Requires Google Business Profile API access (to be verified) and owner approval before any review request is sent.' } },
  { key: 'payments', label: 'Payments', icon: '$', setup: { phase: 'Phase 5', needs: 'Requires a payment provider account with signed webhooks. Relay never stores card details.' } },
  { key: 'automations', label: 'Automations', icon: '⚙', setup: { phase: 'Phase 4', needs: 'Visual builder with dry-run is planned. All automation stays off until you enable it.' } },
  { key: 'broadcasts', label: 'Broadcasts', icon: '📣', setup: { phase: 'Phase 4', needs: 'Requires verified marketing consent records and owner authorization. Nothing will be sent automatically.' } },
  { key: 'media', label: 'Media', icon: '▣', setup: { phase: 'Phase 2', needs: 'Shared media library and MMS attachments are planned for Phase 2.' } },
  { key: 'analytics', label: 'Analytics', icon: '▥', setup: { phase: 'Phase 4', needs: 'Will report only measured data, with definitions. Provider acceptance is never counted as delivery.' } },
  { key: 'connections', label: 'Connections', icon: '⇄', setup: { phase: 'Phase 5', needs: 'See INTEGRATION_CAPABILITIES.md: every provider is pending until credentials exist and capabilities are verified.' } },
  { key: 'settings', label: 'Settings', icon: '☰', setup: { phase: 'Phase 1+', needs: 'Business hours, templates, users and departments management are planned. Timezone: America/Chicago (default).' } },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [tab, setTab] = useState('inbox');
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
          <span className="muted small right">{me.user.name} · {me.user.role}</span>
        </header>
        <div className="content">
          {tab === 'inbox' && <Inbox me={me} />}
          {tab === 'customers' && <Customers me={me} />}
          {cur.setup && <Setup title={cur.label} phase={cur.setup.phase} needs={cur.setup.needs} />}
        </div>
      </main>
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
