-- Phase 7: Kenect migration preparation. Staged imports (nothing touches customer data until commit), rollback tracking, cutover checklist.
CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('contacts','messages','consents','templates')),
  source text NOT NULL DEFAULT 'csv',
  filename text NOT NULL,
  file_sha256 text NOT NULL,
  file_key text NOT NULL,                       -- original upload, stored untouched
  file_bytes int NOT NULL,
  headers text[] NOT NULL DEFAULT '{}',
  mapping jsonb,
  options jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','staged','committed','rolled_back')),
  counts jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  staged_at timestamptz, committed_at timestamptz, rolled_back_at timestamptz
);
CREATE INDEX import_batches_ws ON import_batches (workspace_id, created_at DESC);

CREATE TABLE import_rows (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES import_batches ON DELETE CASCADE,
  row_no int NOT NULL,                          -- 1-based data row (header excluded), as in the original file
  raw jsonb NOT NULL,
  parsed jsonb,
  status text NOT NULL CHECK (status IN ('valid','error','duplicate','review','skipped','committed')),
  reason text,
  UNIQUE (batch_id, row_no)
);
CREATE INDEX import_rows_status ON import_rows (batch_id, status);

-- Provenance on everything an import can create (drives rollback and the "imported" labels).
ALTER TABLE contacts ADD COLUMN import_batch_id uuid REFERENCES import_batches ON DELETE SET NULL;
ALTER TABLE contact_identities ADD COLUMN import_batch_id uuid REFERENCES import_batches ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN import_batch_id uuid REFERENCES import_batches ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN imported_batch_id uuid REFERENCES import_batches ON DELETE SET NULL;
ALTER TABLE consent_events ADD COLUMN import_batch_id uuid REFERENCES import_batches ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN import_batch_id uuid REFERENCES import_batches ON DELETE SET NULL;
CREATE INDEX messages_imported ON messages (imported_batch_id) WHERE imported_batch_id IS NOT NULL;

CREATE TABLE migration_checklist (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','passed','waived')),
  evidence text,
  updated_by uuid REFERENCES users,
  updated_at timestamptz,
  PRIMARY KEY (workspace_id, key)
);
