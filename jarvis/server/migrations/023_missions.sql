-- Missions, steps, watches and temporary agents (Master expansion, Phase 4)
CREATE TABLE missions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assigned','watch','scout','followup')),
  status TEXT NOT NULL CHECK (status IN ('proposed','active','paused','blocked','done','stopped','failed')),
  priority INTEGER NOT NULL DEFAULT 3, owner TEXT NOT NULL DEFAULT 'prometheus', origin TEXT NOT NULL DEFAULT 'luke',
  value_hypothesis TEXT NOT NULL DEFAULT '', cap_micro_usd INTEGER NOT NULL, next_action TEXT NOT NULL DEFAULT '', blockers TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '[]', parent_id TEXT, watch_id TEXT, report TEXT, delivered_at INTEGER, stop_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX missions_status ON missions(status);
CREATE TABLE mission_steps (
  id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'deep',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  task_id TEXT, agent_id TEXT, budget_micro_usd INTEGER NOT NULL DEFAULT 0, result_json TEXT, started_at INTEGER, finished_at INTEGER
);
CREATE INDEX mission_steps_mission ON mission_steps(mission_id, idx);
CREATE TABLE watches (id TEXT PRIMARY KEY, topic TEXT NOT NULL, cadence_days INTEGER NOT NULL, tier TEXT NOT NULL DEFAULT 'quick', kind TEXT NOT NULL DEFAULT 'watch', hypothesis TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE temp_agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, charter TEXT NOT NULL, mission_id TEXT NOT NULL, skills TEXT NOT NULL DEFAULT '[]', budget_micro_usd INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','torn_down')), torn_down_at INTEGER, teardown_reason TEXT
);
CREATE TABLE mission_events (id INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX mission_events_m ON mission_events(mission_id, id);
