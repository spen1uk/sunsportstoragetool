import { openDb } from './db.ts';
import { dbPath } from './config.ts';
import { startWorker } from './worker.ts';
const db = openDb(dbPath());
startWorker(db);
console.log('Jarvis worker running (cloud tasks only; Mac tasks wait for a connected Mac).');
