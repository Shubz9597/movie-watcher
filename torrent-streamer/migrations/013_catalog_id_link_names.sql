-- The TMDb display name and year per linked title, so a page answered by
-- Cinemeta while TMDb is down shows exactly TMDb's name and year.
ALTER TABLE catalog_id_links ADD COLUMN IF NOT EXISTS title_name TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_id_links ADD COLUMN IF NOT EXISTS title_year INTEGER NOT NULL DEFAULT 0;
