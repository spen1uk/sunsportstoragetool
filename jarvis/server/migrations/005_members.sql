-- Agents inside a dashboard "department": name, what it does, and the status Luke CLAIMED. Display-only until a real connection exists.
ALTER TABLE agents ADD COLUMN members TEXT NOT NULL DEFAULT '[]';
