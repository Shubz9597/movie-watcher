#!/usr/bin/env bash
# Script-level regression tests for the torwatch-server operator scripts.
# Pure bash: Docker and the gateway are stubbed, so this runs on any POSIX
# shell host (including a Windows Git Bash checkout) with no stack running.
#
# Usage: bash scripts/tests/run-tests.sh
#
# Regression coverage (one test per corrected defect):
#   - backup: shell redirection/exit-status bugs must not yield empty or
#     falsely successful archives (T003/T2-style defects)
#   - backup: a failed run never replaces the last known-good backup
#   - restore: corrupt checksums are rejected BEFORE writers are stopped
#   - restore: backup-dir/timestamp path resolution and archived application
#     data (prowlarr/subtitles) are restored, not just the database
#   - restore: failed restore retains pre-restore state
#   - update: tag swap; failed verification triggers automatic rollback
#   - preflight: placeholder/latest-tag/data-dir rejection
set -uo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$TESTS_DIR/../.." && pwd)"
PASS=0
FAIL=0
CURRENT_TMP=""

log() { printf '%s\n' "$*"; }
ok() { PASS=$((PASS + 1)); log "PASS: $1"; }
not_ok() { FAIL=$((FAIL + 1)); log "FAIL: $1"; }

new_workspace() {
  CURRENT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/torwatch-script-tests-XXXXXX")"
  export WORKSPACE="$CURRENT_TMP"
  export DATA="$WORKSPACE/data"
  mkdir -p "$DATA/prowlarr" "$DATA/subtitles" "$DATA/logs"
  echo "<Config><ApiKey>generated-key-for-tests</ApiKey></Config>" > "$DATA/prowlarr/config.xml"
  echo "subtitle-content" > "$DATA/subtitles/movie.en.srt"
  echo "operator-secrets" > "$WORKSPACE/.env"
  cat > "$WORKSPACE/.env" <<EOF
TORWATCH_DATA_DIR=$DATA
TORWATCH_IMAGE=torwatch-server:1.0.0
TORWATCH_VERSION=1.0.0
POSTGRES_USER=torwatch
POSTGRES_PASSWORD=test-password-only
POSTGRES_DB=torwatch
GATEWAY_PORT=18080
PROWLARR_ADMIN_PORT=19696
SELINUX_MOUNT_OPTS=,z
EOF
  chmod 600 "$WORKSPACE/.env"
  export STUB_DIR="$WORKSPACE/stubs"
  mkdir -p "$STUB_DIR"

  cat > "$STUB_DIR/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_STUB_LOG"
case " $* " in
  *" compose version --short "*|*" compose version --short"*) echo "2.39.1"; exit 0 ;;
  *" compose version "*|" compose version"*) echo "Docker Compose version v2.39.1"; exit 0 ;;
  *" config"*) echo "config-render-ok"; exit 0 ;;
esac
case "$*" in
  *"exec -T postgres pg_dump"*)
    if [ "${STUB_PG_DUMP_FAIL:-0}" = "1" ]; then echo "pg_dump exploded" >&2; exit 1; fi
    if [ "${STUB_PG_DUMP_EMPTY:-0}" = "1" ]; then exit 0; fi
    echo "CREATE TABLE stub (id int); INSERT INTO stub VALUES (1);"
    exit 0 ;;
  *"exec -i homelab-postgres pg_dump"*)
    echo "CREATE TABLE stub (id int); INSERT INTO stub VALUES (1);"
    exit 0 ;;
  *"exec -T postgres psql"*) echo "psql-ok"; exit 0 ;;
  *"network inspect homelab-db"*) exit 0 ;;
  *"inspect --format {{.State.Status}} homelab-postgres"*) echo "running"; exit 0 ;;
  *"inspect --format {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} homelab-postgres"*) echo "healthy"; exit 0 ;;
  *"image inspect"*) echo '["stub-registry/torwatch-server@sha256:deadbeefcafe"]'; exit 0 ;;
  *"ps"*) printf 'torwatch-server-gateway-1   0.0.0.0:%s->8080/tcp\n' "${STUB_GATEWAY_PORT:-18080}"; exit 0 ;;
