#!/usr/bin/env bash
# Backup (runbook §11, implementation-plan Phase 6): consistent pg_dump plus
# host-side archives of Prowlarr configuration and the subtitle cache into an
# operator-provided directory. Torrent media is excluded by default
# (TORWATCH_BACKUP_INCLUDE_DOWNLOADS=1 opts in). A failed backup never
# replaces the last known-good backup: everything is staged in a temporary
# directory and atomically renamed only when complete and checksummed.
#
# Usage: backup.sh <backup-dir> [--env-file <path>]
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR=""
ENV_FILE=".env"
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file requires a path}"; shift 2 ;;
    *) BACKUP_DIR="$1"; shift ;;
  esac
done
[ -n "$BACKUP_DIR" ] || { echo "usage: backup.sh <backup-dir> [--env-file <path>]" >&2; exit 2; }
mkdir -p "$BACKUP_DIR"

[ -f "$ENV_FILE" ] || { echo "backup: $ENV_FILE missing" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="$BACKUP_DIR/.staging-$STAMP"
FINAL_DIR="$BACKUP_DIR/backup-$STAMP"
LOCK="$BACKUP_DIR/.backup.lock"

cleanup() { rm -rf "$STAGING"; if [ -n "${LOCK_ACQUIRED:-}" ]; then rm -rf "$LOCK"; fi; }
trap cleanup EXIT

# Lock: prevent concurrent backups (implementation-plan Phase 6).
mkdir "$LOCK" 2>/dev/null || { echo "backup: another backup appears to be running ($LOCK exists)" >&2; exit 1; }
LOCK_ACQUIRED=1
# Stale-lock recovery: older than 30 minutes is abandoned.
if [ -f "$LOCK/stamp" ] && [ "$(uname -s)" != "MINGW"* ] 2>/dev/null; then
  if [ -n "$(find "$LOCK/stamp" -mmin +30 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || { echo "backup: cannot acquire lock" >&2; exit 1; }
  fi
fi
date -u +%s > "$LOCK/stamp"

mkdir -p "$STAGING"

COMPOSE_FILES=(-f compose.yaml)
[ "${TORWATCH_MODE:-direct}" = "embedded-vpn" ] && COMPOSE_FILES+=(-f compose.vpn.yaml)

# --- database (consistent dump; exit status is propagated via pipefail) ----
echo "[backup] pg_dump -> db-$STAMP.sql.gz"
docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-torwatch}" "${POSTGRES_DB:-torwatch}" \
  | gzip > "$STAGING/db-$STAMP.sql.gz"
[ -s "$STAGING/db-$STAMP.sql.gz" ] || { echo "backup: pg_dump produced an empty archive" >&2; exit 1; }
# A gzip file that is not a valid dump, or a valid gzip of ZERO bytes (gzip
# of empty input is a well-formed ~20-byte file), would be silently useless.
gunzip -t "$STAGING/db-$STAMP.sql.gz"
DUMP_BYTES="$(gunzip -c "$STAGING/db-$STAMP.sql.gz" | wc -c)"
[ "$DUMP_BYTES" -gt 0 ] || { echo "backup: pg_dump wrote 0 bytes of SQL" >&2; exit 1; }

# --- host-side data (bind-mounted TORWATCH_DATA_DIR tree) -------------------
archive_dir() {
  SRC="$1"
  NAME="$2"
  if [ ! -d "$SRC" ]; then
    echo "[backup] skip $NAME (missing: $SRC)"
    return 0
  fi
  tar -czf "$STAGING/$NAME.tar.gz" -C "$(dirname "$SRC")" "$(basename "$SRC")"
  [ -s "$STAGING/$NAME.tar.gz" ] || { echo "backup: $NAME archive is empty" >&2; exit 1; }
}

echo "[backup] prowlarr configuration -> prowlarr-$STAMP.tar.gz"
if [ ! -f "${TORWATCH_DATA_DIR:?TORWATCH_DATA_DIR required}/prowlarr/config.xml" ]; then
  echo "[backup] WARN: prowlarr/config.xml not present — archiving an uninitialized prowlarr state" >&2
fi
archive_dir "${TORWATCH_DATA_DIR:?}/prowlarr" "prowlarr-$STAMP"

echo "[backup] subtitle cache -> subtitles-$STAMP.tar.gz"
archive_dir "${TORWATCH_DATA_DIR:?}/subtitles" "subtitles-$STAMP"

if [ "${TORWATCH_BACKUP_INCLUDE_DOWNLOADS:-0}" = "1" ]; then
  echo "[backup] torrent payloads (opt-in) -> downloads-$STAMP.tar.gz"
  archive_dir "${TORWATCH_DATA_DIR:?}/downloads" "downloads-$STAMP"
else
  echo "[backup] torrent payloads excluded (set TORWATCH_BACKUP_INCLUDE_DOWNLOADS=1 to include)"
fi

# --- manifest with versions, digests, and checksums -------------------------
echo "[backup] writing manifest"
IMAGE_DIGESTS="[]"
if command -v docker >/dev/null 2>&1; then
  IMAGE_DIGESTS="$(docker image inspect --format '{"image":"{{index .RepoDigests 0}}","id":"{{.Id}}"}' "${TORWATCH_IMAGE}" 2>/dev/null || echo '{"image":"'"${TORWATCH_IMAGE}"'","id":"local-build-unpushed"}')"
fi
cat > "$STAGING/manifest.json" <<EOF
{
  "timestamp": "$STAMP",
  "torwatchVersion": "${TORWATCH_VERSION:-unknown}",
  "torwatchImage": "${TORWATCH_IMAGE:-unknown}",
  "torwatchImageInfo": $IMAGE_DIGESTS,
  "deploymentMode": "${TORWATCH_MODE:-direct}",
  "includesDownloads": ${TORWATCH_BACKUP_INCLUDE_DOWNLOADS:-0}
}
EOF

# Note (opt-in downloads): the torrent client keeps writing while the archive
# is taken; a downloads restore recovers resumable partial state, not a
# crash-consistent snapshot. Documented in the runbooks.

( cd "$STAGING" && sha256sum db-*.sql.gz *.tar.gz manifest.json > checksums.sha256 )

chmod 600 "$STAGING"/db-*.sql.gz "$STAGING"/checksums.sha256 2>/dev/null || true

# --- atomic publish ---------------------------------------------------------
mv "$STAGING" "$FINAL_DIR"
echo "[backup] wrote $FINAL_DIR"
echo "[backup] contents:"
ls -1 "$FINAL_DIR"
echo "[backup] verify with: ( cd \"$FINAL_DIR\" && sha256sum -c checksums.sha256 )"
