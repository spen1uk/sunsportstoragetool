-- Progress is evidence-based: a project's progress is "which milestones are done and what proves it". There is no percentage anywhere.
CREATE TABLE milestones (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, due INTEGER,                 -- due: epoch ms, optional
  depends_on TEXT REFERENCES milestones(id),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','done','canceled')),
  evidence TEXT, completed_at TEXT, completed_by TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX milestones_project ON milestones(project_id, position);
ALTER TABLE tasks ADD COLUMN milestone_id TEXT REFERENCES milestones(id);
CREATE INDEX tasks_milestone ON tasks(milestone_id);
