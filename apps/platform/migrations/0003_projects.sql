-- A project belongs to one owner (a user) and is addressed as `owner/project` by handles. Its id is
-- opaque and names its repos (`<id>-main`), so renaming a handle never moves a repo.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  handle TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (owner_id, handle)
);
