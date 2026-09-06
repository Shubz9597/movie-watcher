#!/usr/bin/env bash
# torWatch homeserver package scripts (plan P7, constitution VI):
# preflight | backup | restore | update | verify — see README.md for the
# runbook. Every script is fail-closed and never touches anything outside
# the package's own compose project/volumes.
set -euo pipefail

cd "$(dirname "$0")/.."

COMMAND="${1:-}"
case "$COMMAND" in
  preflight) shift; exec "$PWD/scripts/preflight.sh" "$@" ;;
  backup) shift; exec "$PWD/scripts/backup.sh" "$@" ;;
  restore) shift; exec "$PWD/scripts/restore.sh" "$@" ;;
  update) shift; exec "$PWD/scripts/update.sh" "$@" ;;
  verify) shift; exec "$PWD/scripts/verify.sh" "$@" ;;
  *) echo "usage: torwatch.sh {preflight|backup|restore|update|verify}" >&2; exit 2 ;;
esac
