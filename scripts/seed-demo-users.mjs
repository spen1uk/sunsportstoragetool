// Creates the 3 demo employee logins via the Supabase Admin API — the
// version-safe way to create auth users with a password, vs. hand-writing
// rows into auth.users/auth.identities (schema that varies by GoTrue
// version). Each createUser call also fires the handle_new_user trigger
// (see migration 20260921190110), which creates the matching `profiles`
// row from the user_metadata passed here.
//
// Usage: node scripts/seed-demo-users.mjs
// Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local

import { createClient } from "@supabase/supabase-js";
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
    // .env.local not found — assume env vars are already set (e.g. CI)
  }
}

loadEnvLocal();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DEMO_PASSWORD = "SunSportDemo2026!";

const demoUsers = [
  { email: "luke@sunsportmarine.demo", full_name: "Luke", role: "admin" },
  { email: "mike@sunsportmarine.demo", full_name: "Mike", role: "manager" },
  { email: "sarah@sunsportmarine.demo", full_name: "Sarah", role: "employee" },
];

for (const user of demoUsers) {
  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: user.full_name, role: user.role },
  });

  if (error) {
    if (error.message?.toLowerCase().includes("already been registered")) {
      console.log(`Skipping ${user.email} — already exists.`);
      continue;
    }
    console.error(`Failed to create ${user.email}:`, error.message);
    continue;
  }

  console.log(`Created ${user.role} login: ${user.email} (id: ${data.user.id})`);
}

console.log(`\nDemo password for all accounts: ${DEMO_PASSWORD}`);
