// Child process of restore-drill: proves the restored database's encrypted credentials decrypt with the SAME key (run with the restored DATABASE_URL).
import { pool } from '../src/db/pool.js';
import { decryptJson } from '../src/integrations/crypto.js';
const [id, expected] = process.argv.slice(2);
const r = await pool.query('SELECT secret_enc FROM webhook_subscriptions WHERE id=$1', [id]);
const got = decryptJson<{ secret: string }>(r.rows[0].secret_enc, `wh:${id}`).secret;
await pool.end();
if (got !== expected) { console.log('MISMATCH'); process.exit(1); }
console.log('DECRYPT_OK');
