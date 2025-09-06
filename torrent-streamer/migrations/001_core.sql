-- helper: updated_at
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- series/episodes (supports anime absolute ep)
CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,            -- tv|anime|movie
  external JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_series_upd ON series;
CREATE TRIGGER trg_series_upd BEFORE UPDATE ON series FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE TABLE IF NOT EXISTS episodes (
  id BIGSERIAL PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  season INT NOT NULL,
  episode INT NOT NULL,
  absolute_ep INT NULL,
  name TEXT,
  runtime_s INT NULL,
  air_date DATE NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(series_id, season, episode)
);
DROP TRIGGER IF EXISTS trg_episodes_upd ON episodes;
CREATE TRIGGER trg_episodes_upd BEFORE UPDATE ON episodes FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE INDEX IF NOT EXISTS idx_eps_series_se ON episodes(series_id, season, episode);
CREATE INDEX IF NOT EXISTS idx_eps_series_abs ON episodes(series_id, absolute_ep);

-- devices (profile caps for scoring)
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  capabilities JSONB NOT NULL DEFAULT '{}',
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS trg_devices_upd ON devices;
CREATE TRIGGER trg_devices_upd BEFORE UPDATE ON devices FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- picks: canonical decision for S/E + profile
CREATE TABLE IF NOT EXISTS picks (
  id BIGSERIAL PRIMARY KEY,
  series_id TEXT NOT NULL,
  season INT NOT NULL,
  episode INT NOT NULL,
  profile_hash TEXT NOT NULL,
  infohash TEXT NOT NULL,
  magnet TEXT NOT NULL,
  release_group TEXT NULL,
  resolution TEXT NOT NULL,
  codec TEXT NOT NULL,
  file_index INT NULL,
  source_kind TEXT NOT NULL,     -- single|season_pack
  size_bytes BIGINT NULL,
  score JSONB NOT NULL DEFAULT '{}',
  picked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaces_pick_id BIGINT NULL REFERENCES picks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (series_id, season, episode, profile_hash)
);
DROP TRIGGER IF EXISTS trg_picks_upd ON picks;
CREATE TRIGGER trg_picks_upd BEFORE UPDATE ON picks FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
CREATE INDEX IF NOT EXISTS idx_picks_series_se_profile ON picks(series_id, season, episode, profile_hash);
CREATE INDEX IF NOT EXISTS idx_picks_picked_at ON picks(picked_at DESC);

-- progress + continue-watching
CREATE TABLE IF NOT EXISTS watch_progress (
  id BIGSERIAL PRIMARY KEY,
  subject_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  season INT NOT NULL,
  episode INT NOT NULL,
  position_s INT NOT NULL,
  duration_s INT NOT NULL,
  percent NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(subject_id, series_id, season, episode)
);
CREATE INDEX IF NOT EXISTS idx_wp_subject_series ON watch_progress(subject_id, series_id);
CREATE INDEX IF NOT EXISTS idx_wp_updated ON watch_progress(updated_at DESC);
DROP TRIGGER IF EXISTS trg_wp_upd ON watch_progress;
CREATE TRIGGER trg_wp_upd BEFORE UPDATE ON watch_progress FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

CREATE TABLE IF NOT EXISTS continue_dismissals (
  subject_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  season INT NOT NULL,
  episode INT NOT NULL,
  reason TEXT NOT NULL,  -- 'completed' | 'manual'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_id, series_id, season, episode)
);
CREATE INDEX IF NOT EXISTS idx_cd_subject ON continue_dismissals(subject_id);

-- persisted search cache
CREATE TABLE IF NOT EXISTS search_cache (
  key TEXT PRIMARY KEY,          -- seriesId|SxxExx|profileHash
  candidates JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
