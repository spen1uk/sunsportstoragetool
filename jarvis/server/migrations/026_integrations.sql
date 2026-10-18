-- Integrations (Master expansion, Phase 8): Claude Code briefs and handed-over ChatGPT chats
CREATE TABLE briefs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '', goal TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
  constraints TEXT NOT NULL DEFAULT '[]', acceptance TEXT NOT NULL DEFAULT '[]', files TEXT NOT NULL DEFAULT '[]', branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','launched','done','dropped')), drafted_by TEXT NOT NULL DEFAULT 'luke',
  result_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, launched_at INTEGER, finished_at INTEGER
);
CREATE TABLE chat_imports (
  id TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT 'chatgpt', title TEXT NOT NULL, source_created_at INTEGER, imported_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL, redacted INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','searchable')), project TEXT NOT NULL DEFAULT '', sha256 TEXT NOT NULL UNIQUE, suggested_at INTEGER
);
CREATE TABLE chat_import_messages (import_id TEXT NOT NULL REFERENCES chat_imports(id) ON DELETE CASCADE, idx INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')), text TEXT NOT NULL, PRIMARY KEY (import_id, idx));
