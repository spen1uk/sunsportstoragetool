-- Model router and evaluations (Master expansion, Phase 6)
ALTER TABLE llm_usage ADD COLUMN latency_ms INTEGER;
CREATE TABLE model_routes (task TEXT PRIMARY KEY, candidates TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE provider_approvals (provider TEXT PRIMARY KEY, approved INTEGER NOT NULL, allow_private INTEGER NOT NULL, decided_at INTEGER NOT NULL);
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY, at INTEGER NOT NULL, task TEXT NOT NULL CHECK (task IN ('chat','analysis')), provider TEXT NOT NULL, model TEXT NOT NULL,
  cases INTEGER NOT NULL DEFAULT 0, ran INTEGER NOT NULL DEFAULT 0, avg_score REAL, avg_latency_ms INTEGER, cost_micro INTEGER NOT NULL DEFAULT 0, cap_micro INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','partial','failed')), error TEXT, finished_at INTEGER
);
CREATE INDEX eval_runs_lookup ON eval_runs(task, provider, model, at);
CREATE TABLE eval_results (run_id TEXT NOT NULL, case_id TEXT NOT NULL, score REAL NOT NULL, latency_ms INTEGER, cost_micro INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '', PRIMARY KEY (run_id, case_id));
