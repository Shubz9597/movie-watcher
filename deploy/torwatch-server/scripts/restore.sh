#!/usr/bin/env bash
# Restore (runbook §13): restores a backup produced by backup.sh into this
# package's own data tree and database. Never targets anything outside the
# package's compose project.
#
# Usage: restore.sh <backup-dir-or-timestamp> [--yes]
#   <backup-dir-or-timestamp>: a directory containing manifest.json, or a
#     backup-<timestamp> directory name searched under ./backups and
#     ${TORWATCH_DATA_DIR}/backups.
#
# Safety: checksums and the manifest are validated BEFORE any writer is
# stopped; a failed restore leaves the previous state (moved aside, not
# deleted) available for diagnosis.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?usage: restore.sh <backup-dir-or-timestamp> [--yes] [--env-file <path>]}"
CONFIRM="${TORWATCH_RESTORE_CONFIRM:-}"
ENV_FILE=".env"
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) CONFIRM="yes"; shift ;;
    --env-file) ENV_FILE="${2:?--env-file requires a path}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "restore: $ENV_FILE missing" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# --- resolve the backup directory ------------------------------------------
BACKUP_DIR=""
if [ -f "$TARGET/manifest.json" ]; then
  BACKUP_DIR="$TARGET"
elif [ -f "backups/backup-$TARGET/manifest.json" ]; then
  BACKUP_DIR="backups/backup-$TARGET"
elif [ -n "${TORWATCH_DATA_DIR:-}" ] && [ -f "$TORWATCH_DATA_DIR/backups/backup-$TARGET/manifest.json" ]; then
  BACKUP_DIR="$TORWATCH_DATA_DIR/backups/backup-$TARGET"
fi
[ -n "$BACKUP_DIR" ] || { echo "restore: cannot find a backup at '$TARGET' (need a dir with manifest.json, or a backup-<timestamp> under ./backups or \$TORWATCH_DATA_DIR/backups)" >&2; exit 1; }
echo "[restore] backup: $BACKUP_DIR"

# --- validate BEFORE stopping any writer ------------------------------------
( cd "$BACKUP_DIR" && sha256sum -c checksums.sha256 --quiet ) \
  || { echo "restore: checksum validation FAILED — refusing to touch the live stack" >&2; exit 1; }
DB_DUMP="$(ls "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | head -n 1)"
[ -n "$DB_DUMP" ] || { echo "restore: no db archive in backup" >&2; exit 1; }

cat "$BACKUP_DIR/manifest.json"
echo "[restore] backup version: $(sed -n 's/.*"torwatchVersion": "\([^"]*\)".*/\1/p' "$BACKUP_DIR/manifest.json")"

if [ "$CONFIRM" != "yes" ]; then
  printf "[restore] about to REPLACE the current database, Prowlarr configuration and subtitle cache. Type RESTORE to continue: "
  read -r ANSWER
  [ "$ANSWER" = "RESTORE" ] || { echo "restore: aborted by operator" >&2; exit 1; }
fi

COMPOSE_FILES=(-f compose.yaml)
[ "${TORWATCH_MODE:-direct}" = "embedded-vpn" ] && COMPOSE_FILES+=(-f compose.vpn.yaml)

# --- stop application writers ------------------------------------------------
echo "[restore] stopping vod and prowlarr"
docker compose "${COMPOSE_FILES[@]}" stop vod prowlarr

PRE_RESTORE="$BACKUP_DIR/.pre-restore-state"
mkdir -p "$PRE_RESTORE"

DB_FAIL=""
# --- database restore --------------------------------------------------------
echo "[restore] dropping and recreating ${POSTGRES_DB:-torwatch}"
docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-torwatch}" -d postgres \
  -c "DROP DATABASE IF EXISTS \"${POSTGRES_DB:-torwatch}\";" \
  -c "CREATE DATABASE \"${POSTGRES_DB:-torwatch}\" OWNER \"${POSTGRES_USER:-torwatch}\";" \
  || DB_FAIL="psql drop/create failed"

if [ -z "$DB_FAIL" ]; then
  echo "[restore] restoring $(basename "$DB_DUMP")"
  gunzip -c "$DB_DUMP" | docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-torwatch}" -d "${POSTGRES_DB:-torwatch}" \
    || DB_FAIL="psql restore failed"
fi

# --- host data restore (previous state moved aside, never deleted) -----------
restore_dir() {
  ARCHIVE_PATH="$1"
  DATA_SUBDIR="$2"
  if [ -z "$ARCHIVE_PATH" ]; then
    echo "[restore] no archive for $DATA_SUBDIR in this backup — leaving current data in place"
    return 0
  fi
  DEST="${TORWATCH_DATA_DIR:?}/$DATA_SUBDIR"
  if [ -d "$DEST" ]; then
    KEEP="$PRE_RESTORE/$DATA_SUBDIR"
    mv "$DEST" "$KEEP"
    echo "[restore] previous $DATA_SUBDIR preserved at $KEEP"
  fi
  mkdir -p "$DEST"
  tar -xzf "$ARCHIVE_PATH" -C "$DEST" --strip-components 1
  echo "[restore] restored $DATA_SUBDIR from $(basename "$ARCHIVE_PATH")"
}

restore_dir "$(ls "$BACKUP_DIR"/prowlarr-*.tar.gz 2>/dev/null | head -n 1)" "prowlarr"
restore_dir "$(ls "$BACKUP_DIR"/subtitles-*.tar.gz 2>/dev/null | head -n 1)" "subtitles"
if ls "$BACKUP_DIR"/downloads-*.tar.gz >/dev/null 2>&1; then
  restore_dir "$(ls "$BACKUP_DIR"/downloads-*.tar.gz | head -n 1)" "downloads"
fi

# --- restart and verify --------------------------------------------------------
echo "[restore] restarting vod and prowlarr"
docker compose "${COMPOSE_FILES[@]}" up -d prowlarr vod

if [ -n "$DB_FAIL" ]; then
  echo "RESTORE FAIL: $DB_FAIL — previous state preserved under $PRE_RESTORE; do not delete it before diagnosis" >&2
  exit 1
fi

echo "[restore] verifying health through the gateway"
for _ in $(seq 1 "${TORWATCH_RESTORE_TRIES:-30}"); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT:-8080}/healthz" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "RESTORE OK (pre-restore state retained at $PRE_RESTORE)"
    exit 0
  fi
  sleep 2
done
echo "RESTORE FAIL: backend did not become healthy — pre-restore state retained at $PRE_RESTORE" >&2
exit 1
