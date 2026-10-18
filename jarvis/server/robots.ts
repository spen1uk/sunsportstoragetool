/**
 * robots.txt handling (RFC 9309), so Jarvis's own page fetches honour what a site asks of automated visitors.
 * Longest matching rule wins; on a tie Allow wins; no matching rule means allowed. `*` matches anything and `$` anchors the end.
 */
export type Rule = { allow: boolean; pattern: string };
export type Group = { agents: string[]; rules: Rule[] };

export function parseRobots(text: string): Group[] {
  const groups: Group[] = []; let cur: Group | null = null, lastWasAgent = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).trim();
    if (key === 'user-agent') { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue; }
    lastWasAgent = false;
    if ((key === 'allow' || key === 'disallow') && cur && val) cur.rules.push({ allow: key === 'allow', pattern: val });   // an empty Disallow means "allow all" and adds no rule
  }
  return groups;
}
function matches(pattern: string, path: string): number {
  const anchored = pattern.endsWith('$'), core = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp('^' + core.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path) ? core.replace(/\*/g, '').length : -1;
}
export function allowedByRobots(groups: Group[], product: string, pathAndQuery: string): boolean {
  const p = product.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && p.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  let best = -1, verdict = true;
  for (const g of chosen) for (const r of g.rules) { const m = matches(r.pattern, pathAndQuery); if (m > best || (m === best && m >= 0 && r.allow)) { if (m >= 0) { best = m; verdict = r.allow; } } }
  return verdict;
}