esac
exit 0
STUB
  chmod +x "$STUB_DIR/docker"

  cat > "$STUB_DIR/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "$CURL_STUB_LOG"
URL=""
for a in "$@"; do
  case "$a" in http://*) URL="$a" ;; esac
done
case "$URL" in
  */healthz)
    if [ "${STUB_HEALTH:-ok}" = "ok" ]; then printf '{"status":"ok"}'; else exit 22; fi
    exit 0 ;;
  */readyz)
    if [ "${STUB_HEALTH:-ok}" = "ok" ]; then printf '{"status":"ok","components":{}}'; else exit 22; fi
    exit 0 ;;
  */v1/version)
    printf '{"serverVersion":"1.0.0","revision":"stub","builtAt":"stub","protocolVersion":1,"supportedProtocolRange":[1,1]}'
    exit 0 ;;
esac
exit 0
STUB
  chmod +x "$STUB_DIR/curl"

  cat > "$STUB_DIR/netstat" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
  chmod +x "$STUB_DIR/netstat"

  export DOCKER_STUB_LOG="$WORKSPACE/docker.log"
  export CURL_STUB_LOG="$WORKSPACE/curl.log"
  export PATH="$STUB_DIR:$PATH"
  # Fast retries inside the scripts under test.
  export TORWATCH_VERIFY_TRIES=2
  export TORWATCH_RESTORE_TRIES=2
  export TORWATCH_RESTORE_CONFIRM=yes
}

finish_test() {
  [ -n "$CURRENT_TMP" ] && rm -rf "$CURRENT_TMP"
  CURRENT_TMP=""
}

expect_exit() {
  local WANT="$1" MSG="$2"; shift 2
  local RC=0
  local ERR_OUT
  ERR_OUT="$("$@" 2>&1 >/dev/null)" || RC=$?
  if [ "$RC" = "$WANT" ]; then ok "$MSG"; else not_ok "$MSG (exit $RC, want $WANT): $ERR_OUT"; fi
}

expect_contains() {
  local HAYSTACK="$1" NEEDLE="$2" MSG="$3"
  case "$HAYSTACK" in *"$NEEDLE"*) ok "$MSG" ;; *) not_ok "$MSG (missing: $NEEDLE)" ;; esac
}

latest_backup_dir() {
  ls -1d "$1"/backup-* 2>/dev/null | tail -n 1
}

# ---------------------------------------------------------------------------
log "== backup =="
new_workspace
expect_exit 0 "backup.sh succeeds on a healthy stack" \
  bash "$PKG_ROOT/scripts/backup.sh" "$WORKSPACE/backups" --env-file "$WORKSPACE/.env"
B1="$(latest_backup_dir "$WORKSPACE/backups")"
if [ -n "$B1" ] && [ -f "$B1/manifest.json" ] && [ -f "$B1/checksums.sha256" ]; then
  ok "backup produced manifest + checksums"
else
  not_ok "backup produced manifest + checksums"
fi
if [ -s "$B1"/db-*.sql.gz ] && gunzip -t "$B1"/db-*.sql.gz 2>/dev/null; then
  ok "db archive non-empty and valid gzip (exit status propagated)"
else
  not_ok "db archive non-empty and valid gzip (exit status propagated)"
fi
if tar -tzf "$B1"/prowlarr-*.tar.gz 2>/dev/null | grep -q config.xml; then
  ok "prowlarr config archived"
else
  not_ok "prowlarr config archived"
fi
if ( cd "$B1" && sha256sum -c checksums.sha256 >/dev/null 2>&1 ); then
  ok "checksums validate"
else
  not_ok "checksums validate"
fi
if [ ! -d "$WORKSPACE/backups"/.staging-* ] && [ ! -d "$WORKSPACE/backups/.backup.lock" ]; then
  ok "staging dir and lock cleaned up"
