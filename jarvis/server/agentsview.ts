import { type DB } from './db.ts';
import * as registry from './skills/registry.ts';
import { PRINCIPALS, tierOf } from './skills/manifest.ts';
import * as tempagents from './tempagents.ts';
import { monthStartOf } from './llm/gateway.ts';
import * as deleg from './delegation.ts';

/**
 * One honest page about who does what: the agents that really exist (Jarvis, Prometheus, short-lived mission agents), what each is allowed
 * to do (read from the live skills registry, not written by hand), what it did recently, what it cost this month, and what it can never do.
 * Everything else in the org chart is listed as planned/not connected. Read-only.
 */
const SENS = { public: 'public information only', private: 'your private data' } as const;
const ago = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t));

function skillsFor(db: DB, principal: 'jarvis' | 'prometheus') {
  return registry.summary(db).filter((s: any) => s.access[principal]?.allowed).map((s: any) => ({ id: s.id, title: s.title, purpose: s.purpose, tier: s.tier, effects: s.sideEffects, data: s.dataSensitivity, via: s.access[principal].via }));
}
const spend = (db: DB, sql: string, now: number) => Number((db.prepare(`SELECT COALESCE(SUM(cost_micro_usd),0) s FROM llm_usage WHERE ok=1 AND at>=? AND ${sql}`).get(monthStartOf(now)) as any).s);

export function overview(db: DB, now = Date.now()) {
  registry.sync(db);
  const recentRuns = (p: string) => (db.prepare('SELECT skill_id,at,ok,refused FROM skill_runs WHERE principal=? ORDER BY id DESC LIMIT 6').all(p) as any[]).map((r) => ({ at: r.at, text: `${r.ok ? 'Used' : r.refused ? 'Was refused' : 'Failed using'} ${r.skill_id}` }));
  const approvals = Number((db.prepare("SELECT COUNT(*) c FROM approvals WHERE status='pending'").get() as any).c);
  const openTasks = Number((db.prepare("SELECT COUNT(*) c FROM tasks WHERE kind='manual' AND owner='luke' AND is_demo=0 AND state NOT IN ('completed','canceled','failed')").get() as any).c);
  const lastChat = db.prepare("SELECT at FROM messages WHERE role='jarvis' ORDER BY id DESC LIMIT 1").get() as { at: string } | undefined;
  const research = db.prepare("SELECT title,state,updated_at FROM tasks WHERE kind='research' AND is_demo=0 ORDER BY updated_at DESC LIMIT 5").all() as any[];
  const missions = db.prepare("SELECT title,status,updated_at FROM missions ORDER BY updated_at DESC LIMIT 5").all() as any[];
  const live = tempagents.list(db, now).filter((a: any) => a.live);
  const running = Number((db.prepare("SELECT COUNT(*) c FROM tasks WHERE kind='research' AND state IN ('running','queued','ready') AND is_demo=0").get() as any).c);
  const activeMissions = Number((db.prepare("SELECT COUNT(*) c FROM missions WHERE status='active'").get() as any).c);

  const jarvis = {
    id: 'jarvis', name: 'Jarvis', role: 'Your assistant and coordinator',
    does: 'Talks with you, keeps your tasks, calendar, notes and memory, writes the briefing, and hands research to Prometheus. Anything consequential becomes a Confirm card for you.',
    status: lastChat && now - ago(lastChat.at) < 3_600_000 ? 'Active in the last hour' : 'Ready', busy: false,
    sees: SENS[PRINCIPALS.jarvis.maxSensitivity as 'private'], skills: skillsFor(db, 'jarvis'),
    cannot: ['Send, spend, delete, publish or trade by itself', 'Change its own permissions', 'Use a skill that moves money or messages people (those are always your decision)'],
    recent: recentRuns('jarvis'), month: spend(db, "task IN ('chat','ping')", now),
    now: [`${openTasks} open task${openTasks === 1 ? '' : 's'} of yours`, `${approvals} waiting for your approval`],
    links: [{ label: 'Skills', href: '#/skills' }, { label: 'Approvals', href: '#/approvals' }, { label: 'Memory', href: '#/memory' }],
  };
  const prometheus = {
    id: 'prometheus', name: 'Prometheus', role: 'Research agent',
    does: 'Searches the web, cross-checks sources, runs deeper research jobs and missions, and watches topics you choose. It reports back through Jarvis.',
    status: running || activeMissions ? `Working (${running} job${running === 1 ? '' : 's'}, ${activeMissions} mission${activeMissions === 1 ? '' : 's'})` : 'Idle', busy: !!(running || activeMissions),
    sees: SENS[PRINCIPALS.prometheus.maxSensitivity as 'public'], skills: skillsFor(db, 'prometheus'),
    cannot: ['See your tasks, calendar, notes, memory or messages', 'Take any action; it can only read and report', 'Start spending by itself beyond the small monthly exploring budget you set'],
    recent: [...recentRuns('prometheus'), ...research.map((r) => ({ at: ago(r.updated_at), text: `Research: ${r.title} (${r.state})` })), ...missions.map((m) => ({ at: m.updated_at, text: `Mission: ${m.title} (${m.status})` }))].sort((a, b) => b.at - a.at).slice(0, 8),
    month: spend(db, "task IN ('web','analysis')", now),
    now: [`${running} research job${running === 1 ? '' : 's'} in progress`, `${activeMissions} active mission${activeMissions === 1 ? '' : 's'}`, `${live.length} short-lived helper${live.length === 1 ? '' : 's'} right now`],
    links: [{ label: 'Prometheus', href: '#/research' }, { label: 'Missions', href: '#/missions' }],
  };
  const helpers = live.map((a: any) => ({ id: a.id, name: a.name, charter: String(a.charter).slice(0, 160), expiresAt: a.expiresAt ?? a.expires_at ?? null }));
  const planned = (db.prepare("SELECT id,name,description,status_kind FROM agents WHERE parent_id='jarvis' ORDER BY sort").all() as any[]).filter((a) => !['proj'].includes(a.id)).map((a) => ({ id: a.id, name: a.name, note: String(a.description).slice(0, 160), status: a.status_kind }));
  const cards = deleg.scorecards(db, now);
  return { agents: [{ ...jarvis, scorecard: cards.jarvis }, { ...prometheus, scorecard: cards.prometheus }], helpers, planned, note: 'What each agent can do is read live from the skills registry. Spending is approximate (grouped by kind of model call).' };
}
export { tierOf };
