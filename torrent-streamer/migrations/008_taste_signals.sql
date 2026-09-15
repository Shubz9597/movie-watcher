-- Taste signals (v2 recommendation engine): "opened title" events. The other
-- taste signals (favourites, Watch Later, watch progress) are DERIVED from
-- the existing library and progress tables at profile-build time and are not
-- written here. Single private household: profiles are household-wide, so
-- subject_id is attribution only (per-device dedup), never a profile key.

CREATE TABLE IF NOT EXISTS taste_events (
  id BIGSERIAL PRIMARY KEY,
  subject_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',          -- movie | series | anime (as known at visit time)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deduped fire-and-forget pings: one row per (subject, title) per cooldown
-- window; a partial unique index plus the insert guard in the handler keep
-- the table bounded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_taste_events_dedup
  ON taste_events (subject_id, canonical_id, created_at);
CREATE INDEX IF NOT EXISTS idx_taste_events_recent
  ON taste_events (canonical_id, created_at DESC);