else
  not_ok "staging dir and lock cleaned up"
fi

# Failed pg_dump must not create a "successful" backup nor touch the good one.
expect_exit 1 "backup.sh fails when pg_dump fails" \
  env STUB_PG_DUMP_FAIL=1 bash "$PKG_ROOT/scripts/backup.sh" "$WORKSPACE/backups" --env-file "$WORKSPACE/.env"
if [ "$(ls -1d "$WORKSPACE"/backups/backup-* 2>/dev/null | wc -l)" = "1" ]; then
  ok "failed backup left the previous known-good backup untouched"
else
  not_ok "failed backup left the previous known-good backup untouched"
fi

# Regression: an empty dump must be rejected, not shipped as a backup.
expect_exit 1 "backup.sh rejects an empty pg_dump output" \
  env STUB_PG_DUMP_EMPTY=1 bash "$PKG_ROOT/scripts/backup.sh" "$WORKSPACE/backups" --env-file "$WORKSPACE/.env"
finish_test

new_workspace
cat >> "$WORKSPACE/.env" <<EOF
TORWATCH_DB_MODE=shared
POSTGRES_CONTAINER=homelab-postgres
EOF
expect_exit 0 "backup.sh dumps the shared PostgreSQL container" \
  bash "$PKG_ROOT/scripts/backup.sh" "$WORKSPACE/backups" --env-file "$WORKSPACE/.env"
if grep -q "exec -i homelab-postgres pg_dump" "$DOCKER_STUB_LOG"; then
  ok "shared backup uses the independent database container"
else
  not_ok "shared backup uses the independent database container"
fi
finish_test

# ---------------------------------------------------------------------------
log "== restore =="
new_workspace
bash "$PKG_ROOT/scripts/backup.sh" "$WORKSPACE/backups" --env-file "$WORKSPACE/.env" >/dev/null 2>&1
B1="$(latest_backup_dir "$WORKSPACE/backups")"

# Corrupt the backup: restore must refuse BEFORE stopping any writer.
if [ -n "$B1" ]; then
  printf 'X' >> "$B1"/subtitles-*.tar.gz
fi
: > "$DOCKER_STUB_LOG"
expect_exit 1 "restore.sh rejects a corrupt checksum" \
  bash "$PKG_ROOT/scripts/restore.sh" "$B1" --yes --env-file "$WORKSPACE/.env"
if [ -n "$B1" ] && ! grep -q " stop " "$DOCKER_STUB_LOG"; then
  ok "corrupt checksum rejected before stopping writers"
else
  not_ok "corrupt checksum rejected before stopping writers"
fi
finish_test

new_workspace
# Backup into the data root so the timestamp path resolution is exercised
# (restore.sh searches ${TORWATCH_DATA_DIR}/backups for backup-<timestamp>).
bash "$PKG_ROOT/scripts/backup.sh" "$DATA/backups" --env-file "$WORKSPACE/.env" >/dev/null 2>&1
B1="$(latest_backup_dir "$DATA/backups")"
# Mutate live data after the backup.
echo "MUTATED" > "$DATA/prowlarr/config.xml"
echo "MUTATED" > "$DATA/subtitles/movie.en.srt"
# Restore by TIMESTAMP (path-resolution regression), not full path.
TS="$(basename "$B1")"; TS="${TS#backup-}"
expect_exit 0 "restore.sh by timestamp succeeds" \
  bash "$PKG_ROOT/scripts/restore.sh" "$TS" --yes --env-file "$WORKSPACE/.env"
if grep -q generated-key "$DATA/prowlarr/config.xml"; then
  ok "prowlarr application data restored from archive"
else
  not_ok "prowlarr application data restored from archive"
fi
if grep -q subtitle-content "$DATA/subtitles/movie.en.srt"; then
  ok "subtitle cache restored from archive"
else
  not_ok "subtitle cache restored from archive"
fi
if grep -q "stop vod prowlarr" "$DOCKER_STUB_LOG"; then
  ok "writers stopped before restore"
