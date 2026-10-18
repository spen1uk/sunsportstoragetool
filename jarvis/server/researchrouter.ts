import type { DB } from './db.ts';
import * as src from './sources.ts';
import * as ws from './websearch.ts';

/**
 * The research router: decides, from rules you can read, HOW a question gets researched.
 *  - web search (the default engine) when it is on and a model is available;
 *  - an extra pass limited to your TRUSTED catalog sites when some match the topic (deep tier only);
 *  - your BLOCKED catalog sites are always excluded;
 *  - specific pages you name are read through the existing approval-gated fetcher (a separate path: "research <question> from <https url>").
 * Free public data APIs (patents, papers, filings) are deliberately not wired: each needs your approval and a terms review first.
 */
export type Plan = { routes: string[]; focusDomains: string[]; blockedDomains: string[]; notes: string[] };
export function planRoutes(db: DB, o: { question: string; tier: 'quick' | 'deep' }): Plan {
  const notes: string[] = [], routes: string[] = [];
  const web = ws.getConfig(db).enabled; if (web) routes.push('web search');
  const blocked = src.blockedHosts(db), trusted = o.tier === 'deep' ? src.trustedFor(db, o.question) : [];
  if (blocked.length) notes.push(`${blocked.length} catalog site(s) you blocked are excluded from searches.`);
  if (trusted.length) { routes.push(`trusted-sites pass (${trusted.length} site${trusted.length > 1 ? 's' : ''})`); notes.push(`A focused pass used only: ${trusted.slice(0, 6).join(', ')}${trusted.length > 6 ? '…' : ''}.`); }
  return { routes, focusDomains: trusted, blockedDomains: blocked, notes };
}
