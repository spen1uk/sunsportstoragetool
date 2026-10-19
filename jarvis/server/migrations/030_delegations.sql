-- Delegation loop and agent scorecards
CREATE TABLE delegations (
  id TEXT PRIMARY KEY, request TEXT NOT NULL, objective TEXT NOT NULL, deliverable TEXT NOT NULL, agent_id TEXT NOT NULL, why_agent TEXT NOT NULL,
  deadline_ms INTEGER, cap_micro INTEGER NOT NULL DEFAULT 0, mission_id TEXT, task_id TEXT,
  status TEXT NOT NULL DEFAULT 'working' CHECK (status IN ('working','in_review','returned','accepted','failed','cancelled','blocked')),
  returns INTEGER NOT NULL DEFAULT 0, verdict TEXT NOT NULL DEFAULT '', feedback TEXT NOT NULL DEFAULT '', spent_micro INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE INDEX delegations_status ON delegations(status);
CREATE TABLE delegation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, delegation_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX delegation_events_d ON delegation_events(delegation_id, id);
