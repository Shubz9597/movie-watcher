# Quickstart: Validating TorWatch V2 BFF

**Feature**: `001-build-torwatch-version` | **Date**: 2026-09-04

Runnable validation scenarios proving the spec end-to-end. Commands are exact; expected
outcomes are the acceptance evidence. Implementation order and task breakdown live in
`tasks.md` (later); contract details live in [contracts/](./contracts/) and
[data-model.md](./data-model.md).

## Prerequisites

- Windows dev host: Go 1.24.2, Node/npm, Docker Desktop (for Compose dependencies).
- PostgreSQL + Prowlarr reachable (V1 root `docker-compose.yml` is the local dev stack;
  Electron normally owns its lifecycle).
- For Radxa scenarios (Q): a ROCK 3A 4 GB host with the `deploy/torwatch-server/`
  release bundle (available after phase P7).

## 0. Baseline protection (phase P0 gate)

```powershell
Set-Location torrent-streamer
go test ./...
go vet ./...

Set-Location ..\electron-app
npm test

Set-Location ..
docker compose config
```

Expected: all green (or pre-existing failures documented in the P0 baseline report —
never hidden). The new characterization tests must pass on the untouched V1 code.

## 1. System endpoints and negotiation (P1/P6)

```powershell
# Launch the backend locally (LISTEN=127.0.0.1:4001, V1 env contract)
Invoke-RestMethod http://127.0.0.1:4001/healthz        # {"status":"ok"}  (byte-identical to V1)
Invoke-RestMethod http://127.0.0.1:4001/readyz         # {"status":"ok","components":{...}}
Invoke-RestMethod http://127.0.0.1:4001/v1/version     # serverVersion, revision, builtAt,
                                                       # protocolVersion, supportedProtocolRange,
                                                       # capabilities, goVersion, os, arch
```

Expected (SC-004, `contracts/protocol-negotiation.md`): `/healthz` body unchanged;
`/v1/version` carries protocol range + capabilities; `/readyz` reports component state
and returns 503 when PostgreSQL is stopped.

## 2. Catalog BFF journey — bare API client (P3, SC-001)

```powershell
# Search (no provider access in the client; degradation fields present)
Invoke-RestMethod "http://127.0.0.1:4001/v2/catalog/search?q=frieren&type=all&clientId=11111111-1111-4111-8111-111111111111"

# Title detail + episodes
Invoke-RestMethod "http://127.0.0.1:4001/v2/catalog/titles/tmdb:209867?clientId=…"
Invoke-RestMethod "http://127.0.0.1:4001/v2/catalog/titles/tmdb:209867/episodes?season=1&clientId=…"

# Source pick → stream → progress → resume via the V1 surface (unchanged contracts)
Invoke-RestMethod -Method Post http://127.0.0.1:4001/v1/torrents/search -Body '{"query":"frieren"}' -ContentType application/json
Invoke-RestMethod -Method Post http://127.0.0.1:4001/v1/torrents/resolve -Body '{"sourceId":"…"}' -ContentType application/json
# GET /stream?magnet=…&fileIndex=… with Range: bytes=0-1023  → 206, exactly 1024 bytes
# POST /v1/session/heartbeat …  → {"ok":true}
# GET  /v1/resume?subjectId=…&seriesId=…        → {"found":true,…,"position_s": <saved - 15>}
```

Expected: complete journey using only backend endpoints; provider outage during any
catalog call yields `degraded:true` results or `503 providers_unavailable` — never a
hang or opaque error (spec Edge Case 1).

## 3. Two clients, one backend (P6, SC-002)

1. Start the Electron app (client A) and `torrent-streamer/tools/reference-client/`
   (client B) against the same deployment.
2. Both run the journey from §2 (Electron via its UI, B via the CLI).

Expected: both succeed using the same endpoints/contracts; progress saved by A is
resumed by B (shared household subject); concurrent playback of the same title works
via shared leases (`/watch/open` from both → both `leaseId`s, `activeLeases: 2`); a
second DISTINCT title stream beyond the configured admission limit gets
`503 capacity_exceeded` with retry guidance while the healthy streams keep playing.

## 4. Multi-client progress ordering (P7, FR-006)

```powershell
# Interleave heartbeats from two clients (clientId/sessionId/seq)
# A: seq 10 (position 600)  →  accepted
# B: seq 5  (position 300)  →  accepted (different session, commit-order LWW)
# A: seq 9  (position 700, delayed retry) → {"ok":true,"ignored":"stale_seq"}
# A: seq 11 (position 120, deliberate rewind) → accepted
```

Expected: stored position reflects server commit order; the delayed retry does NOT move
progress backward; the deliberate rewind DOES; `progress_revision`, `writer_client_id`,
`stream_session_id` recorded in `watch_progress`. `GET /v1/resume` still rewinds 15 s.

## 5. Migration-safety invariants (every phase exit)

```powershell
Set-Location torrent-streamer; go test ./...; go vet ./...
Set-Location ..\electron-app;  npm test
Set-Location ..; rg "localhost:4001" electron-app/src electron-app/electron --glob '!**/api-client.ts'
```

Expected: full suites green at every phase exit (constitution principle II); the grep
gate is clean from P2 onward (no hardcoded base URLs in product code). Any behavior
difference observed during a phase must trace to an approved, specified contract change
— otherwise the phase stops for regression diagnosis (constitution: unexplained
baseline regression halts restructuring).

## 6. Homeserver deployment + persistence (P7, SC-004/SC-005)

Follow `docs/v2-server-package/radxa-runbook.md` on the ROCK 3A (or AMD64 host first):
install the release bundle, verify health/readiness/version from a second LAN machine,
then:

- Restart every container → progress, picks, Prowlarr config, subtitle cache survive.
- Update to a new immutable tag (with pre-update backup) → data preserved, verification
  passes.
- Roll back to the prior tag → data preserved (migration 005 is additive; pre-005
  binaries still run).
- 30-minute direct playback + seek checks; record CPU/memory; no OOM termination.

Expected: all applicable checks in `docs/v2-server-package/acceptance-tests.md` §4–§8
pass with a recorded test report; verdict `pass`.

## 7. Removal-gate evidence (P8)

For each retired item (renderer provider HTTP code, dead env keys, dormant V1 routes
with passed gates): the gate evidence (no remaining consumer + contract tests green +
owner approval) is recorded in the phase report before deletion. Expected: zero
unexplained regressions in the final full-suite run; release candidate passes its
acceptance report.
