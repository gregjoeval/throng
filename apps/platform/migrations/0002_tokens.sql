-- Throng tokens for machine access (`/api/*`, `/git/*`). Only a SHA-256 hash of the plaintext is
-- kept. A token belongs to a user and, optionally, one of their agent aliases. Expiry is absolute.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  agent TEXT,
  hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX tokens_user_id ON tokens (user_id);
