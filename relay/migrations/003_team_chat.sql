-- Phase 3a: internal team chat + tasks. Entirely separate from conversations/messages: no foreign keys into the SMS tables
-- other than contact/conversation LINKS for context, and no code path from here to the send pipeline.
CREATE TABLE chat_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('department','dm','group','customer')),
  name text,
  department_id uuid REFERENCES departments ON DELETE CASCADE,
  dm_key text,                                   -- 'userA:userB' (sorted) for DMs
  contact_id uuid REFERENCES contacts ON DELETE CASCADE,
  created_by uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='department') = (department_id IS NOT NULL)),
  CHECK ((kind='customer') = (contact_id IS NOT NULL)),
  CHECK ((kind='dm') = (dm_key IS NOT NULL))
);
CREATE UNIQUE INDEX chat_dept_unique ON chat_channels (workspace_id, department_id) WHERE kind='department';
CREATE UNIQUE INDEX chat_dm_unique ON chat_channels (workspace_id, dm_key) WHERE kind='dm';
CREATE UNIQUE INDEX chat_customer_unique ON chat_channels (workspace_id, contact_id) WHERE kind='customer';

CREATE TABLE chat_members (
  channel_id uuid NOT NULL REFERENCES chat_channels ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES chat_channels ON DELETE CASCADE,
  parent_id uuid REFERENCES chat_messages ON DELETE CASCADE,   -- thread root
  author_id uuid NOT NULL REFERENCES users,
  body text NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_channel ON chat_messages (channel_id, seq);
CREATE INDEX chat_messages_parent ON chat_messages (parent_id);
CREATE INDEX chat_messages_search ON chat_messages USING gin (to_tsvector('simple', body));
CREATE TABLE chat_mentions (
  message_id uuid NOT NULL REFERENCES chat_messages ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE chat_attachments (
  message_id uuid NOT NULL REFERENCES chat_messages ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_assets,
  PRIMARY KEY (message_id, media_id)
);
CREATE TABLE chat_reads (
  channel_id uuid NOT NULL REFERENCES chat_channels ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  assignee_user_id uuid NOT NULL REFERENCES users,
  created_by uuid NOT NULL REFERENCES users,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  contact_id uuid REFERENCES contacts ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations ON DELETE SET NULL,
  source_chat_message_id uuid REFERENCES chat_messages ON DELETE SET NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee ON tasks (assignee_user_id, status, due_at);
