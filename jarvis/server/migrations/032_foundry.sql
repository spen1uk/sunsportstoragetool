-- Agent Foundry: proposals for new agents, the agents it registers, and its working log
ALTER TABLE watches ADD COLUMN agent_name TEXT;
ALTER TABLE watches ADD COLUMN report_format TEXT;
CREATE TABLE foundry_proposals (
  id TEXT PRIMARY KEY, need TEXT NOT NULL, galaxy_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'building' CHECK (status IN ('building','ready','blocked','failed','approved','rejected')),
  spec TEXT, plan TEXT, tests TEXT, audit TEXT, report TEXT, error TEXT, replaces_agent_id TEXT,
  cost_micro INTEGER NOT NULL DEFAULT 0, cap_micro INTEGER NOT NULL, created_by TEXT NOT NULL DEFAULT 'luke', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE foundry_agents (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, agent_row_id TEXT NOT NULL, name TEXT NOT NULL, galaxy_id TEXT NOT NULL, charter TEXT NOT NULL, spec TEXT NOT NULL, watch_id TEXT,
  version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','retired')), monthly_cap_micro INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE foundry_events (id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX foundry_events_p ON foundry_events(proposal_id, id);
