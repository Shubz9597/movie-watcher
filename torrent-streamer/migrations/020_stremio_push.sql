-- Stremio sync both ways (internal/stremiosync push.go): when on, what a
-- profile watches in TorWatch is written to its Stremio library, so
-- Stremio's Continue Watching (a TV) starts where it left off.
-- last_push_at: progress up to this time has been sent.
ALTER TABLE stremio_accounts ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE stremio_accounts ADD COLUMN IF NOT EXISTS last_push_at TIMESTAMPTZ NULL;
ALTER TABLE stremio_accounts ADD COLUMN IF NOT EXISTS pushed INTEGER NOT NULL DEFAULT 0;
