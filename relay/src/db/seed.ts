import { pool } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../domain/auth.js';

/** SYNTHETIC DEMO DATA ONLY. Numbers/names are fictional; the SMS channel is the in-process simulator. */
export async function seed(opts: { password?: string } = {}) {
  await migrate();
  const pw = await hashPassword(opts.password ?? 'relay-demo-password');
  const ws = (await pool.query(`INSERT INTO workspaces (name) VALUES ('Relay — Sun Sport Marine') RETURNING id`)).rows[0].id as string;
  const deps: Record<string, string> = {};
  for (const [key, name, restricted] of [['sales', 'Sales', false], ['service', 'Service', false], ['financing', 'Financing', true], ['storage', 'Storage', false], ['brokerage', 'Brokerage', false]] as const)
    deps[key] = (await pool.query(`INSERT INTO departments (workspace_id,key,name,restricted) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, key, name, restricted])).rows[0].id;
  const users: Record<string, string> = {};
  for (const [key, email, name, role, ds] of [
    ['owner', 'owner@demo.relay.test', 'Demo Owner', 'owner', []],
    ['sam', 'sam@demo.relay.test', 'Sam Sales', 'staff', ['sales']],
    ['sue', 'sue@demo.relay.test', 'Sue Service', 'staff', ['service']],
    ['fin', 'fin@demo.relay.test', 'Fran Financing', 'manager', ['financing', 'sales']],
  ] as const) {
    const u = (await pool.query(`INSERT INTO users (email,name,password_hash) VALUES ($1,$2,$3) RETURNING id`, [email, name, pw])).rows[0].id;
    const m = (await pool.query(`INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3) RETURNING id`, [ws, u, role])).rows[0].id;
    for (const d of ds) await pool.query('INSERT INTO membership_departments VALUES ($1,$2)', [m, deps[d]]);
    users[key] = u;
  }
  // Simulated channel on a clearly fictional number. NOT the business number.
  await pool.query(`INSERT INTO channels (workspace_id,kind,provider,address,is_simulated) VALUES ($1,'sms','simulator','+12625550100',true)`, [ws]);
  // Neutral starter templates: variables only, no prices/services/hours asserted. Managers edit these.
  const starters: [string, string, string][] = [
    ['sales', 'First reply', 'Hi {{first_name}}, this is {{staff_name}} at {{business_name}}. Thanks for reaching out — how can I help?'],
    ['appointment', 'Visit confirmation', 'Hi {{first_name}}, confirming your visit with {{business_name}}. Directions: {{directions_link}}'],
    ['review_request', 'Review request', 'Hi {{first_name}}, thanks for working with {{business_name}}. If you have a moment, we would value your feedback: {{review_link}}'],
    ['general', 'Business hours', 'Our hours are: {{business_hours}}'],
  ];
  for (const [category, name, body] of starters) {
    const t = (await pool.query(`INSERT INTO templates (workspace_id, category, name, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [ws, category, name, users.owner])).rows[0].id;
    await pool.query(`INSERT INTO template_versions (template_id, version, body, created_by) VALUES ($1,1,$2,$3)`, [t, body, users.owner]);
  }
  return { workspaceId: ws, departments: deps, users };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  seed().then((r) => { console.log('seeded demo workspace', r.workspaceId, '— logins: owner@/sam@/sue@/fin@demo.relay.test / relay-demo-password'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
