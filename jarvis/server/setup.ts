import crypto from 'node:crypto';
import { openDb } from './db.ts';
import { dbPath } from './config.ts';
import { isConfigured, setPassphrase } from './auth.ts';
import { seedStructure } from './seed.ts';

const db = openDb(dbPath());
seedStructure(db);
if (isConfigured(db) && !process.argv.includes('--reset-passphrase')) {
  console.log('Already set up. Use --reset-passphrase to issue a new one (existing sessions are invalidated).');
} else {
  // 160 bits, shown once, never stored in plaintext. Treat it like a password.
  const pass = crypto.randomBytes(20).toString('base64url');
  setPassphrase(db, pass);
  db.exec('DELETE FROM sessions');
  console.log('\nJarvis owner passphrase (shown ONCE — store it in your password manager):\n\n  ' + pass + '\n');
}
