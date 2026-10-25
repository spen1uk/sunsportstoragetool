-- Stage 6: documents Luke gives Jarvis to read (text only is kept; the original file is never stored)
CREATE TABLE documents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, bytes INTEGER NOT NULL, units INTEGER NOT NULL DEFAULT 0, chars INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','no_text')), note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE document_chunks (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, idx INTEGER NOT NULL, unit INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
  PRIMARY KEY (doc_id, idx)
);
