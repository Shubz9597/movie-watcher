-- Openings and endings found in a show's own files (internal/introdetect).
-- One row per video file: the audio fingerprints of both ends of every audio
-- track, so detection can be re-run from them (a new song learned later, a
-- download's file already removed) without reading the video again.
CREATE TABLE IF NOT EXISTS skip_fingerprints (
  infohash   TEXT NOT NULL,
  file_index INTEGER NOT NULL,
  series_key TEXT NOT NULL,
  season     INTEGER NOT NULL DEFAULT 0,
  episode    INTEGER NOT NULL DEFAULT 0,
  show_kind  TEXT NOT NULL,
  duration_s DOUBLE PRECISION NOT NULL DEFAULT 0,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (infohash, file_index)
);
CREATE INDEX IF NOT EXISTS idx_skip_fingerprints_series ON skip_fingerprints (series_key, season, episode);

-- A show's songs: learned from episodes that share them, or a release's
-- creditless OP/ED files. source is unique per show and kind.
CREATE TABLE IF NOT EXISTS skip_themes (
  id         BIGSERIAL PRIMARY KEY,
  series_key TEXT NOT NULL,
  kind       TEXT NOT NULL,
  source     TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series_key, kind, source)
);
