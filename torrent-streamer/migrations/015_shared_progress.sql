-- One viewer per server: every device reads and writes the same watch
-- progress (subject 'household', watch.HouseholdSubject), so episodes watched
-- on the phone show as watched on the desktop and back. Until now each
-- install wrote under its own random device ID.
--
-- Merge every device's rows into the shared subject. Where two devices have
-- the same episode, the most recently updated row wins (the same
-- last-write-wins rule progress writes follow).

DELETE FROM watch_progress older
USING watch_progress newer
WHERE older.series_id = newer.series_id
  AND older.season = newer.season
  AND older.episode = newer.episode
  AND older.id <> newer.id
  AND (newer.updated_at, newer.id) > (older.updated_at, older.id);

-- Keep each row's own updated_at: it orders Continue Watching.
ALTER TABLE watch_progress DISABLE TRIGGER trg_wp_upd;
UPDATE watch_progress SET subject_id = 'household' WHERE subject_id <> 'household';
ALTER TABLE watch_progress ENABLE TRIGGER trg_wp_upd;

DELETE FROM continue_dismissals older
USING continue_dismissals newer
WHERE older.series_id = newer.series_id
  AND older.season = newer.season
  AND older.episode = newer.episode
  AND older.subject_id <> newer.subject_id
  AND (newer.created_at, newer.subject_id) > (older.created_at, older.subject_id);

UPDATE continue_dismissals SET subject_id = 'household' WHERE subject_id <> 'household';
