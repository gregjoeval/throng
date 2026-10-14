-- The ids of deleted projects, kept so a new project never draws one. A project's id names its repos,
-- logs and caches; reusing one could reach anything a failed delete left behind.
CREATE TABLE deleted_projects (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
