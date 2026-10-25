import { execFileSync } from 'node:child_process';
import { openDb } from './db.ts';
import { sweepStale as sweepBrowser } from './browser.ts';
import { sweepStale as sweepFounderRuns } from './founder.ts';
import { recheckDaily } from './openq.ts';
import { backfill as backfillCategories } from './categorize.ts';
import { sweepStale as sweepEvals } from './evals/run.ts';
import { tick as triggerTick } from './triggers.ts';
import { sync as syncDelegations } from './delegation.ts';
import { sweepStale as sweepFoundry } from './foundry.ts';
import { drain as drainCalendar } from './calendarwrite.ts';
import { daily as improveDaily, monitor as improveMonitor } from './improve/rollout.ts';
import { config, dbPath } from './config.ts';
import { createServer } from './http.ts';
import { isConfigured } from './auth.ts';
import { seedStructure } from './seed.ts';
import { startWorker } from './worker.ts';
import { tickNotifications } from './notify.ts';
import * as missions from './missions.ts';
import { maybeAutoSuggest } from './memsuggest.ts';
import { maybeApplyRetention } from './knowledge.ts';
import { syncCalendar, sources } from './calendar.ts';
import { syncNotes } from './notes.ts';
import { isMac } from './mac.ts';
import { bus } from './events.ts';
import { startHeartbeat } from './heartbeat.ts';

const db = openDb(dbPath());
sweepEvals(db, Date.now() + 600_001);
sweepFoundry(db, Date.now() + 601_000);
sweepBrowser(db); sweepFounderRuns(db);   // an evaluation cannot survive a restart
seedStructure(db);
backfillCategories(db);
if (!isConfigured(db)) { console.error('Not set up yet. Run: npm run setup'); process.exit(1); }
if (config.host !== '127.0.0.1' && config.host !== 'localhost') console.warn('WARNING: binding to a non-loopback address. Put TLS and a reverse proxy in front; never expose this port directly.');
const version = (() => { try { return execFileSync('git', ['log', '-1', '--format=%h %s'], { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 3000 }).trim().slice(0, 90); } catch { return 'unknown'; } })();
createServer(db).listen(config.port, config.host, () => console.log(`Jarvis API on http://${config.host}:${config.port}\nVersion: ${version}`));
if (process.env.JARVIS_EMBEDDED_WORKER !== '0') { startWorker(db); console.log('Embedded worker started (set JARVIS_EMBEDDED_WORKER=0 and run `npm run worker` separately to split).'); }

// Local, cheap: a 30-second tick decides what is due. No model calls, no polling of external services.
const tick = () => { try { db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now()); db.prepare('DELETE FROM passkey_challenges WHERE created_at<?').run(Date.now() - 120_000); tickNotifications(db); maybeApplyRetention(db); improveMonitor(db); } catch (e) { console.error('[notify]', (e as Error).message); } try { recheckDaily(db); } catch (e) { console.error('[openq]', (e as Error).message); } void improveDaily(db).catch((e) => console.error('[improve]', (e as Error).message)); void maybeAutoSuggest(db).catch((e) => console.error('[memory]', (e as Error).message)); };
setInterval(tick, 30_000); tick();
setInterval(() => { if (isMac()) void drainCalendar(db).catch(() => { /* recorded in the outbox */ }); }, 30_000);
setInterval(() => void triggerTick(db).catch((e) => console.error('[triggers]', (e as Error).message)), 30_000);
// Missions: plan, start, watch and finish research missions (cheap, no model call unless a step needs planning or a review).
let missionBusy = false; const missionTick = () => { if (missionBusy) return; missionBusy = true; void missions.tick(db).then(() => syncDelegations(db)).catch((e) => console.error('[missions]', (e as Error).message)).finally(() => { missionBusy = false; }); };
setInterval(missionTick, 30_000); setTimeout(missionTick, 3_000);
// Read-only copy of the chosen Apple Calendar / Notes, refreshed every 15 minutes while Jarvis runs on the Mac (no network, no model calls).
const macSync = async () => { for (const [k, f] of [['calendar', syncCalendar], ['notes', syncNotes]] as const) { if (sources(db, k).some((x) => x.enabled)) await f(db).catch((e) => console.error(`[${k}]`, (e as Error).message)); } };
if (isMac()) { setInterval(macSync, 15 * 60_000); setTimeout(macSync, 5_000); }
startHeartbeat(db);   // optional: only if JARVIS_HEARTBEAT_URL is set
// Also react promptly to events that create something needing attention (debounced).
let pending: NodeJS.Timeout | undefined;
bus.on('event', (e: { type: string }) => { if (['tasks'].includes(e.type)) setTimeout(missionTick, 500); if (['approvals', 'artifacts', 'mode', 'tasks'].includes(e.type)) { clearTimeout(pending); pending = setTimeout(tick, 250); } });
