-- Migration 005: multi-client progress metadata + provider response cache.
-- EXPAND phase (data-model.md migration plan): strictly additive — no column
-- is rewritten, removed, or renamed; pre-005 binaries ignore the new columns
-- and keep working against the migrated schema (rollback story: none needed;
-- destructive cleanup requires its own removal gate in a later milestone).

-- Server-commit-order last-write-wins metadata for watch progress
-- (spec Clarification 3, FR-006). progress_revision is server-assigned and
-- monotonically increasing per row on every successful commit; backfill
-- marks pre-existing rows as revision 1.
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS progress_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS writer_client_id TEXT;
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS stream_session_id TEXT;
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS last_seq BIGINT NOT NULL DEFAULT 0;

-- writer_client_id is last-writer metadata only, never an ownership key
-- (FR-006): the household subject key stays (subject_id, series_id, season,
-- episode). Index supports diagnostics by writer/session.
CREATE INDEX IF NOT EXISTS idx_watch_progress_writer
  ON watch_progress (writer_client_id)
  WHERE writer_client_id IS NOT NULL;

-- Bounded TTL cache of catalog provider responses backing graceful
-- degradation (data-model.md ProviderCache). Entries are served
-- stale-but-valid while a provider is down and evicted only under the
-- application's in-memory bound; this table is written by the catalog
-- service from the persistent-cache milestone onward and is unused by
-- pre-005 binaries.
CREATE TABLE IF NOT EXISTS catalog_cache (
  cache_key  TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status     TEXT NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh', 'stale'))
);

CREATE INDEX IF NOT EXISTS idx_catalog_cache_expires
  ON catalog_cache (expires_at);
