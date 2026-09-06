#!/usr/bin/env bash
# Update (runbook): pre-update backup, then swap to the new immutable tag,
# then verify. Rollback = re-run with the previous tag (migration 005 is
# additive, so pre-005 binaries keep working against the migrated schema).
set -euo pipefail
cd "$(dirname "$0")/.."

NEW_TAG="${1:?usage: update.sh <new-immutable-tag>}"
# shellcheck disable=SC1091
set -a; source .env; set +a

OLD_TAG="${TORWATCH_IMAGE}"
echo "[update] $OLD_TAG -> $NEW_TAG"

"$(dirname "$0")/backup.sh" "./backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ)"

sed -i "s|^TORWATCH_IMAGE=.*|TORWATCH_IMAGE=$NEW_TAG|" .env
docker compose -f compose.yaml up -d vod

if "$(dirname "$0")/verify.sh"; then
  echo "UPDATE OK ($OLD_TAG -> $NEW_TAG)"
else
  echo "UPDATE FAILED — rolling back to $OLD_TAG" >&2
  sed -i "s|^TORWATCH_IMAGE=.*|TORWATCH_IMAGE=$OLD_TAG|" .env
  docker compose -f compose.yaml up -d vod
  "$(dirname "$0")/verify.sh" || true
  exit 1
fi
