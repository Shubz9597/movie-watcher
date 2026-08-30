CREATE TABLE IF NOT EXISTS imdb_ratings (
  tconst TEXT PRIMARY KEY CHECK (tconst ~ '^tt[0-9]+$'),
  rating REAL NOT NULL CHECK (rating >= 0 AND rating <= 10),
  votes BIGINT NOT NULL CHECK (votes >= 0),
  dataset_updated_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dataset_imports (
  dataset TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  row_count BIGINT NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_at TIMESTAMPTZ
);
