#!/usr/bin/env bash
# Preflight (runbook §1): verifies operator inputs before anything starts.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }

[ -f .env ] || fail ".env missing — copy .env.example and fill it in"
# shellcheck disable=SC1091
set -a; source .env; set +a

[ -n "${TORWATCH_IMAGE:-}" ] || fail "TORWATCH_IMAGE must pin an immutable tag (never :latest)"
case "${TORWATCH_IMAGE}" in
  *:latest) fail "TORWATCH_IMAGE must not use :latest (immutable tags only)" ;;
esac
[ -n "${POSTGRES_PASSWORD:-}" ] || fail "POSTGRES_PASSWORD required"
[ -n "${PROWLARR_API_KEY:-}" ] || fail "PROWLARR_API_KEY required"
[ "${WATCH_MAX_ACTIVE_TITLES:-1}" -ge 1 ] 2>/dev/null || fail "WATCH_MAX_ACTIVE_TITLES must be >= 1"

command -v docker >/dev/null || fail "docker CLI not found"
docker compose version >/dev/null || fail "docker compose plugin not found"

docker compose -f compose.yaml config -q || fail "compose.yaml does not validate"

echo "PREFLIGHT OK"
