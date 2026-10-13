-- Facts the model THINKS are worth remembering. Nothing becomes a memory until Luke accepts it.
CREATE TABLE memory_suggestions (id TEXT PRIMARY KEY, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, decided_at INTEGER);
CREATE INDEX idx_memsug_status ON memory_suggestions(status, created_at);
