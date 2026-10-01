#!/usr/bin/env bash
# Install the system-wide Fedora timer. Run as the normal deployment user;
# sudo is used only to place and enable the unit files.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TEMPLATE="$REPO_ROOT/deploy/torwatch-server/systemd/torwatch-git-deploy.service.in"
TIMER="$REPO_ROOT/deploy/torwatch-server/systemd/torwatch-git-deploy.timer"
DEPLOY_USER="${SUDO_USER:-$USER}"
DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
BRANCH="${1:-$(git -C "$REPO_ROOT" branch --show-current)}"

[ -n "$BRANCH" ] || { echo "usage: $0 [branch]" >&2; exit 2; }
git check-ref-format --branch "$BRANCH" >/dev/null || {
  echo "invalid deployment branch: $BRANCH" >&2
  exit 2
}
DOCKER_MEMBERS="$(getent group docker | cut -d: -f4)"
printf '%s\n' ",$DOCKER_MEMBERS," | grep -Fq ",$DEPLOY_USER," || {
  echo "$DEPLOY_USER must be a member of the docker group" >&2
  exit 1
}

TMP_SERVICE="$(mktemp)"
TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_SERVICE" "$TMP_ENV"' EXIT
sed -e "s|@USER@|$DEPLOY_USER|g" \
    -e "s|@GROUP@|$DEPLOY_GROUP|g" \
    -e "s|@REPO@|$REPO_ROOT|g" \
    "$TEMPLATE" > "$TMP_SERVICE"
cat > "$TMP_ENV" <<EOF
TORWATCH_REPO=$REPO_ROOT
TORWATCH_ENV_FILE=$REPO_ROOT/deploy/torwatch-server/.env
TORWATCH_DEPLOY_REMOTE=origin
TORWATCH_DEPLOY_BRANCH=$BRANCH
EOF

sudo install -o root -g root -m 0644 "$TMP_SERVICE" /etc/systemd/system/torwatch-git-deploy.service
sudo install -o root -g root -m 0644 "$TIMER" /etc/systemd/system/torwatch-git-deploy.timer
sudo install -o root -g root -m 0644 "$TMP_ENV" /etc/torwatch-git-deploy.env
sudo systemctl daemon-reload
sudo systemctl enable --now torwatch-git-deploy.timer
sudo systemctl start torwatch-git-deploy.service

echo "Installed automatic deployment for origin/$BRANCH"
echo "Status: sudo systemctl status torwatch-git-deploy.timer"
echo "Logs:   sudo journalctl -u torwatch-git-deploy.service -n 100 --no-pager"
