-- Phase 3b: full-history summaries (chunked evidence → reconciliation), AI usage, voice drafts.
CREATE TABLE ai_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  provider text NOT NULL, model text NOT NULL, purpose text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(12,6),                       -- NULL = unknown (never invented)
  ref_id text, created_at timestamptz NOT NULL DEFAULT now()
);

-- Per-chunk evidence cache: lets incremental updates re-process only chunks whose content hash changed.
CREATE TABLE summary_chunks (
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  chunk_index int NOT NULL,
  workspace_id uuid NOT NULL,
  first_message_id uuid, last_message_id uuid, msg_count int NOT NULL,
  content_hash text NOT NULL,
  provider text NOT NULL, extractor_version text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, chunk_index)
);

CREATE TABLE summary_state (
  contact_id uuid PRIMARY KEY REFERENCES contacts ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'stale' CHECK (status IN ('complete','partial','stale','failed')),
  last_error text,
  current_version int,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  version int NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','partial')),
  coverage jsonb NOT NULL,                       -- start/end, message count, chunks, channels, last message id
  provider text NOT NULL, model text NOT NULL, extractor_version text NOT NULL,
  visibility text NOT NULL DEFAULT 'staff' CHECK (visibility IN ('staff')),   -- built from customer-visible history only; never includes notes or team chat
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, version)
);
CREATE TABLE summary_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  summary_id uuid NOT NULL REFERENCES conversation_summaries ON DELETE CASCADE,
  field text NOT NULL,
  value text NOT NULL,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current','superseded')),
  origin text NOT NULL DEFAULT 'customer_stated' CHECK (origin IN ('customer_stated','staff_stated','derived')),
  stated_at timestamptz,
  message_ids uuid[] NOT NULL DEFAULT '{}',      -- citations
  conversation_ids uuid[] NOT NULL DEFAULT '{}', -- for permission-scoped retrieval
  superseded_by uuid,
  note text
);
CREATE INDEX summary_facts_summary ON summary_facts (summary_id);

CREATE TABLE voice_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users,
  conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
  audio_media_id uuid REFERENCES media_assets,
  transcript_original text,
  transcript_source text CHECK (transcript_source IN ('browser_speech','server_stt','typed')),
  cleaned_text text, cleanup_provider text,
  final_text text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','discarded')),
  sent_message_id uuid REFERENCES messages,
  created_at timestamptz NOT NULL DEFAULT now()
);
