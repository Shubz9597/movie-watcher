#!/usr/bin/env bash
# Restore (runbook): restores a backup produced by backup.sh into the
# package's OWN volumes. Never targets any database or media outside this
# compose project.
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP="${1:?usage: restore.sh <timestamp> (files db-<ts>.sql.gz and data-<ts>.tar.gz must exist)}"
# shellcheck disable=SC1091
set -a; source .env; set +a

echo "[restore] stopping vod for a consistent restore"
docker compose -f compose.yaml stop vod

echo "[restore] dropping and recreating ${POSTGRES_DB:-torwatch}"
docker compose -f compose.yaml exec -T postgres \
  psql -U "${POSTGRES_USER:-torwatch}" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB:-torwatch}\";" \
  -c "CREATE DATABASE \"${POSTGRES_DB:-torwatch}\" OWNER \"${POSTGRES_USER:-torwatch}\";"

echo "[restore] restoring db-$STAMP.sql.gz"
gunzip -c "db-$STAMP.sql.gz" | docker compose -f compose.yaml exec -T postgres \
  psql -U "${POSTGRES_USER:-torwatch}" -d "${POSTGRES_DB:-torwatch}"

echo "[restore] restarting vod"
docker compose -f compose.yaml up -d vod

echo "[restore] verifying health through the gateway"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-8080}/healthz" | grep -q '"status":"ok"'; then
    echo "RESTORE OK"
    exit 0
  fi
  sleep 2
done
echo "RESTORE FAIL: backend did not become healthy" >&2
exit 1
