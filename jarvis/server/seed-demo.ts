import { openDb } from './db.ts';
import { dbPath } from './config.ts';
import { seedDemo, removeDemo } from './seed.ts';
const db = openDb(dbPath());
if (process.argv.includes('--remove')) { removeDemo(db); console.log('Demo records removed.'); }
else console.log(seedDemo(db) ? 'Demo records added (flagged DEMO).' : 'Demo records already present.');
