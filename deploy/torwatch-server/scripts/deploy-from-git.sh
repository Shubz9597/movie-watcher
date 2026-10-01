#!/usr/bin/env bash
# Poll one remote Git branch and deploy its newest fast-forward commit.
#
# The shared PostgreSQL stack is never managed by this script. In shared-db
# mode Compose sees only the external homelab-db network and the disabled
# bundled postgres profile.
set -euo pipefail

REPO_ROOT="${TORWATCH_REPO:-$(cd "$(dirname "$0")/../../.." && pwd)}"
DEPLOY_DIR="$REPO_ROOT/deploy/torwatch-server"
ENV_FILE="${TORWATCH_ENV_FILE:-$DEPLOY_DIR/.env}"
REMOTE="${TORWATCH_DEPLOY_REMOTE:-origin}"
BRANCH="${TORWATCH_DEPLOY_BRANCH:-}"
STATE_DIR="${TORWATCH_DEPLOY_STATE_DIR:-$DEPLOY_DIR/.deploy-state}"
STATE_FILE="$STATE_DIR/revision"
LOCK_FILE="$STATE_DIR/deploy.lock"

log() { printf '[git-deploy] %s\n' "$*"; }
fail() { printf '[git-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || fail "git is not installed"
command -v docker >/dev/null || fail "docker is not installed"
[ -f "$ENV_FILE" ] || fail "missing operator environment: $ENV_FILE"

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another deployment is already running"; exit 0; }

cd "$REPO_ROOT"
if [ -z "$BRANCH" ]; then
  BRANCH="$(git branch --show-current)"
fi
[ -n "$BRANCH" ] || fail "TORWATCH_DEPLOY_BRANCH is empty and the checkout is detached"
[ "$(git branch --show-current)" = "$BRANCH" ] || \
  fail "checkout is on $(git branch --show-current); configured branch is $BRANCH"

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  fail "working tree is not clean; commit, stash, or remove local files before automatic deployment"
fi

log "fetching $REMOTE/$BRANCH"
git fetch --quiet --prune "$REMOTE" "$BRANCH"
TARGET="$(git rev-parse "refs/remotes/$REMOTE/$BRANCH")"
HEAD_REV="$(git rev-parse HEAD)"

if [ "$HEAD_REV" != "$TARGET" ]; then
  git merge-base --is-ancestor "$HEAD_REV" "$TARGET" || \
    fail "remote is not a fast-forward of the local checkout; resolve it manually"
  git merge --ff-only "$TARGET"
  HEAD_REV="$TARGET"
fi

DEPLOYED=""
if [ -f "$STATE_FILE" ]; then
  read -r DEPLOYED < "$STATE_FILE" || true
fi
if [ "$DEPLOYED" = "$TARGET" ]; then
  log "already deployed ${TARGET:0:12}"
  exit 0
fi

NEED_IMAGE=1
NEED_COMPOSE=1
FRONTEND_CHANGED=0
if [ -n "$DEPLOYED" ] && git cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
  CHANGED="$(git diff --name-only "$DEPLOYED" "$TARGET")"
  NEED_IMAGE=0
  NEED_COMPOSE=0
  if grep -Eq '^(torrent-streamer/|deploy/torwatch-server/Dockerfile$)' <<<"$CHANGED"; then
    NEED_IMAGE=1
  fi
  if grep -Eq '^deploy/torwatch-server/(compose([^/]*)\.ya?ml|Caddyfile)$' <<<"$CHANGED"; then
    NEED_COMPOSE=1
  fi
  if grep -Eq '^electron-app/' <<<"$CHANGED"; then
    FRONTEND_CHANGED=1
  fi
fi

SHORT="${TARGET:0:12}"
TAG="git-$SHORT"
IMAGE="torwatch-server:$TAG"

if [ "$NEED_IMAGE" -eq 1 ]; then
  log "building immutable backend image $IMAGE"
  "$DEPLOY_DIR/scripts/build-images.sh" "$TAG"
  log "backing up, updating the Go service, and verifying"
  "$DEPLOY_DIR/scripts/update.sh" "$IMAGE" --env-file "$ENV_FILE"
fi

if [ "$NEED_COMPOSE" -eq 1 ]; then
  log "reconciling application Compose services"
  (
    cd "$DEPLOY_DIR"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
    # shellcheck disable=SC1091
    . scripts/compose-common.sh
    torwatch_compose_files
    docker compose "${COMPOSE_FILES[@]}" config --quiet
    docker compose "${COMPOSE_FILES[@]}" up -d
    scripts/verify.sh --env-file "$ENV_FILE"
  )
fi

if [ "$NEED_IMAGE" -eq 0 ] && [ "$NEED_COMPOSE" -eq 0 ]; then
  log "no backend image or Compose changes in this revision"
fi
if [ "$FRONTEND_CHANGED" -eq 1 ]; then
  log "mobile/desktop frontend changed; build and reinstall the client app separately"
fi

printf '%s\n' "$TARGET" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
log "deployment recorded at $SHORT"
