-- Stage 4: caps on how far work can be handed from agent to agent
ALTER TABLE delegations ADD COLUMN parent_id TEXT;
ALTER TABLE delegations ADD COLUMN root_id TEXT;
ALTER TABLE delegations ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
CREATE TABLE consults (
  id TEXT PRIMARY KEY, root_id TEXT NOT NULL, parent_id TEXT, depth INTEGER NOT NULL,
  from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX consults_root ON consults(root_id);
