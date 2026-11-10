-- Stremio sync (internal/stremiosync): a profile can link its Stremio
-- account, and what it watches in Stremio (a TV, another phone) joins its
-- Continue Watching. Only Stremio's session key is kept, never the password.
CREATE TABLE IF NOT EXISTS stremio_accounts (
  profile_id   TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  email        TEXT NOT NULL DEFAULT '',
  auth_key     TEXT NOT NULL,
  linked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at TIMESTAMPTZ NULL,
  last_error   TEXT NOT NULL DEFAULT '',
  -- Positions taken from Stremio in total.
  imported     INTEGER NOT NULL DEFAULT 0
);
