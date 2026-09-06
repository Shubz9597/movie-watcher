#!/usr/bin/env bash
# Verify (runbook + T060/T061 acceptance): health/readiness/version through
# the single gateway entrypoint, then media byte-range and SSE pass-through
# checks (gateway must not buffer either).
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
set -a; source .env; set +a
GATEWAY="http://127.0.0.1:${GATEWAY_PORT:-8080}"

echo "[verify] /healthz"
BODY="$(curl -fsS "$GATEWAY/healthz")"
[ "$BODY" = '{"status":"ok"}' ] || { echo "healthz body unexpected: $BODY" >&2; exit 1; }

echo "[verify] /readyz"
curl -fsS "$GATEWAY/readyz" | grep -q '"status":"ok"'

echo "[verify] /v1/version"
curl -fsS "$GATEWAY/v1/version" | grep -q '"supportedProtocolRange"'

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
