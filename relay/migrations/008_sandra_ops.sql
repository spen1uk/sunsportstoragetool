-- Phase 6: assistant (Sandra) service API, operational hardening.
-- A service identity is NOT a user: it cannot log in, has no cookie session, and only reaches /api/v1 with a revocable key.

CREATE TABLE service_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'assistant',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  scopes text[] NOT NULL DEFAULT '{}',
  department_ids uuid[] NOT NULL DEFAULT '{}',
  -- read_only: reads only. drafts: + drafts, tags, tasks, handoff, pause (nothing customer-visible). send: + customer-visible sends. Only the OWNER may grant 'send'.
  autonomy text NOT NULL DEFAULT 'read_only' CHECK (autonomy IN ('read_only','drafts','send')),
  rate_limit_per_min int NOT NULL DEFAULT 120,
  webhook_url text,
  webhook_secret_enc text,
  key_version int,
  ack_cursor bigint NOT NULL DEFAULT 0,
  push_attempts int NOT NULL DEFAULT 0,
  push_next_at timestamptz,
  push_last_error text,
  last_used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES service_identities ON DELETE CASCADE,
  prefix text NOT NULL UNIQUE,                 -- public part of the key, used for lookup
  secret_hash text NOT NULL,                   -- sha256(full key); the key itself is shown once and never stored
  label text,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Workspace-wide event log. Visibility is evaluated at READ time per identity (so a department change takes effect immediately). Metadata only, never message text.
CREATE TABLE service_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  type text NOT NULL,
  conversation_id uuid REFERENCES conversations ON DELETE CASCADE,
  contact_id uuid,
  revision bigint,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_events_ws ON service_events (workspace_id, seq);

-- Idempotency ledger for service writes. Executed in the same transaction as the write, so it is all-or-nothing.
CREATE TABLE service_requests (
  identity_id uuid NOT NULL REFERENCES service_identities ON DELETE CASCADE,
  idem_key text NOT NULL,
  request_hash text NOT NULL,
  status_code int NOT NULL,
  response jsonb NOT NULL,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, idem_key)
);

-- Suggestions from the assistant for staff to use or dismiss. Never sent by themselves.
CREATE TABLE assistant_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
  identity_id uuid REFERENCES service_identities ON DELETE SET NULL,
  body text NOT NULL,
  reason text,                                 -- e.g. 'authority:refund' when an attempted send was converted to a draft
  base_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','used','dismissed')),
  decided_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX assistant_drafts_conv ON assistant_drafts (conversation_id, status);

-- Owner-editable authority rules: plain keyword lists (no regex), so non-technical owners can reason about them.
CREATE TABLE assistant_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  topic text NOT NULL,
  keywords text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  built_in boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, topic)
);
ALTER TABLE workspaces ADD COLUMN assistant_rules_seeded boolean NOT NULL DEFAULT false;

ALTER TABLE messages ADD COLUMN service_identity_id uuid REFERENCES service_identities ON DELETE SET NULL;

CREATE TABLE worker_heartbeats (
  id text PRIMARY KEY,
  pid int,
  started_at timestamptz NOT NULL DEFAULT now(),
  beat_at timestamptz NOT NULL DEFAULT now(),
  jobs_done bigint NOT NULL DEFAULT 0,
  version text
);

ALTER TABLE contacts ADD COLUMN erased_at timestamptz;
