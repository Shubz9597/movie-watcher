-- Keep progress values sane and optimize the two resume access patterns.
UPDATE watch_progress
SET position_s = GREATEST(0, LEAST(position_s, CASE WHEN duration_s > 0 THEN duration_s ELSE position_s END)),
    duration_s = GREATEST(0, duration_s),
    percent = CASE
      WHEN duration_s > 0 THEN LEAST(100, GREATEST(0, position_s::numeric / duration_s * 100))
      ELSE 0
    END;

-- Completion is represented by percent >= 95; old completion tombstones can
-- otherwise hide a later replay forever.
DELETE FROM continue_dismissals WHERE reason = 'completed';

CREATE INDEX IF NOT EXISTS idx_wp_subject_updated
  ON watch_progress(subject_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_wp_subject_series_updated
  ON watch_progress(subject_id, series_id, updated_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watch_progress_position_nonnegative') THEN
    ALTER TABLE watch_progress
      ADD CONSTRAINT watch_progress_position_nonnegative CHECK (position_s >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watch_progress_duration_nonnegative') THEN
    ALTER TABLE watch_progress
      ADD CONSTRAINT watch_progress_duration_nonnegative CHECK (duration_s >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watch_progress_percent_range') THEN
    ALTER TABLE watch_progress
      ADD CONSTRAINT watch_progress_percent_range CHECK (percent >= 0 AND percent <= 100);
  END IF;
END $$;
