-- Persist retry state for retention cleanup; existing expired packages are
-- deliberately pending so legacy filesystem leftovers are recovered too.
ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS cleanup_completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS download_jobs_pending_cleanup_idx
ON download_jobs(expires_at) WHERE state = 'expired' AND cleanup_completed_at IS NULL;
