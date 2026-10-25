-- Upgrade stage 3: research follow-through, plans, and the feedback signal
CREATE TABLE open_questions (
  id TEXT PRIMARY KEY, question TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'luke', task_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dropped')), note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, next_check_at INTEGER, last_checked_at INTEGER
);
CREATE INDEX open_questions_status ON open_questions(status, next_check_at);
CREATE TABLE plans (id TEXT PRIMARY KEY, request TEXT NOT NULL, plan TEXT NOT NULL, tasks_added INTEGER NOT NULL DEFAULT 0, cost_micro INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, rating TEXT NOT NULL CHECK (rating IN ('up','down')), note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX feedback_msg ON feedback(message_id);
