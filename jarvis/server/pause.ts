import { type DB, getMeta, setMeta, now } from './db.ts';
import { audit } from './audit.ts';
import { publish } from './events.ts';

export const isPaused = (db: DB) => getMeta(db, 'paused') === '1';

/** Pause: stop dispatch of new automated work and revoke queued execution (workers check this before every claim and every tool call). */
export function setPaused(db: DB, paused: boolean) {
  setMeta(db, 'paused', paused ? '1' : '0');
  setMeta(db, 'paused_at', paused ? now() : '');
  if (paused) {
    // In-flight work cannot be force-stopped; report it honestly.
    const inflight = db.prepare("SELECT COUNT(*) c FROM tasks WHERE state='running'").get() as { c: number };
    audit(db, 'luke', 'system.pause', '', { inflight: inflight.c });
  } else {
    audit(db, 'luke', 'system.resume');
  }
  publish({ type: 'system', paused });
}
export function pauseStatus(db: DB) {
  const inflight = (db.prepare("SELECT COUNT(*) c FROM tasks WHERE state='running'").get() as { c: number }).c;
  return { paused: isPaused(db), since: getMeta(db, 'paused_at') || null, inflight };
}
