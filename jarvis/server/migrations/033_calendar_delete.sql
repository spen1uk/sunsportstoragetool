-- Calendar outbox may now also carry approved deletions (the table is rebuilt because SQLite cannot change a CHECK)
CREATE TABLE calendar_outbox_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('create','move','delete')), payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','failed')), error TEXT, attempts INTEGER NOT NULL DEFAULT 0, approval_id TEXT, created_at INTEGER NOT NULL, done_at INTEGER);
INSERT INTO calendar_outbox_new SELECT id,kind,payload,status,error,attempts,approval_id,created_at,done_at FROM calendar_outbox;
DROP TABLE calendar_outbox;
ALTER TABLE calendar_outbox_new RENAME TO calendar_outbox;
