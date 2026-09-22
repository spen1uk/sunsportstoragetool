// Runs supabase/seed.sql against the hosted Supabase Postgres database.
// We use `pg` directly instead of `psql` (not installed on this machine)
// and instead of `supabase db reset` (that command wipes the DB and is
// meant for the local Docker stack, not a hosted project).
//
// Usage: node scripts/run-seed-sql.mjs
// Requires SUPABASE_DB_URL in .env.local — the "Connection string" (URI,
// with password filled in) from Supabase Dashboard -> Project Settings ->
// Database -> Connection string.

import { Client } from "pg";
import { readFileSync } from "node:fs";

function loadEnvLocal() {
  try {
    const contents = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env.local not found — assume env vars are already set
  }
}

loadEnvLocal();

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const sql = readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8");

const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query(sql);
  console.log("Seed data applied successfully.");
} catch (err) {
  console.error("Seeding failed:", err.message);
  process.exit(1);
} finally {
  await client.end();
}
