-- Devices (phone app, car, text/voice gateways). Each has its own limited, revocable credential; only a hash is stored.
CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
  profile TEXT NOT NULL DEFAULT 'full', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);
