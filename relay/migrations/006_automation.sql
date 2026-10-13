-- Phase 4: business hours + auto-responses, workflow automations, broadcasts.
ALTER TABLE conversations ADD COLUMN last_takeover_at timestamptz;
ALTER TABLE messages ADD COLUMN auto_kind text CHECK (auto_kind IN ('first_contact','after_hours','holiday','follow_up','workflow','broadcast'));
CREATE INDEX messages_auto ON messages (conversation_id, auto_kind, created_at DESC) WHERE auto_kind IS NOT NULL;

-- Business hours are entered by the business; nothing is assumed. No rows = "not configured".
CREATE TABLE business_hours (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
  closed boolean NOT NULL DEFAULT false,
  open_time time, close_time time,
  PRIMARY KEY (workspace_id, weekday),
  CHECK (closed OR (open_time IS NOT NULL AND close_time IS NOT NULL AND open_time < close_time))
);
CREATE TABLE holidays (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  day date NOT NULL, name text NOT NULL,
  closed boolean NOT NULL DEFAULT true, notice text,
  PRIMARY KEY (workspace_id, day)
);
CREATE TABLE automation_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces ON DELETE CASCADE,
  auto_response_enabled boolean NOT NULL DEFAULT false,
  first_contact_message text, after_hours_message text, holiday_message text,
  cadence_hours int NOT NULL DEFAULT 12 CHECK (cadence_hours >= 1),      -- min gap between after-hours/holiday notices per conversation
  quiet_start_hour int NOT NULL DEFAULT 21 CHECK (quiet_start_hour BETWEEN 0 AND 23),
  quiet_end_hour int NOT NULL DEFAULT 8 CHECK (quiet_end_hour BETWEEN 0 AND 23),
  updated_by uuid REFERENCES users, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  name text NOT NULL, description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused')),
  current_version int NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE TABLE workflow_versions (
  workflow_id uuid NOT NULL REFERENCES workflows ON DELETE CASCADE,
  version int NOT NULL, definition jsonb NOT NULL,
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, version)
);
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflows ON DELETE CASCADE,
  version int NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  trigger_type text NOT NULL, trigger_ref text NOT NULL,          -- idempotency: one run per (workflow, conversation, trigger_ref)
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','completed','stopped','failed')),
  stop_reason text,
  pc int NOT NULL DEFAULT 0,                                      -- program counter into the compiled instruction list
  next_run_at timestamptz,
  baseline_inbound_at timestamptz, baseline_takeover_at timestamptz,   -- a newer inbound/takeover than these stops the run
  staff_wait_reminded_at timestamptz, staff_wait_escalated_at timestamptz, staff_wait_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, conversation_id, trigger_ref)
);
CREATE INDEX workflow_runs_conv ON workflow_runs (conversation_id, status);
CREATE TABLE workflow_run_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES workflow_runs ON DELETE CASCADE,
  step text NOT NULL, outcome text NOT NULL, detail text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  name text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('marketing','transactional')),
  body text NOT NULL, media_ids uuid[] NOT NULL DEFAULT '{}',
  audience jsonb NOT NULL,                       -- { tags: [], matchAll: bool, contactIds: [] }
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','paused','completed','cancelled')),
  scheduled_for timestamptz, timezone text, local_time text,
  batch_size int NOT NULL DEFAULT 25 CHECK (batch_size BETWEEN 1 AND 500),
  interval_seconds int NOT NULL DEFAULT 60 CHECK (interval_seconds BETWEEN 1 AND 86400),
  created_by uuid NOT NULL REFERENCES users, approved_by uuid REFERENCES users, approved_at timestamptz,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL REFERENCES broadcasts ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','suppressed','skipped','failed')),
  reason text, message_id uuid REFERENCES messages,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (broadcast_id, contact_id)
);
CREATE INDEX broadcast_recipients_pending ON broadcast_recipients (broadcast_id, status);
