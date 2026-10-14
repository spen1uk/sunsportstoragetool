-- Passkeys (WebAuthn): only PUBLIC keys are stored; the private key never leaves Luke's device.
CREATE TABLE passkeys (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, transports TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE passkey_challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, session_hash TEXT, created_at INTEGER NOT NULL);
