-- Autonomous skill improvement (Master expansion, Phase 9): gaps, candidate improvements, their tests and rollout
CREATE TABLE workflow_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, principal TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT);
CREATE INDEX workflow_runs_w ON workflow_runs(workflow_id, at);
CREATE TABLE gaps (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('failing_skill','failing_workflow','failing_missions','request')), key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '{}', severity INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','addressed')), count INTEGER NOT NULL DEFAULT 1, filed_by TEXT NOT NULL DEFAULT 'system',
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE improvements (
  id TEXT PRIMARY KEY, gap_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('workflow','skill_request')), title TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','passed','failed','staged','active','rolled_back','rejected','brief')),
  report TEXT, workflow_id TEXT, replaces_workflow_id TEXT, brief_id TEXT, cost_micro INTEGER NOT NULL DEFAULT 0, cap_micro INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'luke', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, promoted_at INTEGER
);
CREATE INDEX improvements_gap ON improvements(gap_id);
CREATE TABLE improvement_events (id INTEGER PRIMARY KEY AUTOINCREMENT, improvement_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX improvement_events_i ON improvement_events(improvement_id, id);
