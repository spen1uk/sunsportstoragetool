CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ceo','manager','employee')),
  parent_id TEXT REFERENCES agents(id),
  status_kind TEXT NOT NULL CHECK (status_kind IN ('demo','planned','connected','stale','disconnected','live')),
  description TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL DEFAULT 'luke',
  status TEXT NOT NULL DEFAULT 'active', scope TEXT NOT NULL DEFAULT 'personal',
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','research','revision')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN
    ('queued','ready','running','waiting_input','waiting_approval','waiting_dependency','verifying','completed','failed','canceled','paused')),
  priority INTEGER NOT NULL DEFAULT 3,
  owner TEXT NOT NULL DEFAULT 'luke',           -- 'luke' or an agent id
  requires TEXT NOT NULL DEFAULT 'cloud' CHECK (requires IN ('cloud','mac')),
  optional_work INTEGER NOT NULL DEFAULT 0,      -- optional work is blocked first when budget is tight
  input TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT, lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  waiting_reason TEXT, last_error TEXT,
  idempotency_key TEXT UNIQUE,
  is_demo INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  completion_evidence TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX tasks_claim ON tasks(state, requires, next_run_at);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
  at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id), project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'report',
  current_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'in_review' CHECK (status IN ('in_review','approved','published','deleted')),
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id), version INTEGER NOT NULL,
  content TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  based_on INTEGER, content_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);
CREATE TABLE review_requests (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  base_version INTEGER NOT NULL, anchor TEXT NOT NULL DEFAULT '', instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', task_id TEXT, created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL CHECK (role IN ('luke','jarvis')),
  content TEXT NOT NULL, at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'fact', content TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal', source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.9,
  created_at TEXT NOT NULL, superseded_by TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY, action_type TEXT NOT NULL, summary TEXT NOT NULL,
  payload TEXT NOT NULL, digest TEXT NOT NULL, risk TEXT NOT NULL CHECK (risk IN ('standard','high')),
  scope TEXT NOT NULL DEFAULT '', limits TEXT NOT NULL DEFAULT '{}',
  requested_by TEXT NOT NULL, task_id TEXT, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired','executed','invalidated','failed')),
  decided_at TEXT, decided_by TEXT, source_channel TEXT, decided_digest TEXT,
  executed_at TEXT, outcome TEXT, created_at TEXT NOT NULL
);
CREATE TABLE standing_permissions (
  id TEXT PRIMARY KEY, category TEXT NOT NULL, recipients TEXT NOT NULL DEFAULT '[]',
  limits TEXT NOT NULL DEFAULT '{}', expires_at INTEGER, revoked_at TEXT, created_at TEXT NOT NULL,
  granted_via_approval TEXT
);

CREATE TABLE allowed_domains (host TEXT PRIMARY KEY, added_at TEXT NOT NULL, via_approval TEXT);

CREATE TABLE connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','connected','stale','disconnected','blocked')),
  scopes TEXT NOT NULL DEFAULT '', last_sync TEXT, note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE budget_ledger (
  id TEXT PRIMARY KEY, period TEXT NOT NULL, -- YYYY-MM (America/Chicago)
  kind TEXT NOT NULL CHECK (kind IN ('fixed','reservation','usage')),
  category TEXT NOT NULL, micro_usd INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','reserved','settled','released')),
  optional_work INTEGER NOT NULL DEFAULT 0, ref TEXT, note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
);

CREATE TABLE layouts (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, step_up_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
