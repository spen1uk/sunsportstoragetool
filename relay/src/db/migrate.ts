import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function migrate(): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query('BEGIN');
      try {
        await c.query(readFileSync(path.join(dir, f), 'utf8'));
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
  return applied;
}

if (process.argv[1]?.endsWith('migrate.ts')) {
  migrate().then((a) => { console.log('applied:', a.length ? a.join(', ') : '(none)'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
