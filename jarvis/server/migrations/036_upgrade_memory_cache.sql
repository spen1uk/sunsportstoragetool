-- Upgrade, stages 1 and 2: cache accounting, memory life cycle, review queue, rolling conversation summary
ALTER TABLE llm_usage ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;

-- Every memory so far was saved by Luke's own words or by a suggestion he accepted, so they start as "stated".
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'stated' CHECK (status IN ('stated','confirmed','preference','unverified','historical','disproven'));
ALTER TABLE memories ADD COLUMN last_confirmed_at TEXT;

-- Things only Luke can settle: a new memory that may contradict an earlier one.
CREATE TABLE memory_reviews (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('conflict')), new_id TEXT NOT NULL, existing_id TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','replaced','kept_both','dropped')), created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX memory_reviews_open ON memory_reviews(status);

-- One row: a short summary of the older part of the conversation, and what we were in the middle of.
CREATE TABLE conversation_summary (id INTEGER PRIMARY KEY CHECK (id = 1), summary TEXT NOT NULL DEFAULT '', open_thread TEXT NOT NULL DEFAULT '', upto_message_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
