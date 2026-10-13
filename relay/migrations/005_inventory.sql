-- Phase 3c: inventory (explicit source of truth + freshness), explicit customer preferences, explainable matches, draft-only outreach.
CREATE TABLE inventory_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  key text NOT NULL, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manual','import','connector')),
  is_source_of_truth boolean NOT NULL DEFAULT true,
  last_success_sync_at timestamptz,               -- last time this source was synced/confirmed current
  stale_after_hours int NOT NULL DEFAULT 24,
  last_error text,
  UNIQUE (workspace_id, key)
);
CREATE TABLE inventory_boats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES inventory_sources ON DELETE CASCADE,
  external_id text NOT NULL,
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('available','pending','hold','sold','unknown')),
  year int, make text, model text, boat_type text,
  length_ft numeric(5,1), price numeric(12,2),
  engine text, capacity int, engine_hours int,
  features text[] NOT NULL DEFAULT '{}',
  listing_url text,
  media_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);
CREATE INDEX inventory_ws ON inventory_boats (workspace_id, status);

-- Only EXPLICIT preferences are used for matching; nothing is inferred from chat text.
CREATE TABLE contact_preferences (
  contact_id uuid PRIMARY KEY REFERENCES contacts ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  budget_min numeric(12,2), budget_max numeric(12,2),
  boat_types text[] NOT NULL DEFAULT '{}',
  length_min numeric(5,1), length_max numeric(5,1),
  features text[] NOT NULL DEFAULT '{}',
  use_case text, trade_notes text,
  provenance text NOT NULL DEFAULT 'staff_entered' CHECK (provenance IN ('customer_stated','staff_entered','inferred')),
  confirmed boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE match_results (
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  boat_id uuid NOT NULL REFERENCES inventory_boats ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('match','excluded')),
  score int NOT NULL,
  explanation jsonb NOT NULL,
  user_status text NOT NULL DEFAULT 'suggested' CHECK (user_status IN ('suggested','dismissed','interested')),
  feedback_reason text,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, boat_id)
);
CREATE TABLE outreach_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users,
  boat_ids uuid[] NOT NULL,
  snapshot jsonb NOT NULL,                        -- price/status the draft was written from
  body text NOT NULL,
  media_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
  sent_message_id uuid REFERENCES messages,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outreach_log (               -- duplicate-outreach tracking
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  boat_id uuid NOT NULL REFERENCES inventory_boats ON DELETE CASCADE,
  message_id uuid REFERENCES messages,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outreach_log_contact ON outreach_log (contact_id, sent_at DESC);
