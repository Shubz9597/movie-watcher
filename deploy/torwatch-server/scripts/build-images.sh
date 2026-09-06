#!/usr/bin/env bash
# Build multi-arch images (FR-009) with an immutable version tag (T061).
# Usage: build-images.sh <version>   e.g. build-images.sh 1.0.0
set -euo pipefail

VERSION="${1:?usage: build-images.sh <version>}"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTEXT="$REPO_ROOT"
DOCKERFILE="$REPO_ROOT/deploy/torwatch-server/Dockerfile"
IMAGE="torwatch-server:${VERSION}"

echo "[build] $IMAGE (linux/arm64 + linux/amd64) from $CONTEXT"
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --build-arg "TORWATCH_VERSION=${VERSION}" \
  -f "$DOCKERFILE" \
  -t "$IMAGE" \
  -t "torwatch-server:linux-amd64-${VERSION}" \
  --push \
  "$CONTEXT"

echo "[build] pushed $IMAGE (immutable; never rebuild the same tag)"
