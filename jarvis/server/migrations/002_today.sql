ALTER TABLE tasks ADD COLUMN minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE tasks ADD COLUMN deadline INTEGER;            -- epoch ms
ALTER TABLE tasks ADD COLUMN tonight INTEGER NOT NULL DEFAULT 0; -- "Do this tonight" override

CREATE TABLE notifications (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,   -- briefing|reminder|recap|approval|review
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'routine' CHECK (urgency IN ('routine','urgent','emergency')),
  due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','acked','skipped')),
  desktop_at INTEGER, text_at INTEGER, text_note TEXT, acked_at INTEGER, snoozed_until INTEGER, note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX notifications_state ON notifications(state, due_at);
