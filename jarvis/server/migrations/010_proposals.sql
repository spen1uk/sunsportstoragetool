-- Things the chat model PROPOSED. Nothing here runs until Luke clicks Confirm in the dashboard.
CREATE TABLE proposals (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, params TEXT NOT NULL, summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | confirmed | dismissed | expired | failed
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, result TEXT
);
CREATE INDEX idx_proposals_status ON proposals(status, created_at);
