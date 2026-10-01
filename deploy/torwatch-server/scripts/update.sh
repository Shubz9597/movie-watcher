#!/usr/bin/env bash
# Update (runbook §12): pre-update backup, pull the exact new immutable tag,
# recreate, verify — automatic rollback to the previous tag on failure.
#
# Usage: update.sh <new-immutable-tag> [--env-file <path>]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

NEW_TAG=""
ENV_FILE=".env"
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file requires a path}"; shift 2 ;;
    *) NEW_TAG="$1"; shift ;;
  esac
done
[ -n "$NEW_TAG" ] || { echo "usage: update.sh <new-immutable-tag> [--env-file <path>]" >&2; exit 2; }
case "$NEW_TAG" in
  *:latest|latest) echo "update: refusing :latest (immutable tags only)" >&2; exit 1 ;;
  *:*) ;;
  *) echo "update: tag must be fully qualified (repo:tag), e.g. torwatch-server:2.0.0-rc.2" >&2; exit 1 ;;
esac

[ -f "$ENV_FILE" ] || { echo "update: $ENV_FILE missing" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
# shellcheck source=compose-common.sh
. "$SCRIPT_DIR/compose-common.sh"

OLD_IMAGE="${TORWATCH_IMAGE:?TORWATCH_IMAGE missing}"
OLD_VERSION="${TORWATCH_VERSION:-unknown}"
echo "[update] $OLD_IMAGE -> $NEW_TAG"

BACKUP_ROOT="${TORWATCH_DATA_DIR:-.}/backups"
mkdir -p "$BACKUP_ROOT"
BACKUP_PARENT="$BACKUP_ROOT/pre-update-$(date -u +%Y%m%dT%H%M%SZ)"
"$SCRIPT_DIR/backup.sh" "$BACKUP_PARENT" --env-file "$ENV_FILE"
BACKUP_PATH="$(ls -1d "$BACKUP_PARENT"/backup-* 2>/dev/null | tail -n 1 || true)"
[ -n "$BACKUP_PATH" ] || { echo "update: pre-update backup did not produce a backup directory" >&2; exit 1; }

record_digest() {
  if command -v docker >/dev/null 2>&1; then
    docker image inspect --format '{{json .RepoDigests}}' "$1" 2>/dev/null || echo "[]"
  else
    echo "[]"
  fi
}
OLD_DIGESTS="$(record_digest "$OLD_IMAGE")"
echo "[update] previous image digests: $OLD_DIGESTS"

set_image() {
  local IMAGE="$1" VERSION="$2"
  sed -i.bak "s|^TORWATCH_IMAGE=.*|TORWATCH_IMAGE=$IMAGE|" "$ENV_FILE"
  sed -i.bak "s|^TORWATCH_VERSION=.*|TORWATCH_VERSION=$VERSION|" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
}

torwatch_compose_files

set_image "$NEW_TAG" "${NEW_TAG##*:}"
if ! docker compose "${COMPOSE_FILES[@]}" pull vod; then
  if docker image inspect "$NEW_TAG" >/dev/null 2>&1; then
    echo "[update] WARN: registry pull failed; using local image $NEW_TAG"
  else
    echo "update: image $NEW_TAG is neither pullable nor present locally — keeping $OLD_IMAGE" >&2
    set_image "$OLD_IMAGE" "$OLD_VERSION"
    exit 1
  fi
fi
docker compose "${COMPOSE_FILES[@]}" up -d vod

if "$SCRIPT_DIR/verify.sh" --env-file "$ENV_FILE"; then
  echo "[update] new image digests: $(record_digest "$NEW_TAG")"
  echo "UPDATE OK ($OLD_IMAGE -> $NEW_TAG)"
else
  echo "UPDATE FAILED — rolling back to $OLD_IMAGE" >&2
  set_image "$OLD_IMAGE" "$OLD_VERSION"
  docker compose "${COMPOSE_FILES[@]}" up -d vod
  "$SCRIPT_DIR/verify.sh" --env-file "$ENV_FILE" || \
    echo "[update] WARNING: rollback verification also failed; inspect logs and restore from $BACKUP_PATH" >&2
  echo "UPDATE ROLLED BACK to $OLD_IMAGE" >&2
  echo "[update] rollback recovery options:" >&2
  echo "  - re-run: $(basename "$0") <working-tag>" >&2
  echo "  - full data restore: scripts/restore.sh $BACKUP_PATH --yes" >&2
  exit 1
fi
echo "[update] pre-update backup: $BACKUP_PATH"
