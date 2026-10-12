-- Read-only copies of Apple Calendar events and Apple Notes, pulled from the Mac Jarvis runs on. Nothing here is ever written back.
CREATE TABLE mac_sources (kind TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, name));
CREATE TABLE calendar_events (
  calendar TEXT NOT NULL, uid TEXT NOT NULL, title TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0, location TEXT NOT NULL DEFAULT '', PRIMARY KEY (calendar, uid, start_ms)
);
CREATE INDEX idx_cal_start ON calendar_events(start_ms);
CREATE TABLE notes_cache (id TEXT PRIMARY KEY, folder TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, modified_ms INTEGER NOT NULL);
CREATE TABLE mac_sync (kind TEXT PRIMARY KEY, last_ok_ms INTEGER, last_try_ms INTEGER, last_error TEXT, count INTEGER NOT NULL DEFAULT 0);
