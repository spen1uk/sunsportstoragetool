-- Research source catalog, evidence store and checkpoints (Master expansion, Phase 2)
CREATE TABLE sources (
  host TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', class TEXT NOT NULL DEFAULT 'unknown'
    CHECK (class IN ('official','primary','reference','news','vendor','community','academic','unknown')),
  reliability INTEGER CHECK (reliability IS NULL OR (reliability >= 0 AND reliability <= 100)),
  status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','trusted','watch','blocked')),
  terms_note TEXT NOT NULL DEFAULT '', topics TEXT NOT NULL DEFAULT '[]', cadence_days INTEGER,
  last_checked INTEGER, added_by TEXT NOT NULL DEFAULT 'luke', times_cited INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, sub_question TEXT NOT NULL DEFAULT '', claim TEXT NOT NULL,
  source_url TEXT NOT NULL, source_host TEXT NOT NULL, source_title TEXT NOT NULL DEFAULT '', cited_text TEXT NOT NULL DEFAULT '',
  page_age TEXT, retrieved_at INTEGER NOT NULL, sha256 TEXT NOT NULL
);
CREATE INDEX evidence_task ON evidence(task_id);
CREATE UNIQUE INDEX evidence_unique ON evidence(task_id, sha256);
CREATE TABLE research_runs (task_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- Prometheus is the research agent: the existing research worker node takes its name (status stays honest).
UPDATE agents SET name='Prometheus', description='Research agent. Deep research with web search, cited evidence, cross-checking and a source catalog (built). Proactive self-started research and long projects come in a later phase.' WHERE id='proj-research';
