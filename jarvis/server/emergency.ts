import { disableAll as disableAllTriggers } from './triggers.ts';
import { type DB } from './db.ts';
import { audit } from './audit.ts';
import { setPaused, isPaused } from './pause.ts';
import { revokeToken } from './bridge.ts';
import { getConfig as webConfig, setConfig as setWeb } from './websearch.ts';
import { publish } from './events.ts';
import { teardownAll } from './tempagents.ts';

/**
 * "Stop everything": one action that halts new work and removes every outside way in, without touching your data or your own sign-in
 * (so you can look at what happened). It pauses Jarvis, revokes every device key, the Mac-helper credential and every standing
 * permission, switches web search off, and cancels any pending step-up confirmation. Coming back is deliberate: Resume Jarvis, then
 * re-create whatever you want (devices, helper, permissions) with your passphrase or passkey.
 */
export function emergencyStop(db: DB, now = Date.now()) {
  const wasPaused = isPaused(db); setPaused(db, true);
  const devices = db.prepare('UPDATE devices SET revoked_at=? WHERE revoked_at IS NULL').run(now).changes;
  const standing = db.prepare('UPDATE standing_permissions SET revoked_at=? WHERE revoked_at IS NULL').run(new Date(now).toISOString()).changes;
  const bridge = revokeToken(db, now);
  const wc = webConfig(db); const web = wc.enabled; if (web) setWeb(db, { ...wc, enabled: false });
  db.prepare('UPDATE sessions SET step_up_until=0').run();
  const agents = teardownAll(db, 'stop everything', now);
  const schedules = disableAllTriggers(db, 'Switched off by "Stop everything"', now);
  const missions = Number(db.prepare("UPDATE missions SET status='paused', blockers='Paused by \"Stop everything\"', next_action='Resume when ready', updated_at=? WHERE status IN ('active','blocked')").run(now).changes);
  const running = (db.prepare("SELECT COUNT(*) c FROM tasks WHERE state='running'").get() as { c: number }).c;
  const summary = { schedulesOff: schedules, wasPaused, devicesRevoked: Number(devices), standingRevoked: Number(standing), helperRevoked: !!bridge, webSearchOff: web, jobsStillFinishing: running, tempAgentsTornDown: agents, missionsPaused: missions };
  audit(db, 'luke', 'system.emergency_stop', '', summary); publish({ type: 'system', paused: true });
  return summary;
}
