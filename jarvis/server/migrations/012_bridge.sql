-- Credential for the small helper that runs on Luke's Mac and pushes a read-only copy of Calendar/Notes to a server. Only the hash is kept.
CREATE TABLE bridge_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER);
