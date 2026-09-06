-- Retain each session's sequence independently of the latest progress writer.
-- The parent progress row serializes writes; deleting it also removes its guards.
CREATE TABLE IF NOT EXISTS watch_progress_sessions (
  progress_id BIGINT NOT NULL REFERENCES watch_progress(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  last_seq BIGINT NOT NULL,
  PRIMARY KEY (progress_id, session_id)
);

-- Preserve the sequence guard known by the previous schema on upgrade.
INSERT INTO watch_progress_sessions (progress_id, session_id, last_seq)
SELECT id, stream_session_id, last_seq
FROM watch_progress
WHERE stream_session_id IS NOT NULL AND stream_session_id <> ''
ON CONFLICT (progress_id, session_id) DO NOTHING;
