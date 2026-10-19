import { type DB } from './db.ts';

/** Plain keyword rules (no model, instant, free). The first strongest match wins; nothing matches → no category. Luke can always change it. */
export const CATEGORIES = ['Marina & business', 'Money', 'Health', 'Home', 'Errands', 'Calls & messages', 'Learning', 'Jarvis & tech', 'Planning'] as const;
const RULES: [(typeof CATEGORIES)[number], RegExp][] = [
  ['Marina & business', /\b(marina|boat|dock|slip|storage|customer|invoice|quote|lead|crm|sandra|sun sport|inventory|vendor|supplier|marketing|ad campaign|sales|staff|payroll|business)\b/i],
  ['Money', /\b(tax|taxes|budget|bank|loan|mortgage|insurance|bill|pay|rent|invest|investing|trading|crypto|wallet|retirement|accountant|quickbooks)\b/i],
  ['Health', /\b(gym|workout|doctor|dentist|appointment|therapy|medication|prescription|sleep|diet|nutrition|run|walk|stretch|health|baseline)\b/i],
  ['Home', /\b(house|home|yard|garage|clean|laundry|groceries|grocery|cook|repair|fix the|plumb|furnace|lawn|garden|trash|kitchen)\b/i],
  ['Calls & messages', /\b(call|phone|text|email|e-mail|reply|respond|message|follow up|follow-up|dm)\b/i],
  ['Errands', /\b(pick up|drop off|buy|order|return|mail|post office|store|pharmacy|car wash|oil change|renew)\b/i],
  ['Learning', /\b(learn|study|read|course|practice|lesson|book|tutorial|watch the video)\b/i],
  ['Jarvis & tech', /\b(jarvis|prometheus|code|deploy|server|bug|feature|agent|api|laptop|mac|app|website|software|backup)\b/i],
  ['Planning', /\b(plan|decide|decision|review|strategy|schedule|roadmap|goal|prioriti[sz]e|outline)\b/i],
];
export function categorize(title: string, description = ''): string {
  const t = `${title} ${description}`.slice(0, 600); let best = '', hits = 0;
  for (const [name, re] of RULES) { const m = t.match(new RegExp(re.source, 'gi'))?.length ?? 0; if (m > hits) { best = name; hits = m; } }
  return best;
}
export const backfill = (db: DB) => { let n = 0; for (const t of db.prepare("SELECT id,title,description FROM tasks WHERE category='' AND kind='manual'").all() as { id: string; title: string; description: string }[]) { const c = categorize(t.title, t.description); if (c) { db.prepare('UPDATE tasks SET category=? WHERE id=?').run(c, t.id); n++; } } return n; };
