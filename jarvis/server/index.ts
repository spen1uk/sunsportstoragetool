import { openDb } from './db.ts';
import { config, dbPath } from './config.ts';
import { createServer } from './http.ts';
import { isConfigured } from './auth.ts';
import { seedStructure } from './seed.ts';
import { startWorker } from './worker.ts';

const db = openDb(dbPath());
seedStructure(db);
if (!isConfigured(db)) { console.error('Not set up yet. Run: npm run setup'); process.exit(1); }
if (config.host !== '127.0.0.1' && config.host !== 'localhost') console.warn('WARNING: binding to a non-loopback address. Put TLS and a reverse proxy in front; never expose this port directly.');
createServer(db).listen(config.port, config.host, () => console.log(`Jarvis API on http://${config.host}:${config.port}`));
if (process.env.JARVIS_EMBEDDED_WORKER !== '0') { startWorker(db); console.log('Embedded worker started (set JARVIS_EMBEDDED_WORKER=0 and run `npm run worker` separately to split).'); }
