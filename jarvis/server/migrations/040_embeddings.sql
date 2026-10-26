-- Stage 6b: meaning-based search. Vectors made by a model running on this Mac (Ollama); nothing is sent anywhere else.
CREATE TABLE embeddings (
  kind TEXT NOT NULL CHECK (kind IN ('memory','chunk')), ref TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);
