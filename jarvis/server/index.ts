import { openDb } from './db.ts';
import { config, dbPath } from './config.ts';
import { createServer } from './http.ts';
import { isConfigured } from './auth.ts';
import { seedStructure } from './seed.ts';
import { startWorker } from './worker.ts';
import { tickNotifications } from './notify.ts';
import { maybeAutoSuggest } from './memsuggest.ts';
import { syncCalendar, sources } from './calendar.ts';
import { syncNotes } from './notes.ts';
import { isMac } from './mac.ts';
import { bus } from './events.ts';

const db = openDb(dbPath());
seedStructure(db);
if (!isConfigured(db)) { console.error('Not set up yet. Run: npm run setup'); process.exit(1); }
if (config.host !== '127.0.0.1' && config.host !== 'localhost') console.warn('WARNING: binding to a non-loopback address. Put TLS and a reverse proxy in front; never expose this port directly.');
createServer(db).listen(config.port, config.host, () => console.log(`Jarvis API on http://${config.host}:${config.port}`));
if (process.env.JARVIS_EMBEDDED_WORKER !== '0') { startWorker(db); console.log('Embedded worker started (set JARVIS_EMBEDDED_WORKER=0 and run `npm run worker` separately to split).'); }

// Local, cheap: a 30-second tick decides what is due. No model calls, no polling of external services.
const tick = () => { try { tickNotifications(db); } catch (e) { console.error('[notify]', (e as Error).message); } void maybeAutoSuggest(db).catch((e) => console.error('[memory]', (e as Error).message)); };
setInterval(tick, 30_000); tick();
// Read-only copy of the chosen Apple Calendar / Notes, refreshed every 15 minutes while Jarvis runs on the Mac (no network, no model calls).
const macSync = async () => { for (const [k, f] of [['calendar', syncCalendar], ['notes', syncNotes]] as const) { if (sources(db, k).some((x) => x.enabled)) await f(db).catch((e) => console.error(`[${k}]`, (e as Error).message)); } };
if (isMac()) { setInterval(macSync, 15 * 60_000); setTimeout(macSync, 5_000); }
// Also react promptly to events that create something needing attention (debounced).
let pending: NodeJS.Timeout | undefined;
bus.on('event', (e: { type: string }) => { if (['approvals', 'artifacts', 'mode', 'tasks'].includes(e.type)) { clearTimeout(pending); pending = setTimeout(tick, 250); } });
