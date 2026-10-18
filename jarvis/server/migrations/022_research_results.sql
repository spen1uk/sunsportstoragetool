-- Structured, display-ready results of a research job (the long markdown report stays in the artifact)
CREATE TABLE research_results (task_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
