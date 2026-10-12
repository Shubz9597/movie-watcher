-- Provider id links per catalog title ("tmdb:tv:13916" -> tmdb + imdb ids)
-- with the title's type and format. When TMDb is unreachable, a known IMDb
-- link lets Cinemeta answer for the same TMDb title id.
CREATE TABLE IF NOT EXISTS catalog_id_links (
  canonical_id TEXT PRIMARY KEY,
  provider_ids JSONB NOT NULL,
  title_type TEXT NOT NULL DEFAULT '',
  title_format TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
