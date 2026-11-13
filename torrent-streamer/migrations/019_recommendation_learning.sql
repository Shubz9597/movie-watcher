-- Recommendations that learn (internal/recommendations): what each profile
-- was shown and what came of it, titles it said no to, title embeddings
-- (what a title is about, from a local model) and each profile's learned
-- ranking weights.

-- One row per recommended title per profile, updated each time the card is
-- seen on screen (a new "view" at most every 6 hours). features: the
-- ranking inputs when it was last shown, for training.
CREATE TABLE IF NOT EXISTS rec_impressions (
  profile_id     TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  canonical_id   TEXT NOT NULL,
  first_shown_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_shown_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  views          INTEGER NOT NULL DEFAULT 1,
  best_position  INTEGER NOT NULL DEFAULT 0,
  features       JSONB NULL,
  PRIMARY KEY (profile_id, canonical_id)
);
CREATE INDEX IF NOT EXISTS idx_rec_impressions_recent ON rec_impressions (profile_id, last_shown_at DESC);

-- "Not interested": never recommended again (until undone), and titles like
-- it count against.
CREATE TABLE IF NOT EXISTS rec_feedback (
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  canonical_id TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'not_interested',
  title        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, canonical_id)
);

-- Shared by every profile: a title's embedding for one model and text.
CREATE TABLE IF NOT EXISTS title_embeddings (
  canonical_id TEXT NOT NULL,
  model        TEXT NOT NULL,
  text_hash    TEXT NOT NULL,
  vector       BYTEA NOT NULL, -- float32, little-endian
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (canonical_id, model)
);

CREATE TABLE IF NOT EXISTS rec_models (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  weights    JSONB NOT NULL,
  samples    INTEGER NOT NULL,
  positives  INTEGER NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
