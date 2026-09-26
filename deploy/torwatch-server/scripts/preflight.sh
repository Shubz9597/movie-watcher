#!/usr/bin/env bash
# Preflight (runbook §5): validates the operator's environment and inputs
# before anything starts. Fail-closed; never modifies disks.
#
# Usage: preflight.sh [--mode direct|embedded-vpn] [--env-file <path>]
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="direct"
ENV_FILE=".env"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:?--mode requires direct|embedded-vpn}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file requires a path}"; shift 2 ;;
    *) echo "PREFLIGHT FAIL: unknown option $1" >&2; exit 1 ;;
  esac
done
case "$MODE" in
  direct|embedded-vpn) ;;
  *) echo "PREFLIGHT FAIL: --mode must be direct or embedded-vpn" >&2; exit 1 ;;
esac

fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }
warn() { echo "PREFLIGHT WARN: $*" >&2; }

[ -f "$ENV_FILE" ] || fail "$ENV_FILE missing — copy .env.example and fill it in"

# World-readable secret file check (best-effort; skipped where stat is
# unavailable, e.g. some Windows shells — the Fedora/Linux runbook host is
# the authoritative target).
if command -v stat >/dev/null 2>&1 && [ "$(uname -s)" != "MINGW"* ] 2>/dev/null; then
  PERMS="$(stat -c %a "$ENV_FILE" 2>/dev/null || echo 600)"
  [ "$PERMS" ] || PERMS=600
  if [ "$((8#$PERMS & 8#077))" -ne 0 ] 2>/dev/null; then
    fail "$ENV_FILE is group/world readable (mode $PERMS); run: chmod 600 $ENV_FILE"
  fi
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# --- required values -------------------------------------------------------
[ -n "${TORWATCH_DATA_DIR:-}" ] || fail "TORWATCH_DATA_DIR required (persistent data root)"
case "$TORWATCH_DATA_DIR" in
  /*|[A-Za-z]:/*|[A-Za-z]:\\*) ;;
  *) fail "TORWATCH_DATA_DIR must be an absolute path (got a relative one)" ;;
esac

[ -n "${TORWATCH_IMAGE:-}" ] || fail "TORWATCH_IMAGE must pin an immutable tag (never :latest)"
case "${TORWATCH_IMAGE}" in
  *:latest|*:Latest) fail "TORWATCH_IMAGE must not use :latest (immutable tags only)" ;;
  *:*) ;;
  *) fail "TORWATCH_IMAGE must include a version tag (got '$TORWATCH_IMAGE')" ;;
esac

[ -n "${POSTGRES_PASSWORD:-}" ] || fail "POSTGRES_PASSWORD required"
for VAR in POSTGRES_PASSWORD TORWATCH_IMAGE TORWATCH_DATA_DIR; do
  VALUE="$(printenv "$VAR" || true)"
  case "$VALUE" in
    *change-me*) fail "$VAR still contains an unchanged placeholder" ;;
  esac
done
case "${POSTGRES_PASSWORD}" in
  change-me*|password|admin|test) fail "POSTGRES_PASSWORD looks like a placeholder; generate a strong unique value" ;;
esac

# --- data root -------------------------------------------------------------
[ -d "$TORWATCH_DATA_DIR" ] || fail "data root $TORWATCH_DATA_DIR does not exist — create it per the runbook"
[ -w "$TORWATCH_DATA_DIR" ] || fail "data root $TORWATCH_DATA_DIR is not writable by the current user"
for SUB in postgres prowlarr flaresolverr downloads subtitles logs backups; do
  if [ -d "$TORWATCH_DATA_DIR/$SUB" ]; then
    # WARN, not fail: on Linux hosts some of these directories are written by
    # container UIDs (e.g. the postgres image user), not by the invoking
    # operator account, so a root-owned directory here can still be healthy.
    [ -w "$TORWATCH_DATA_DIR/$SUB" ] \
      || warn "$TORWATCH_DATA_DIR/$SUB is not writable by the current user (verify container UID ownership — Fedora runbook §3)"
  else
    warn "$TORWATCH_DATA_DIR/$SUB does not exist yet (runbook §3 creates it; containers may fail without it)"
  fi
done

# Free-space visibility before streaming fails (architecture §6).
if command -v df >/dev/null 2>&1; then
  DF_OUT="$(df -h "$TORWATCH_DATA_DIR" 2>/dev/null | tail -n 1 || true)"
  [ -n "$DF_OUT" ] && echo "[preflight] data root filesystem: $DF_OUT"
fi

# --- SELinux (Fedora) ------------------------------------------------------
if [ -r /sys/fs/selinux/enforce ] && [ "$(cat /sys/fs/selinux/enforce 2>/dev/null || echo 0)" = "1" ]; then
  case "${SELINUX_MOUNT_OPTS:-}" in
    *,z|z,*|z) ;;
    *) fail "SELinux enforcing detected but SELINUX_MOUNT_OPTS is not set — add 'SELINUX_MOUNT_OPTS=,z' to $ENV_FILE (see docs/v2-server-package/fedora-runbook.md)" ;;
  esac
fi

# --- container tooling -----------------------------------------------------
command -v docker >/dev/null || fail "docker CLI not found"
docker compose version >/dev/null 2>&1 || fail "docker compose plugin not found"
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo 0)"
if [ "$MODE" = "embedded-vpn" ]; then
  MIN_MAJOR="${COMPOSE_VERSION%%.*}"
  case "$COMPOSE_VERSION" in
    [2-9].*|v[2-9].*) ;;
    *) fail "compose version '$COMPOSE_VERSION' not parseable; >= 2.24 required for the VPN overlay" ;;
  esac
  if [ "${MIN_MAJOR:-0}" -lt 2 ]; then
    fail "compose >= 2.24 required for the VPN overlay (!override); found $COMPOSE_VERSION"
  fi
  case "$COMPOSE_VERSION" in
    v2.[0-9].*|v2.1[0-9].*|v2.2[0-3]*|2.[0-9].*|2.1[0-9].*|2.2[0-3]*)
      fail "compose >= 2.24 required for the VPN overlay (!override); found $COMPOSE_VERSION" ;;
  esac
  [ -e /dev/net/tun ] || fail "/dev/net/tun missing — embedded-VPN mode requires TUN support"
fi

# --- ports -----------------------------------------------------------------
check_port() {
  PORT="$1"
  LABEL="$2"
  if command -v netstat >/dev/null 2>&1; then
    if netstat -an 2>/dev/null | grep -Eq "[.:]$PORT[[:space:]].*LISTEN"; then
      fail "port $PORT already in use ($LABEL); change it in $ENV_FILE"
    fi
  else
    warn "netstat unavailable — port $PORT ($LABEL) availability unverified"
  fi
}
check_port "${GATEWAY_PORT:-8080}" "GATEWAY_PORT"
check_port "${PROWLARR_ADMIN_PORT:-9696}" "PROWLARR_ADMIN_PORT"

# --- effective compose configuration --------------------------------------
if [ "$MODE" = "embedded-vpn" ]; then
  docker compose --env-file "$ENV_FILE" -f compose.yaml -f compose.vpn.yaml config --quiet \
    || fail "compose.yaml + compose.vpn.yaml does not validate (check VPN settings)"
else
  docker compose --env-file "$ENV_FILE" -f compose.yaml config --quiet \
    || fail "compose.yaml does not validate"
fi

echo "PREFLIGHT OK (mode=$MODE)"
