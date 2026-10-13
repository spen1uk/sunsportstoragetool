-- Phase 2: templates, scheduled sends, media/MMS, notifications, workspace settings.
CREATE TABLE workspace_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  updated_by uuid REFERENCES users,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  category text NOT NULL,
  name text NOT NULL,
  department_id uuid REFERENCES departments,       -- NULL = usable by everyone
  current_version int NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE TABLE template_versions (
  template_id uuid NOT NULL REFERENCES templates ON DELETE CASCADE,
  version int NOT NULL,
  body text NOT NULL,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);
CREATE TABLE template_favorites (
  template_id uuid NOT NULL REFERENCES templates ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (template_id, user_id)
);

-- Scheduled sends keep the creator's wall-clock intent + timezone, plus an auditable history.
CREATE TABLE scheduled_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users,
  body text NOT NULL,
  media_ids uuid[] NOT NULL DEFAULT '{}',
  timezone text NOT NULL,
  local_time text NOT NULL,                  -- 'YYYY-MM-DDTHH:mm' as the creator entered it
  run_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled','suppressed','needs_review','failed')),
  status_detail text,
  message_id uuid REFERENCES messages,
  prev_responsibility text
);
CREATE INDEX scheduled_pending ON scheduled_sends (run_at) WHERE status='pending';
CREATE TABLE scheduled_send_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scheduled_send_id uuid NOT NULL REFERENCES scheduled_sends ON DELETE CASCADE,
  event text NOT NULL, detail text, actor_user_id uuid, at timestamptz NOT NULL DEFAULT now()
);

-- Media library. Files live in private storage (never public URLs); access via short-lived signed links.
CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  uploader_user_id uuid REFERENCES users,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  origin text NOT NULL DEFAULT 'library' CHECK (origin IN ('library','inbound_mms','voice','chat')),
  scan_status text NOT NULL DEFAULT 'unscanned' CHECK (scan_status IN ('unscanned','clean','quarantined')),
  department_id uuid REFERENCES departments,
  contact_id uuid REFERENCES contacts ON DELETE SET NULL,
  is_favorite boolean NOT NULL DEFAULT false,
  expires_at timestamptz,                    -- retention (voice recordings etc.)
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', filename || ' ' || category)) STORED
);
CREATE INDEX media_ws ON media_assets (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX media_search ON media_assets USING gin (search);
CREATE TABLE message_attachments (
  message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets,
  PRIMARY KEY (message_id, media_id)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  type text NOT NULL,                        -- inbound_message, assignment, mention, task_assigned, scheduled_review, ...
  title text NOT NULL,
  conversation_id uuid REFERENCES conversations ON DELETE CASCADE,
  ref_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- Soft-redaction so summaries can notice edited/deleted history.
ALTER TABLE messages ADD COLUMN redacted_at timestamptz;
