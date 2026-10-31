-- Profiles ("Who's watching?"): each viewer on the server has their own watch
-- progress, Continue Watching, watched marks, library and recommendations.
-- A device picks a profile (device_profiles); a device that never picked one
-- uses the first profile, 'household', which keeps everything watched until
-- now (migration 015 made it the one shared subject).
--
-- Progress-like rows are keyed by subject_id = profile id; the library by
-- the profile's household_id (library_household was a single row).

ALTER TABLE library_household DROP CONSTRAINT IF EXISTS library_household_id_check;
CREATE SEQUENCE IF NOT EXISTS library_household_id_seq START WITH 2 OWNED BY library_household.id;
INSERT INTO library_household (id, revision) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS profiles (
  id           text PRIMARY KEY,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color        text NOT NULL DEFAULT '#e50914' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  household_id integer NOT NULL UNIQUE REFERENCES library_household(id),
  -- The Tailscale login that created it ('' when unknown); its creator and
  -- the server's owner may rename or remove it.
  created_by   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_profiles (
  client_id  text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO profiles (id, name, color, household_id, created_by)
VALUES ('household', 'Shubham', '#e50914', 1, 'owner')
ON CONFLICT (id) DO NOTHING;

-- Title visits were kept per device; until now everyone's counted together.
UPDATE taste_events SET subject_id = 'household' WHERE subject_id <> 'household';
