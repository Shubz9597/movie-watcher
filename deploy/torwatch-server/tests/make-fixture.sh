#!/usr/bin/env bash
# Generates the disposable 1 MiB range-check fixture (random bytes, so no
# binary lands in git). Run once before the fixture stack:
#
#   bash tests/make-fixture.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixture
dd if=/dev/urandom of=fixture/movie.bin bs=1048576 count=1 status=none
echo "wrote $(pwd)/fixture/movie.bin ($(wc -c < fixture/movie.bin) bytes)"
