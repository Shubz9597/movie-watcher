-- Each show's last Stremio (Cinemeta) layout: its seasons and episodes, so a
-- show keeps the same seasons while Cinemeta is unreachable
-- (internal/catalog/layout.go).
CREATE TABLE IF NOT EXISTS catalog_layouts (
  imdb_id    TEXT PRIMARY KEY,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
