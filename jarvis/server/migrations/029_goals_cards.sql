-- Task categories, goals (linked to projects and agents), and spaced-repetition learning cards
ALTER TABLE tasks ADD COLUMN category TEXT NOT NULL DEFAULT '';
CREATE TABLE goals (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', horizon TEXT NOT NULL DEFAULT 'long' CHECK (horizon IN ('short','long')), target_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','dropped')), owner_agent TEXT NOT NULL DEFAULT 'jarvis', project_id TEXT,
  notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE cards (
  id TEXT PRIMARY KEY, deck TEXT NOT NULL DEFAULT 'General', front TEXT NOT NULL, back TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'luke',
  due_day TEXT NOT NULL, interval_days REAL NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
  last_day TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX cards_due ON cards(due_day);
CREATE TABLE learning_plans (id TEXT PRIMARY KEY, goal_id TEXT, topic TEXT NOT NULL, plan TEXT NOT NULL, created_at INTEGER NOT NULL);