else
  not_ok "writers stopped before restore"
fi
finish_test

new_workspace
bash "$PKG_ROOT/scripts/backup.sh" "$WORKSPACE/backups" --env-file "$WORKSPACE/.env" >/dev/null 2>&1
B1="$(latest_backup_dir "$WORKSPACE/backups")"
echo "MUTATED" > "$DATA/prowlarr/config.xml"
expect_exit 1 "restore.sh fails when the backend never becomes healthy" \
  env STUB_HEALTH=fail bash "$PKG_ROOT/scripts/restore.sh" "$B1" --yes --env-file "$WORKSPACE/.env"
if [ -d "$B1/.pre-restore-state/prowlarr" ]; then
  ok "failed restore retained pre-restore state"
else
  not_ok "failed restore retained pre-restore state"
fi
finish_test

# ---------------------------------------------------------------------------
log "== update =="
new_workspace
expect_exit 0 "update.sh swaps to the new immutable tag and verifies" \
  bash "$PKG_ROOT/scripts/update.sh" torwatch-server:1.0.1 --env-file "$WORKSPACE/.env"
if grep -q "^TORWATCH_IMAGE=torwatch-server:1.0.1" "$WORKSPACE/.env"; then
  ok ".env updated to the new tag"
else
  not_ok ".env updated to the new tag"
fi
if grep -q "pre-update-" <(ls -1 "$DATA/backups" 2>/dev/null); then
  ok "update created a pre-update backup under the data root"
else
  not_ok "update created a pre-update backup under the data root"
fi
finish_test

new_workspace
expect_exit 1 "update.sh fails and rolls back when verification fails" \
  env STUB_HEALTH=fail bash "$PKG_ROOT/scripts/update.sh" torwatch-server:1.0.1 --env-file "$WORKSPACE/.env"
if grep -q "^TORWATCH_IMAGE=torwatch-server:1.0.0" "$WORKSPACE/.env"; then
  ok "automatic rollback restored the previous tag"
else
  not_ok "automatic rollback restored the previous tag"
fi
finish_test

# ---------------------------------------------------------------------------
log "== preflight =="
new_workspace
expect_exit 0 "preflight accepts a valid direct-mode .env" \
  bash "$PKG_ROOT/scripts/preflight.sh" --mode direct --env-file "$WORKSPACE/.env"
sed -i 's/^TORWATCH_IMAGE=.*/TORWATCH_IMAGE=torwatch-server:latest/' "$WORKSPACE/.env"
expect_exit 1 "preflight rejects :latest" \
  bash "$PKG_ROOT/scripts/preflight.sh" --mode direct --env-file "$WORKSPACE/.env"
sed -i 's/^TORWATCH_IMAGE=.*/TORWATCH_IMAGE=torwatch-server:1.0.0/; s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=change-me-operator-generated/' "$WORKSPACE/.env"
expect_exit 1 "preflight rejects unchanged placeholders" \
  bash "$PKG_ROOT/scripts/preflight.sh" --mode direct --env-file "$WORKSPACE/.env"
sed -i 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=test-password-only/' "$WORKSPACE/.env"
sed -i 's|^TORWATCH_DATA_DIR=.*|TORWATCH_DATA_DIR='$WORKSPACE'/missing-data|' "$WORKSPACE/.env"
expect_exit 1 "preflight rejects a missing data root" \
  bash "$PKG_ROOT/scripts/preflight.sh" --mode direct --env-file "$WORKSPACE/.env"
finish_test


new_workspace
cat >> "$WORKSPACE/.env" <<EOF
TORWATCH_DB_MODE=shared
POSTGRES_CONTAINER=homelab-postgres
EOF
expect_exit 0 "preflight accepts a healthy shared PostgreSQL service" \
  bash "$PKG_ROOT/scripts/preflight.sh" --mode direct --env-file "$WORKSPACE/.env"
finish_test

log ""
log "TOTALS: pass=$PASS fail=$FAIL"
[ "$FAIL" = "0" ]
