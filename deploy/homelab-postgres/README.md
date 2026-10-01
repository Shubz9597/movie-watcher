# Shared homelab PostgreSQL

This Compose project runs one PostgreSQL server for multiple homelab
applications. Each application must use a separate login and database.
Application containers connect through the private external Docker network
`homelab-db`; PostgreSQL is exposed on the host only at `127.0.0.1:5432` for
local administration.

The PostgreSQL volume is managed by Docker and normally lives under
`/var/lib/docker` on the system disk. Movie Watcher's large downloads and
media state remain in `TORWATCH_DATA_DIR` on the data disk.

## First start

```bash
cd /srv/movie-watcher/deploy/homelab-postgres
cp .env.example .env
chmod 600 .env
vi .env
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Use long alphanumeric passwords. Movie Watcher's database password must match
`POSTGRES_PASSWORD` in `deploy/torwatch-server/.env`.

The scripts in `initdb/` run only when the PostgreSQL volume is first created.
After the volume contains a database, changing an environment variable does
not alter an existing role or database.

## Add another application

Choose a unique role and database, then run the following from this directory.
It prompts for the new application's password without echoing it:

```bash
set -a; source .env; set +a
read -rsp 'Application database password: ' APP_DB_PASSWORD; echo
docker compose --env-file .env exec postgres psql \
  --username "$POSTGRES_ADMIN_USER" --dbname "$POSTGRES_ADMIN_DB" \
  --set=app_user='new_app' --set=app_password="$APP_DB_PASSWORD" \
  --set=app_database='new_app' <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_database', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_database') \gexec
SQL
unset APP_DB_PASSWORD
```

Attach that application's service to the external `homelab-db` network and
connect to host `homelab-postgres` on port 5432.

## Operations

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs --tail 100 postgres
docker compose --env-file .env exec postgres pg_isready
docker compose --env-file .env pull
docker compose --env-file .env up -d
```

Back up every application database and copy the backups to another physical
device. One shared server means a PostgreSQL restart or storage failure affects
all applications that use it.
