CREATE TABLE standing_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, standing_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, proposal_id TEXT, channel TEXT
);
CREATE INDEX standing_uses_at ON standing_uses(standing_id, at);
