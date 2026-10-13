-- My Life: habits Luke checks off himself, and people he wants to stay in touch with. Typed in by Luke; nothing is inferred or imported.
CREATE TABLE habits (id TEXT PRIMARY KEY, name TEXT NOT NULL, per_week INTEGER NOT NULL DEFAULT 7, created_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
CREATE TABLE habit_logs (habit_id TEXT NOT NULL REFERENCES habits(id), day TEXT NOT NULL, PRIMARY KEY (habit_id, day));
CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, relationship TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', every_days INTEGER, last_contact_ms INTEGER, created_at TEXT NOT NULL);
