-- An eventually consistent copy of every project's tasks and attempts, for listings across projects
-- ("my attempts everywhere"). Each project's Durable Object is the source of truth: it publishes its
-- changes here, and nothing reads these rows to decide a write. `version` orders deliveries, so a
-- row is only ever replaced by a newer one and late or repeated deliveries change nothing.
CREATE TABLE projected_tasks (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  version INTEGER NOT NULL,
  PRIMARY KEY (project_id, number)
);

CREATE INDEX projected_tasks_creator_id ON projected_tasks (creator_id);

CREATE TABLE projected_attempts (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  task INTEGER NOT NULL,
  number INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  version INTEGER NOT NULL,
  PRIMARY KEY (project_id, task, number)
);

CREATE INDEX projected_attempts_author_id ON projected_attempts (author_id);
