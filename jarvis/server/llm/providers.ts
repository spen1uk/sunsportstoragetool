import { type DB } from '../db.ts';
import { audit } from '../audit.ts';
import { publish } from '../events.ts';
import { registry } from './gateway.ts';

/**
 * Vendors we know of. Only those with code in `registry.providers` can ever be called; the rest are listed honestly as candidates.
 * Adding one needs: provider code (reviewed), an API key set server-side, a price entry, a data-retention review and your approval here.
 */
export const CANDIDATES = [
  { id: 'openai', label: 'OpenAI' }, { id: 'google', label: 'Google Gemini' }, { id: 'xai', label: 'xAI Grok' }, { id: 'perplexity', label: 'Perplexity' },
] as const;

type Approval = { approved: boolean; allowPrivate: boolean; decidedAt: number | null };
/** Anthropic is what Jarvis already runs on, approved for private text. Everything else starts not approved. */
export function getApproval(db: DB, provider: string): Approval {
  const r = db.prepare('SELECT * FROM provider_approvals WHERE provider=?').get(provider) as any;
  if (r) return { approved: !!r.approved, allowPrivate: !!r.allow_private, decidedAt: r.decided_at };
  return provider === 'anthropic' ? { approved: true, allowPrivate: true, decidedAt: null } : { approved: false, allowPrivate: false, decidedAt: null };
}
export function setApproval(db: DB, provider: string, a: { approved: boolean; allowPrivate: boolean }) {
  if (!registry.providers[provider]) throw new Error('That provider has no code in Jarvis yet, so there is nothing to approve.');
  if (a.allowPrivate && !a.approved) throw new Error('A provider must be approved before it can be allowed to see private text.');
  const before = getApproval(db, provider);
  db.prepare('INSERT INTO provider_approvals(provider,approved,allow_private,decided_at) VALUES(?,?,?,?) ON CONFLICT(provider) DO UPDATE SET approved=excluded.approved, allow_private=excluded.allow_private, decided_at=excluded.decided_at').run(provider, a.approved ? 1 : 0, a.allowPrivate ? 1 : 0, Date.now());
  audit(db, 'luke', 'llm.provider_approval', provider, { before, after: a }); publish({ type: 'models' });
  return getApproval(db, provider);
}
export function list(db: DB) {
  const built = Object.values(registry.providers).map((p) => ({ id: p.id, label: p.id === 'anthropic' ? 'Anthropic (Claude)' : p.id, connected: true, configured: p.available(), webSearch: !!p.capabilities?.webSearch, ...getApproval(db, p.id) }));
  const have = new Set(built.map((b) => b.id));
  return [...built, ...CANDIDATES.filter((c) => !have.has(c.id)).map((c) => ({ id: c.id, label: c.label, connected: false, configured: false, webSearch: false, approved: false, allowPrivate: false, decidedAt: null as number | null }))];
}
