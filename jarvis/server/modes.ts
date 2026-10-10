import { type DB, getMeta, setMeta } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';
import type { Mode } from './contact.ts';

export const MODES: Mode[] = ['normal', 'personal', 'family', 'meal', 'church', 'unavailable', 'away'];

/** Current contact mode. A timed mode (e.g. church until 12:30) expires on its own; "away" lasts until "I'm back". */
export function getMode(db: DB, now = Date.now()): { mode: Mode; since: number | null; until: number | null } {
  const mode = (getMeta(db, 'mode') ?? 'normal') as Mode;
  const until = Number(getMeta(db, 'mode_until') || 0) || null;
  if (mode !== 'normal' && until && until <= now) { setMode(db, 'normal', null, 'system'); return { mode: 'normal', since: now, until: null }; }
  return { mode, since: Number(getMeta(db, 'mode_since') || 0) || null, until };
}
export function setMode(db: DB, mode: Mode, until: number | null, actor = 'luke') {
  if (!MODES.includes(mode)) throw new Error('unknown mode');
  setMeta(db, 'mode', mode); setMeta(db, 'mode_since', String(Date.now())); setMeta(db, 'mode_until', until ? String(until) : '');
  audit(db, actor, 'mode.set', mode, { until });
  publish({ type: 'mode', mode });
}
