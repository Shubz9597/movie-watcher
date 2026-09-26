#!/usr/bin/env bash
# Verify (acceptance §6): gateway health/readiness/version through the single
# LAN entrypoint, published-port audit (only the gateway may face the LAN),
# optional media byte-range + SSE pass-through checks, and data-root disk
# visibility.
#
# Usage: verify.sh [--env-file <path>]
#   TORWATCH_VERIFY_STREAM_URL  URL to byte-range check (206, exactly 1024
#                               bytes for bytes=0-1023)
#   TORWATCH_VERIFY_SSE_URL     URL delivering an immediate first SSE tick
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env"
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file requires a path}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
GATEWAY="http://127.0.0.1:${GATEWAY_PORT:-8080}"

COMPOSE_FILES=(-f compose.yaml)
[ "${TORWATCH_MODE:-direct}" = "embedded-vpn" ] && COMPOSE_FILES+=(-f compose.vpn.yaml)

echo "[verify] /healthz (retrying up to ${TORWATCH_VERIFY_TRIES:-90}x2s for startup/rolling restarts)"
BODY=""
for _ in $(seq 1 "${TORWATCH_VERIFY_TRIES:-90}"); do
  BODY="$(curl -fsS "$GATEWAY/healthz" 2>/dev/null || true)"
  [ "$BODY" = '{"status":"ok"}' ] && break
  sleep 2
done
[ "$BODY" = '{"status":"ok"}' ] || { echo "healthz body unexpected: ${BODY:-<unreachable>}" >&2; exit 1; }

echo "[verify] /readyz"
READY=""
for _ in $(seq 1 "${TORWATCH_VERIFY_TRIES:-90}"); do
  READY="$(curl -fsS "$GATEWAY/readyz" 2>/dev/null || true)"
  case "$READY" in *'"status":"ok"'*) break ;; esac
  sleep 2
done
case "$READY" in
  *'"status":"ok"'*) ;;
  *) echo "readyz not ok: ${READY:-<unreachable>}" >&2; exit 1 ;;
esac

echo "[verify] /v1/version"
VERSION_BODY="$(curl -fsS "$GATEWAY/v1/version")"
echo "$VERSION_BODY" | grep -q '"supportedProtocolRange"' || { echo "version payload incomplete: $VERSION_BODY" >&2; exit 1; }
if [ -n "${TORWATCH_VERSION:-}" ]; then
  echo "$VERSION_BODY" | grep -q "\"serverVersion\":\"${TORWATCH_VERSION}\"" \
    || echo "[verify] WARN: running serverVersion differs from TORWATCH_VERSION=${TORWATCH_VERSION}" >&2
fi

echo "[verify] published ports (gateway-only on the LAN)"
if command -v docker >/dev/null 2>&1; then
  # Audit: every published host port must be loopback-only or the gateway.
  AUDIT_OK=1
  PS_OUT="$(docker compose "${COMPOSE_FILES[@]}" ps 2>/dev/null || true)"
  while IFS= read -r LINE; do
    [ -n "$LINE" ] || continue
    # shapes: 0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp, 127.0.0.1:9696->9696/tcp
    HOST_PART="${LINE%%:*}"
    HOST_PART="${HOST_PART//[\[\]]/}"
    case "$HOST_PART" in
      127.0.0.1|::1) ;;                             # loopback: always safe
      0.0.0.0|::|"")
        case "$LINE" in
          *":${GATEWAY_PORT:-8080}->"*) ;;         # gateway: the intended LAN port
          *) echo "  UNEXPECTED published port: $LINE" >&2; AUDIT_OK=0 ;;
        esac ;;
      *) echo "  UNEXPECTED published port: $LINE" >&2; AUDIT_OK=0 ;;
    esac
  done <<EOF
$(echo "$PS_OUT" | grep -oE '([0-9]{1,3}(\.[0-9]{1,3}){3}|\[?[0-9a-f:]+\]?):[0-9]+->' | sort -u)
EOF
  [ "$AUDIT_OK" -eq 1 ] || { echo "port audit failed" >&2; exit 1; }
else
  echo "[verify] docker CLI unavailable — port audit skipped" >&2
fi

echo "[verify] data-root disk usage"
if [ -n "${TORWATCH_DATA_DIR:-}" ] && [ -d "$TORWATCH_DATA_DIR" ] && command -v df >/dev/null 2>&1; then
  df -h "$TORWATCH_DATA_DIR" 2>/dev/null | tail -n 1 || true
fi

echo "[verify] /stream byte-range (206, exactly 1024 bytes)"
RANGE_FILE="${TORWATCH_VERIFY_STREAM_URL:-}"
if [ -n "$RANGE_FILE" ]; then
  CODE_AND_SIZE=$(curl -s -o /tmp/torwatch-range.bin -w "%{http_code} %{size_download}" \
    -H "Range: bytes=0-1023" "$RANGE_FILE")
  read -r CODE SIZE <<<"$CODE_AND_SIZE"
  [ "$CODE" = "206" ] || { echo "stream range status = $CODE (want 206)" >&2; exit 1; }
  [ "$SIZE" = "1024" ] || { echo "stream range bytes = $SIZE (want 1024)" >&2; exit 1; }
else
  echo "[verify] TORWATCH_VERIFY_STREAM_URL unset — range check skipped (record as pending)"
fi

echo "[verify] /buffer/info SSE first tick (gateway must not buffer)"
SSE_FILE="${TORWATCH_VERIFY_SSE_URL:-}"
if [ -n "$SSE_FILE" ]; then
  FIRST_LINE=$(curl -s -N --max-time 5 "$SSE_FILE" | head -n 1)
  [ "$FIRST_LINE" = "retry: 2000" ] || { echo "SSE first line = $FIRST_LINE" >&2; exit 1; }
else
  echo "[verify] TORWATCH_VERIFY_SSE_URL unset — SSE check skipped (record as pending)"
fi

echo "VERIFY OK"
