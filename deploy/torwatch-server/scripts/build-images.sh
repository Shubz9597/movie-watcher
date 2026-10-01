#!/usr/bin/env bash
# Multi-arch image build (FR-009) with immutable version tags.
#
# Usage:
#   build-images.sh <version> [--push] [--platforms <list>]
#
# Defaults build the NATIVE platform only and LOAD it into the local Docker
# image store — the safe Windows PC / laptop path (no registry, no push):
#
#   scripts/build-images.sh 1.0.0
#
# Release path (maintainer with registry credentials) builds and pushes both
# architectures as one immutable manifest:
#
#   scripts/build-images.sh 1.0.0 --push --platforms linux/amd64,linux/arm64
#
# The image repository defaults to torwatch-server; override with
# TORWATCH_IMAGE_REPO (e.g. ghcr.io/example/torwatch-server).
set -euo pipefail

VERSION="${1:?usage: build-images.sh <version> [--push] [--platforms <list>]}"
shift || true

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CONTEXT="$REPO_ROOT/torrent-streamer"
DOCKERFILE="$REPO_ROOT/deploy/torwatch-server/Dockerfile"
IMAGE_REPO="${TORWATCH_IMAGE_REPO:-torwatch-server}"
IMAGE="${IMAGE_REPO}:${VERSION}"

PUSH=0
PLATFORMS="linux/$(docker version --format '{{.Client.Arch}}' | sed 's/arm64/arm64/;s/amd64/amd64/;s/x86_64/amd64/;s/aarch64/arm64/')"
while [ $# -gt 0 ]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --platforms) PLATFORMS="${2:?--platforms requires a value}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

REVISION="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "[build] $IMAGE"
echo "[build]   revision=$REVISION builtAt=$BUILT_AT platforms=$PLATFORMS push=$PUSH"

BUILD_ARGS=(
  --platform "$PLATFORMS"
  --build-arg "TORWATCH_VERSION=${VERSION}"
  --build-arg "TORWATCH_REVISION=${REVISION}"
  --build-arg "TORWATCH_BUILT_AT=${BUILT_AT}"
  -f "$DOCKERFILE"
)

if [ "$PUSH" -eq 1 ]; then
  docker buildx build "${BUILD_ARGS[@]}" -t "$IMAGE" --push "$CONTEXT"
  echo "[build] pushed $IMAGE"
  echo "[build] digest (record in the release report):"
  docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest.Digest}}' || \
    docker buildx imagetools inspect "$IMAGE"
else
  docker buildx build "${BUILD_ARGS[@]}" -t "$IMAGE" --load "$CONTEXT"
  echo "[build] loaded $IMAGE locally (never rebuild the same immutable tag after release)"
  echo "[build] local image id: $(docker image inspect --format '{{.Id}}' "$IMAGE" 2>/dev/null || echo '?')"
fi
