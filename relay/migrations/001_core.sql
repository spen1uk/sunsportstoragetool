-- Relay core schema (Phase 1). Every business table carries workspace_id.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Chicago',
  global_automation_pause boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text,
  is_active boolean NOT NULL DEFAULT true,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','admin','manager','staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

-- Departments double as teams. Brokerage etc. are just more rows.
CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  restricted boolean NOT NULL DEFAULT false, -- e.g. Financing: only explicit members (+owner/admin)
  UNIQUE (workspace_id, key)
);
CREATE TABLE membership_departments (
  membership_id uuid NOT NULL REFERENCES memberships ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments ON DELETE CASCADE,
  PRIMARY KEY (membership_id, department_id)
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,           -- sha256 of the opaque token
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  user_agent text
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','manager','staff')),
  department_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Contacts ----------
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  first_name text, last_name text, company text,
  email text,
  preferred_channel text NOT NULL DEFAULT 'sms',
  assigned_user_id uuid REFERENCES users,
  tags text[] NOT NULL DEFAULT '{}',
  -- communication restrictions: distinct states, enforced server-side at send time
  inbound_blocked boolean NOT NULL DEFAULT false,
  outbound_blocked boolean NOT NULL DEFAULT false,
  do_not_text boolean NOT NULL DEFAULT false,
  do_not_email boolean NOT NULL DEFAULT false,
  sms_opted_out boolean NOT NULL DEFAULT false,         -- STOP received
  email_unsubscribed boolean NOT NULL DEFAULT false,
  marketing_status text NOT NULL DEFAULT 'opt_in_not_received'
    CHECK (marketing_status IN ('opt_in','opt_in_not_received','opted_out')),
  merged_into uuid REFERENCES contacts,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(first_name,'')||' '||coalesce(last_name,'')||' '||coalesce(company,'')||' '||coalesce(email,''))
  ) STORED
);
CREATE INDEX contacts_ws_idx ON contacts (workspace_id) WHERE merged_into IS NULL;
CREATE INDEX contacts_search_idx ON contacts USING gin (search);
CREATE INDEX contacts_tags_idx ON contacts USING gin (tags);

-- A phone/email identity. Original value preserved; e164 normalized. Different people may share a number: not auto-merged.
CREATE TABLE contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('phone','email')),
  original_value text NOT NULL,
  normalized text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, normalized, contact_id)
);
CREATE INDEX contact_identities_lookup ON contact_identities (workspace_id, kind, normalized);

CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('sms_stop','sms_start','sms_help','marketing_opt_in','marketing_opt_out',
     'inbound_block','inbound_unblock','outbound_block','outbound_unblock','do_not_text_set','do_not_text_clear',
     'do_not_email_set','do_not_email_clear','email_unsubscribe')),
  scope text NOT NULL DEFAULT 'all',          -- e.g. 'all','marketing','service'
  source text NOT NULL,                       -- 'inbound_keyword','staff','import','web_form',...
  evidence text,                              -- keyword text, form URL, import file id...
  actor_user_id uuid REFERENCES users,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_events_contact ON consent_events (contact_id, occurred_at DESC);

CREATE TABLE customer_boats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('owned','interested','trade_in')),
  year int, make text, model text, hull_id text,
  provenance text NOT NULL DEFAULT 'staff_entered' CHECK (provenance IN ('staff_entered','customer_stated','inferred','imported')),
  confirmed boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Conversations ----------
CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('sms')),
  provider text NOT NULL,                -- 'simulator' | real provider key
  address text NOT NULL,                 -- E.164 of our sending number (test number!)
  is_simulated boolean NOT NULL DEFAULT true,
  is_live_enabled boolean NOT NULL DEFAULT false,   -- must be explicitly enabled by owner
  provider_auto_replies boolean NOT NULL DEFAULT false, -- true if provider answers STOP/HELP itself (avoid duplicate acks)
  UNIQUE (workspace_id, address)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts,
  channel_id uuid NOT NULL REFERENCES channels,
  contact_identity_id uuid REFERENCES contact_identities,
  department_id uuid REFERENCES departments,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  responsibility text NOT NULL DEFAULT 'needs_our_reply'
    CHECK (responsibility IN ('needs_our_reply','waiting_on_customer','waiting_on_staff','scheduled','closed')),
  handling_mode text NOT NULL DEFAULT 'human'
    CHECK (handling_mode IN ('human','sandra','draft_only','paused')),
  assignee_user_id uuid REFERENCES users,
  tags text[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1,     -- fencing token: bumped on inbound, takeover, mode/assignee change
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_preview text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, contact_id, channel_id)
);
CREATE INDEX conversations_list ON conversations (workspace_id, status, last_message_at DESC);
CREATE INDEX conversations_assignee ON conversations (assignee_user_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type text NOT NULL CHECK (sender_type IN ('customer','staff','sandra','automation','system')),
  sender_user_id uuid REFERENCES users,
  purpose text NOT NULL DEFAULT 'conversational' CHECK (purpose IN ('conversational','transactional','marketing','compliance')),
  body text NOT NULL DEFAULT '',
  -- delivery state, kept separate: queued → provider_accepted → delivered | failed | unknown
  status text NOT NULL CHECK (status IN ('received','queued','sending','provider_accepted','delivered','failed','unknown','suppressed')),
  status_detail text,
  provider text, provider_message_id text,
  from_original text, to_original text,
  idempotency_key text,
  fence_revision bigint,                   -- conversation.revision when the send was authorised
  source_ts timestamptz,                   -- provider/original timestamp
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_idem ON messages (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX messages_provider_id ON messages (workspace_id, provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_conv ON messages (conversation_id, seq);

CREATE TABLE message_delivery_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  status text NOT NULL,
  provider_event_id text,
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb
);
CREATE UNIQUE INDEX delivery_events_dedupe ON message_delivery_events (message_id, provider_event_id) WHERE provider_event_id IS NOT NULL;

CREATE TABLE conversation_reads (
  conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

-- Internal customer notes: never delivered to customers; separate table by design.
CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations ON DELETE SET NULL,
  author_user_id uuid REFERENCES users,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations ON DELETE SET NULL,
  type text NOT NULL,                      -- 'assignment','status_change','consent','note','handling_mode',...
  summary text NOT NULL,
  actor_user_id uuid REFERENCES users,
  origin_table text, origin_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX timeline_contact ON timeline_events (contact_id, occurred_at DESC);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid, actor_user_id uuid, actor_type text NOT NULL DEFAULT 'user',
  action text NOT NULL, target_type text, target_id text,
  meta jsonb NOT NULL DEFAULT '{}', ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Durable job queue (Postgres, SKIP LOCKED).
CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_until timestamptz,
  last_error text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');
CREATE INDEX jobs_due ON jobs (run_at) WHERE status = 'pending';

-- Inbound webhook ledger: signature-verified, replay/duplicate-safe.
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  payload jsonb,
  UNIQUE (provider, event_id)
);

