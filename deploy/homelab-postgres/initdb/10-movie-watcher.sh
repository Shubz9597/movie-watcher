#!/usr/bin/env bash
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=mw_user="$MOVIE_WATCHER_POSTGRES_USER" \
  --set=mw_password="$MOVIE_WATCHER_POSTGRES_PASSWORD" \
  --set=mw_database="$MOVIE_WATCHER_POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'mw_user', :'mw_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'mw_user') \gexec

SELECT format('ALTER ROLE %I WITH LOGIN NOCREATEDB PASSWORD %L', :'mw_user', :'mw_password') \gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'mw_database', :'mw_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'mw_database') \gexec
SQL
