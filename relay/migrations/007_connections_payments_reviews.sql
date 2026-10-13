-- Phase 5: connections framework, generic webhooks, payments, reviews.
CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  provider text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','needs_reauth','error','disconnected','revoked')),
  auth_type text NOT NULL CHECK (auth_type IN ('api_key','oauth2')),
  scopes text[] NOT NULL DEFAULT '{}',
  read_enabled boolean NOT NULL DEFAULT true,
  write_enabled boolean NOT NULL DEFAULT false,         -- read and write are separate permissions; writes are OFF until an admin enables them
  credentials_enc text,                                  -- AES-256-GCM envelope; never returned by the API, never logged
  key_version int,
  credentials_meta jsonb NOT NULL DEFAULT '{}',          -- non-secret: account label, token expiry
  last_success_sync_at timestamptz,
  last_error text, last_error_at timestamptz, error_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE (workspace_id, provider)
);
CREATE TABLE external_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections ON DELETE CASCADE,
  entity_type text NOT NULL, local_id uuid NOT NULL, external_id text NOT NULL,
  content_hash text, last_origin text NOT NULL DEFAULT 'external' CHECK (last_origin IN ('external','local')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity_type, external_id), UNIQUE (connection_id, entity_type, local_id)
);
CREATE TABLE sync_state (
  connection_id uuid NOT NULL REFERENCES connections ON DELETE CASCADE, resource text NOT NULL,
  cursor text, last_success_at timestamptz, last_error text, next_attempt_at timestamptz,
  PRIMARY KEY (connection_id, resource)
);
CREATE TABLE sync_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES connections ON DELETE CASCADE, resource text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  fetched int NOT NULL DEFAULT 0, created int NOT NULL DEFAULT 0, updated int NOT NULL DEFAULT 0, skipped int NOT NULL DEFAULT 0, error text
);

-- Generic webhooks (outbound subscriptions, inbound lead endpoints)
CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  url text NOT NULL, secret_enc text NOT NULL, key_version int NOT NULL,
  events text[] NOT NULL, include_content boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, disabled_reason text,
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions ON DELETE CASCADE,
  event_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dead')),
  attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status int, last_error text, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, event_id)
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending','failed');
CREATE TABLE inbound_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  name text NOT NULL, secret_enc text NOT NULL, key_version int NOT NULL,
  default_tags text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inbound_events (
  endpoint_id uuid NOT NULL REFERENCES inbound_endpoints ON DELETE CASCADE, event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (endpoint_id, event_id)
);

-- Payments. Status is DERIVED from verified events only; success URLs prove nothing.
CREATE TABLE payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts, conversation_id uuid REFERENCES conversations,
  created_by uuid NOT NULL REFERENCES users,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0), currency text NOT NULL DEFAULT 'usd',
  description text NOT NULL, reference text,                 -- staff/invoice reference (free text)
  connection_id uuid REFERENCES connections, provider text, provider_ref text, pay_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','partially_paid','paid','failed','expired','cancelled','partially_refunded','refunded')),
  status_detail text,
  paid_cents bigint NOT NULL DEFAULT 0, refunded_cents bigint NOT NULL DEFAULT 0,
  expires_at timestamptz, receipt_url text,
  accounting_ref text, accounting_note text,                 -- Relay never writes accounting balances
  cancelled_locally boolean NOT NULL DEFAULT false,
  snap_paid_cents bigint NOT NULL DEFAULT 0, snap_refunded_cents bigint NOT NULL DEFAULT 0, snap_expired boolean NOT NULL DEFAULT false, snap_at timestamptz,   -- latest authenticated provider TOTALS (reconciliation)
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)
);
CREATE INDEX payment_requests_ws ON payment_requests (workspace_id, created_at DESC);
CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id uuid NOT NULL REFERENCES payment_requests ON DELETE CASCADE,
  provider text NOT NULL, provider_event_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('succeeded','failed','refunded','expired','cancelled')),
  amount_cents bigint, terminal boolean NOT NULL DEFAULT false, receipt_url text,
  source text NOT NULL CHECK (source IN ('signed_webhook','provider_api')),   -- how it was verified
  occurred_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(), raw jsonb,
  UNIQUE (provider, provider_event_id)
);

-- Reviews
CREATE TABLE reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  connection_id uuid REFERENCES connections ON DELETE SET NULL,
  source text NOT NULL, external_id text NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  author_name text, body text, reviewed_at timestamptz NOT NULL,
  reply_text text, replied_at timestamptz, reply_origin text CHECK (reply_origin IN ('external','relay')),
  imported_manually boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, source, external_id)
);
CREATE INDEX reviews_ws ON reviews (workspace_id, reviewed_at DESC);
CREATE TABLE review_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES reviews ON DELETE CASCADE,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','posting','posted','failed','unknown','rejected')),
  draft_method text NOT NULL,                              -- 'staff' | 'rules-v1 (no AI)'
  drafted_by uuid REFERENCES users, approved_by uuid REFERENCES users, approved_at timestamptz,
  approved_body_hash text,                                 -- approval is bound to the exact text
  posted_at timestamptz, error text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE broadcasts ADD COLUMN kind text NOT NULL DEFAULT 'broadcast' CHECK (kind IN ('broadcast','review_request'));
CREATE TABLE review_request_log (
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE, broadcast_id uuid NOT NULL REFERENCES broadcasts ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (contact_id, broadcast_id)
);
