#!/usr/bin/env bash
# Backup (runbook): consistent pg_dump + timestamped tarball into the
# operator-provided backup directory. Disposable and non-destructive; it
# never writes into the live volumes.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${1:?usage: backup.sh <backup-dir>}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# shellcheck disable=SC1091
set -a; source .env; set +a

echo "[backup] pg_dump -> $BACKUP_DIR/db-$STAMP.sql.gz"
docker compose -f compose.yaml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-torwatch}" "${POSTGRES_DB:-torwatch}" \
  | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz"

echo "[backup] torrent/subcache metadata tar -> $BACKUP_DIR/data-$STAMP.tar.gz"
docker compose -f compose.yaml exec -T vod \
  tar -czf - -C /data . 2>/dev/null || true > "$BACKUP_DIR/data-$STAMP.tar.gz"

echo "[backup] wrote db-$STAMP.sql.gz and data-$STAMP.tar.gz"
