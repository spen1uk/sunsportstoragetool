import { type DB, now } from './db.ts';

/** Structural roster. Everything not actually connected is labelled `planned`; nothing here claims a live integration. */
export function seedStructure(db: DB) {
  const ag = db.prepare('INSERT OR IGNORE INTO agents(id,name,role,parent_id,status_kind,description,sort) VALUES(?,?,?,?,?,?,?)');
  ag.run('jarvis', 'Jarvis', 'ceo', null, 'live', 'Local command core. Runs the task worker and policy engine on this machine.', 0);
  ag.run('ssm', 'Sun Sport Marine', 'manager', 'jarvis', 'planned', 'Managed by Sandra. Not connected and not yet inspected — nothing shown here is live data.', 1);
  for (const [i, n] of ['Sales', 'Service', 'Parts', 'Marketing'].entries())
    ag.run(`ssm-${n.toLowerCase()}`, n, 'employee', 'ssm', 'planned', `Planned department view. No data source is connected for ${n}.`, i);
  ag.run('proj', 'My Projects', 'manager', 'jarvis', 'live', 'Personal projects and research run directly by Jarvis.', 2);
  ag.run('proj-research', 'Research', 'employee', 'proj', 'live', 'Policy-gated research worker (extractive provider, no language model).', 0);
  ag.run('investing', 'Investing', 'manager', 'jarvis', 'planned', 'Planned. No financial connection exists; no data is shown.', 3);
  ag.run('trading', 'Trading', 'manager', 'jarvis', 'planned', 'Planned. No trading automation is implied or enabled.', 4);
  ag.run('health', 'Health', 'manager', 'jarvis', 'planned', 'Planned. No health data source is connected.', 5);

  const cn = db.prepare('INSERT OR IGNORE INTO connections(id,name,kind,status,scopes,note) VALUES(?,?,?,?,?,?)');
  cn.run('web-research', 'Web research (allow-listed https)', 'research', 'connected', 'fetch: allow-listed hosts only', 'Each new domain requires your approval. SSRF-protected.');
  cn.run('sandra', 'Sandra — Sun Sport Marine manager', 'manager', 'planned', '', 'Not inspected. Phase 3: read-only reports and heartbeat first.');
  cn.run('apple-calendar', 'Apple Calendar', 'calendar', 'planned', '', 'Provider backing (iCloud or other) must be verified first. Phase 2.');
  cn.run('apple-notes', 'Apple Notes', 'notes', 'planned', '', 'No public cloud API assumed; needs a Mac companion/export route. Phase 3.');
  cn.run('sms-voice', 'Dedicated number (SMS / calls)', 'phone', 'planned', '', 'Provider, country registration and pricing not yet verified. Needs your approval to buy.');
  cn.run('voice', 'British streaming voice', 'voice', 'planned', '', 'Phase 2. Animation will follow real audio only.');
  cn.run('model', 'Language model provider', 'model', 'planned', '', 'Not configured. Chat runs in deterministic command mode.');
  cn.run('mac', 'Mac companion', 'device', 'planned', '', 'Phase 3. Local-Mac tasks wait while it is offline.');
  cn.run('finance', 'Financial data feeds', 'finance', 'planned', '', 'None connected. Any future data must show freshness; profit must separate realized/unrealized, fees, period, deposits.');
}

export const DEMO_TAG = 'DEMO';

/** Opt-in sample records, flagged is_demo=1 and removable. They never mix with real records. */
export function seedDemo(db: DB) {
  if (db.prepare("SELECT 1 FROM projects WHERE is_demo=1").get()) return false;
  db.prepare("INSERT INTO projects(id,title,owner,status,scope,is_demo,created_at) VALUES('demo-proj','Sample project (demo)','luke','active','demo',1,?)").run(now());
  const t = db.prepare("INSERT INTO tasks(id,project_id,title,kind,state,priority,owner,is_demo,created_at,updated_at) VALUES(?,?,?,'manual','ready',?,'luke',1,?,?)");
  t.run('demo-t1', 'demo-proj', 'Sample task: review the quarterly layout', 2, now(), now());
  t.run('demo-t2', 'demo-proj', 'Sample task: tidy shared notes', 4, now(), now());
  return true;
}
export function removeDemo(db: DB) {
  db.exec(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE is_demo=1);
           DELETE FROM review_requests WHERE artifact_id IN (SELECT id FROM artifacts WHERE is_demo=1);
           DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE is_demo=1);
           DELETE FROM artifacts WHERE is_demo=1; DELETE FROM tasks WHERE is_demo=1; DELETE FROM projects WHERE is_demo=1;`);
}
