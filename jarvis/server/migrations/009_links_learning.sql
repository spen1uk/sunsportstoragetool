-- Quick links (just bookmarks Luke opens himself) and weekly learning goals he logs himself.
CREATE TABLE links (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE learning_goals (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'sessions', per_week INTEGER NOT NULL DEFAULT 3, created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE learning_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL REFERENCES learning_goals(id), day TEXT NOT NULL, amount INTEGER NOT NULL);
CREATE INDEX idx_learning_goal_day ON learning_logs(goal_id, day);
