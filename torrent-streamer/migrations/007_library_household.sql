-- Household library persistence (feature 002 M3.2, data-model.md).
-- Additive only: new tables + indexes; existing progress/session tables are
-- untouched and old binaries ignore these tables entirely.

-- One row per deployment (alpha: a single private household, FR04). Its
-- monotonically increasing revision serializes every effective membership
-- change; readers take it inside a repeatable-read snapshot.
CREATE TABLE IF NOT EXISTS library_household (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO library_household (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Unique per (household, canonical title). Canonical ids are media-qualified
-- for TMDb (tmdb:movie:N / tmdb:tv:N) — the unqualified tmdb:N alias is never
-- stored. Both flags are independent booleans; a row with both flags false is
-- retained so later refreshes can explain removals. Snapshot columns render
-- an entry whose upstream metadata becomes unavailable.
CREATE TABLE IF NOT EXISTS library_memberships (
  id BIGSERIAL PRIMARY KEY,
  household_id INT NOT NULL REFERENCES library_household(id),
  canonical_id TEXT NOT NULL,
  media_kind TEXT NOT NULL,             -- movie | series | anime
  watch_later BOOLEAN NOT NULL DEFAULT FALSE,
  favourite BOOLEAN NOT NULL DEFAULT FALSE,
  watch_later_added_at TIMESTAMPTZ NULL,
  favourite_added_at TIMESTAMPTZ NULL,
  metadata_available BOOLEAN NOT NULL DEFAULT TRUE,
  snapshot_title TEXT NOT NULL DEFAULT '',
  snapshot_year INT NULL,
  snapshot_poster TEXT NULL,
  sort_key TEXT NOT NULL DEFAULT '',    -- normalized title sort key (server-side)
  mutation_revision BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, canonical_id)
);
DROP TRIGGER IF EXISTS trg_library_memberships_upd ON library_memberships;
CREATE TRIGGER trg_library_memberships_upd BEFORE UPDATE ON library_memberships
FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- Grid reads filter one active collection; recent order is the collection's
-- added timestamp DESC then canonical id ASC, title order is sort_key ASC
-- then canonical id ASC. Partial indexes keep each active collection's scan
-- bounded; kind filtering happens within the collection.
CREATE INDEX IF NOT EXISTS idx_library_wl_recent
  ON library_memberships (household_id, watch_later_added_at DESC, canonical_id) WHERE watch_later;
CREATE INDEX IF NOT EXISTS idx_library_wl_title
  ON library_memberships (household_id, sort_key, canonical_id) WHERE watch_later;
CREATE INDEX IF NOT EXISTS idx_library_fav_recent
  ON library_memberships (household_id, favourite_added_at DESC, canonical_id) WHERE favourite;
CREATE INDEX IF NOT EXISTS idx_library_fav_title
  ON library_memberships (household_id, sort_key, canonical_id) WHERE favourite;
