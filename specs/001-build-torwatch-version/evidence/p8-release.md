# Release report — torwatch-server 2.0.0-rc.1

Template per docs/v2-server-package/acceptance-tests.md §1.

```text
Version:            2.0.0-rc.1
Git revision:       1f56e0b (branch 001-build-torwatch-version)
                    baseline for this session: e6bb8fa
Bundle checksum:    torwatch-server-2.0.0-rc.1-bundle.tar.gz
                    sha256 43540729fcad00d008e3dfe8e85070303844382a77427c9c4894e70afbcde19a
                    (git archive HEAD deploy/torwatch-server at 1ef14e4; the
                    archive embeds the ref, so re-cut bundles pin the commit)
Application image:  torwatch-server:2.0.0-rc.1 (local build, revision 1f56e0b,
                    builtAt 2026-09-26T20:24:07Z)
                    image ID sha256:cd0fc4092e91e13e19dd15303da0453e27e89d3977bb0f82925638e6b4f76708
                    (local builds carry the ID as their only "digest"; the
                    registry digest is recorded at push time by
                    build-images.sh --push — no registry credentials on this PC)
Dependency images:  postgres:16.9-alpine
                    lscr.io/linuxserver/prowlarr:2.6.5
                    ghcr.io/flaresolverr/flaresolverr:v3.5.0
                    caddy:2.10.0-alpine
                    qmcgaw/gluetun:v3.40.0 (VPN overlay only)
                    (tag existence verified against the registries; resolved
                    digests recorded at release push)
Host:               Windows PC, Docker Desktop 4.x / engine 28.3.2, Linux
                    containers, Compose v2.39.1; Go 1.24.2, Node 22.14
Deployment mode:    direct (live) + embedded-vpn (config-render only)
Verdict:            PASS for Windows-PC scope; Fedora/ARM64 hardware gates open
```

## Commands and results (this session, in order)

Baseline (recorded before changes, at e6bb8fa): `go vet ./...` exit 0;
`go test ./...` all packages ok; `npm test` 0 failures; direct compose config
renders; `compose.vpn.yaml` MISSING (confirmed blocker).

Implementation verification (final state, revision 1f56e0b):

| Check | Result |
| --- | --- |
| `go vet ./...` | PASS (exit 0) |
| `go test ./...` | PASS (all packages) |
| `go test -race ./...` | **BLOCKED on this PC** — requires CGO + gcc (no C toolchain installed); must run on the Fedora machine |
| `npm test` | PASS (0 failures across all suites) |
| `docker compose config` (root, untouched) | PASS |
| package direct-mode `compose config --quiet` | PASS |
| package VPN-mode `compose config --quiet` (test creds) | PASS |
| `scripts/tests/run-tests.sh` (26 script regression tests, stubbed Docker) | PASS 26/26 |
| gofmt | PASS (bootstrap package; cmd/vod CRLF-only delta is checkout autocrlf, LF in repo) |

## Image tests (native AMD64 + QEMU ARM64)

- linux/amd64 image builds from clean checkout — PASS
- linux/arm64 image builds from the same revision (binfmt/QEMU) — PASS
- ARM64 binary executes natively: container logs report
  `platform=linux arch=arm64` — PASS (emulated execution; hardware pending)
- `/v1/version` reports serverVersion/revision/builtAt/protocol/range/arch —
  PASS (embedded via declared ARG ldflags)
- Process runs as uid 1000 (non-root) — PASS
- Image contains ca-certificates + tzdata + healthcheck binary — PASS
- HEALTHCHECK healthy; STOPSIGNAL SIGTERM; `docker stop` performs graceful
  shutdown ("shutdown requested" → "shutdown complete", exit 0) — PASS
- Image contains no .env/secrets/logs — PASS (build context = torrent-streamer
  source only, .dockerignore excludes tests)
- Multi-architecture manifest push + vulnerability/secret scan — PENDING
  (requires registry credentials and a scanner; release-time step)

## Disposable-stack integration tests (direct mode, live)

Cold start → ready: 10–33 s (documented bound: < 120 s). Prowlarr bootstrap
resolved the generated key from the read-only config mount and installed the
starter indexers (6/7 added; TorrentDownload rejected by Prowlarr's own
upstream connectivity test — non-fatal, recorded, same behavior as V1).
Bootstrap idempotency across restarts: preserved=N added=0 failed=0.

- Only gateway published: `0.0.0.0:18080→8080` (+`[::]`); Prowlarr
  `127.0.0.1:19696→9696` loopback; postgres/flaresolverr/vod publish nothing —
  PASS (verify.sh port audit)
- /healthz byte-exact, /readyz 200, /v1/version full payload — PASS
- Byte-range through the gateway: `Range: bytes=0-1023` → 206, exactly 1024
  bytes, Content-Range/Accept-Ranges preserved; mid-file range exact; invalid
  range 416; HEAD 206 headers without body — PASS (disposable fixture route)
- SSE first tick immediate (`retry: 2000`) through the gateway — PASS
- Restart persistence: `compose restart` and full `down`/`up` recreate both
  preserve the DB marker row, subtitle cache, and Prowlarr config — PASS
- backup → mutate → restore: checksums validated before writers stop; DB row
  revert (99/77 → 42), Prowlarr config and subtitle archive restored; failed
  restore retains pre-restore state; failed/empty dumps never produce a
  "successful" backup — PASS (after fix: restore recreates containers so
  replaced bind-mount directories re-resolve — defect found live, fixed)
- update → failed verification → automatic rollback: rc.1 → broken image
  (verify fails) → automatic rollback to rc.1 → healthy — PASS; unpullable
  unknown tag aborts without touching the stack — PASS
- Data root is bind-mounted TORWATCH_DATA_DIR tree — PASS (named volumes
  removed)
- Secrets only in .env; no secrets in compose render, labels, or healthcheck
  output — PASS

## Skipped / pending (with reasons)

- Live embedded-VPN mode: no VPN credentials on this PC. Overlay renders and
  passes `compose config`; the Gluetun egress/kill-switch checks
  (acceptance §6 networking) remain OPEN for a credentialed run.
- Radxa ROCK 3A hardware acceptance (§8, T063): hardware unavailable here.
- `go test -race`: needs a C toolchain (run on Fedora).
- Multi-arch manifest push, digest recording, vulnerability + secret scans:
  need registry credentials + scanner.
- LAN-side isolation from a second physical host (§6 networking): needs a
  second device on the target network.
- Long-run 30-minute stream, real-indexer search, OpenSubtitles/IMDb live
  checks: credential- or hardware-dependent.

## Verdict

`pass` for the Windows-PC release-candidate scope defined above; the package
is **ready for Fedora testing**. "Ready for main" additionally requires the
open hardware/credential gates listed above.
