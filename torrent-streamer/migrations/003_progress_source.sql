-- A torrent may be evicted from the live streamer after the viewer leaves.
-- Persist enough source identity to re-add that exact torrent on resume.
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS source_uri TEXT NULL;
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS source_name TEXT NULL;
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS source_kind TEXT NULL;
ALTER TABLE watch_progress ADD COLUMN IF NOT EXISTS source_file_index INT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'watch_progress_source_file_index_nonnegative') THEN
    ALTER TABLE watch_progress
      ADD CONSTRAINT watch_progress_source_file_index_nonnegative
      CHECK (source_file_index IS NULL OR source_file_index >= 0);
  END IF;
END $$;
