#!/usr/bin/env bash
# install.sh — install this skill globally for Claude Code.
# Copies the skill into ~/.claude/skills/<name>/ so Claude Code auto-discovers it.

set -euo pipefail

SKILL_NAME="react-native-performance-audit"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
DEST_DIR="$DEST_ROOT/$SKILL_NAME"

echo "Installing '$SKILL_NAME' for Claude Code..."
echo "  source: $SRC_DIR"
echo "  dest:   $DEST_DIR"

mkdir -p "$DEST_ROOT"

if [ -d "$DEST_DIR" ]; then
  echo "  (existing install found — updating)"
fi

# Copy everything except VCS/OS cruft.
mkdir -p "$DEST_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.git' --exclude '.DS_Store' --exclude 'node_modules' \
    "$SRC_DIR"/ "$DEST_DIR"/
else
  cp -R "$SRC_DIR"/. "$DEST_DIR"/
fi

echo
echo "Done. Claude Code will discover the skill on next start."
echo "Try it with a prompt like:"
echo "  \"Audit this React Native app for performance and give me a client-ready report.\""
