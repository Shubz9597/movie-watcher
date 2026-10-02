-- 010_download_subtitles.sql — subtitle sidecars for offline downloads
-- (docs/offline-downloads/contracts.md §3). Additive:
--   * subtitle_hints: catalog hints (title/year/imdbId) the preparation
--     worker uses to find a provider subtitle when the torrent has none.
--     Old binaries ignore the column.
--   * failed/subtitles_unavailable joins the closed reason enumeration so
--     clients can offer "Download without subtitles" for exactly that case.
--   * fixes 009's ready_at CHECK, which blocked retention expiry.

ALTER TABLE download_jobs
  ADD COLUMN IF NOT EXISTS subtitle_hints JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 009 declared the (state, reason_code) CHECK inline, so its name is
-- generated; drop it by definition rather than by guessed name.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'download_jobs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%reason_code%'
  LOOP
    EXECUTE format('ALTER TABLE download_jobs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE download_jobs ADD CONSTRAINT download_jobs_state_reason_check CHECK (
  (state = 'preparing' AND reason_code = '') OR
  (state = 'ready' AND reason_code = '') OR
  (state = 'failed' AND reason_code IN ('source_unavailable','insufficient_server_storage','preparation_failed','subtitles_unavailable')) OR
  (state = 'cancelled' AND reason_code IN ('client_cancelled','replaced')) OR
  (state = 'expired' AND reason_code = 'retention_expired')
);

-- 009's "(state = 'ready') = (ready_at IS NOT NULL)" rejected every
-- ready -> expired/cancelled transition (those rows keep ready_at for the
-- retention record), so the retention sweep could never expire a job.
-- Keep the intent: ready requires ready_at, jobs that never became ready
-- have none, and expired jobs were necessarily ready once.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'download_jobs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%ready_at%'
  LOOP
    EXECUTE format('ALTER TABLE download_jobs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE download_jobs ADD CONSTRAINT download_jobs_ready_at_check CHECK (
  (state = 'ready' AND ready_at IS NOT NULL) OR
  (state IN ('preparing','failed') AND ready_at IS NULL) OR
  (state = 'expired' AND ready_at IS NOT NULL) OR
  state = 'cancelled'
);
