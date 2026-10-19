-- Workflow triggers and schedules (Skills brief #29)
CREATE TABLE workflow_triggers (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, spec TEXT NOT NULL, notify INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER, cursor_ms INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER, last_ok INTEGER, fail_streak INTEGER NOT NULL DEFAULT 0,
  disabled_reason TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX workflow_triggers_due ON workflow_triggers(enabled, next_run_at);
CREATE TABLE trigger_log (id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '');
CREATE INDEX trigger_log_t ON trigger_log(trigger_id, id);
