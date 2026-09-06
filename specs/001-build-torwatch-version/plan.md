# Implementation Plan: TorWatch Version 2 — Shared Backend and BFF for Multiple Clients

**Branch**: `001-build-torwatch-version` | **Date**: 2026-09-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-build-torwatch-version/spec.md` (including the 2026-09-04 Clarifications session).

## Summary

Extend the existing Go modular monolith in `torrent-streamer/` into a client-neutral
Backend-for-Frontend: server-side catalog aggregation (TMDb, AniList/Jikan, Cinemeta,
AniZip/Kitsu move out of the Electron renderer), protocol-range/capability negotiation,
shared per-title watch leases with a deterministic capacity admission policy, and
server-ordered (last-write-wins) progress updates. Version 2 lands as a sequence of
small vertical increments: characterize V1 behavior with tests first, implement the new
BFF path beside the old one, migrate one client at a time (Electron first, then a minimal
reference client), and remove obsolete code only after documented removal gates pass.
Deployment target is a private Linux homeserver (ARM64 Radxa ROCK 3A 4 GB / AMD64)
per `docs/v2-server-package/`, with cloud portability preserved through clean
configuration/storage boundaries but not claimed as a capability.

## Technical Context

**Language/Version**: Go 1.24.2 (`torrent-streamer/go.mod`); TypeScript/JavaScript (Electron renderer, Vite, React) in `electron-app/`; SQL migrations in `torrent-streamer/migrations/` (embedded, ordered, applied via `schema_migrations`).

**Primary Dependencies**: `github.com/anacrolix/torrent` (torrent client), PostgreSQL via `database/sql` + pgx (state), Prowlarr/Torznab (discovery), OpenSubtitles (subtitles), plain `net/http` `ServeMux` (no router framework). New in V2: backend-side HTTP clients for TMDb, AniList (GraphQL), Jikan, Cinemeta, AniZip/Kitsu with bounded caching; no new frameworks — stdlib-first.

**Storage**: PostgreSQL (existing tables `watch_progress`, `continue_dismissals`, `series`, `episodes`, `devices`, `picks`, `search_cache`, `imdb_ratings`, `dataset_imports`; new tables for provider cache, no destructive changes; expand-migrate-contract for progress columns).

**Testing**: `go test ./...` (plus `-race` per `docs/v2-server-package/acceptance-tests.md`), `node --test` suites in `electron-app/` (`npm test`), new Go `httptest` contract tests for every in-scope route, new characterization tests for the Electron renderer aggregation logic before it is ported, disposable Compose-stack integration checks, and Radxa hardware acceptance per the handoff.

**Target Platform**: Private Linux homeserver — first target Radxa ROCK 3A (ARM64, 4 GB RAM, SSD/NVMe), same artifacts on Linux AMD64. Windows local V1 build-and-launch flow (`torWatcher.exe` + Electron-owned root Compose) must keep working until its removal gate passes. Trusted LAN/private overlay only.

**Project Type**: Single Go backend service (modular monolith) + one existing Electron client + one minimal test/reference client. No microservices split (spec Assumption).

**Performance Goals**: One guaranteed active distinct-title stream (one torrent/resource set plus background refresh) on the 4 GB host with no OOM termination; same-title concurrent clients share torrent/buffer resources; additional different-title streams best-effort via deterministic, configurable admission (distinct active resource keys, not memory guesses); byte-range streaming and SSE latency no worse than V1 (gateway must not buffer media or SSE).

**Constraints**: Zero unexplained regressions (not permanent API identity); characterization tests before refactoring; new path verified before old path removal; one client migrated at a time; secrets/magnets redacted from logs; trusted-LAN security posture (auth strictly deferred, FR-013); root `docker-compose.yml` never repurposed; generated directories never edited as source; `torWatch` naming and `DESIGN.md` for visual changes.

**Scale/Scope**: Household scale — a handful of concurrent clients, one deployment, LAN latency. In scope: BFF catalog endpoints, version/capability system endpoints, lease/progress multi-client semantics, reference client, server package integration. Out of scope (FR-013/FR-014): authentication, opaque stream sessions, public exposure, HLS/transcoding, polished mobile products.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle (Constitution v2.0.0) | Gate Question | Status | Evidence / Plan Response |
|---|---|---|---|---|
| 1 | Preserve Core Product Outcomes | Does every phase keep a complete working search→source→stream→subtitle→progress→resume path? | PASS | All catalog work is additive behind `/v2/catalog/*` and flag-gated in the renderer; the V1 path keeps working until each consumer is migrated and verified (Phases P0–P6 exit gates). |
| 2 | Working Software at Every Checkpoint | Small increments, never big-bang; new path implemented and verified before old removal; adapters/flags for coexistence? | PASS | Phase ordering is characterize → implement → verify → migrate one consumer → remove after gate. Renderer migration uses a runtime flag so old and new catalog paths coexist (P5); obsolete renderer provider code is deleted only after the P6 removal gate. |
| 3 | Shared BFF, Explicit Client Boundaries | Do clients consume versioned contracts with no divergent shared business rules? First deployment private homeserver; cloud not claimed? | PASS | `contracts/` defines the `/v2` versioned BFF contract and the V1 compatibility surface; renderer provider logic moves server-side; deployment follows `docs/v2-server-package/` (private LAN, cloud portability only). |
| 4 | Evidence and Migration Maps Before Change | Baseline commit/results recorded; per-move migration map with old owner, new owner, consumers, compatibility mechanism, verification, removal gate, rollback? | PASS | Phase P0 records baseline (commit, suites, route inventory); every phase below carries a Migration Map section with those fields. |
| 5 | Tests Define the Safe Change Boundary | Characterization/contract tests exist at each changed boundary before restructuring; regression test per defect; suites not weakened? | PASS | P0 adds Go `httptest` route contract tests and Electron aggregation characterization tests before any port; every phase lists exact verification commands; no existing tests deleted or weakened (only superseded after an approved spec change, which is documented). |
| 6 | Operability and Secrets Are Product Requirements | Logs/redaction/health/readiness preserved; backup/restore/update/rollback functional? | PASS | P1 adds `/readyz` + `/v1/version` without changing `/healthz` semantics; `/stats` diagnostics preserved; redaction tests extended to new paths; server package backup/restore/update/rollback adopted from the handoff (P7). |

**Pre-Phase-0 verdict: PASS — no violations requiring justification.** Post-design re-check recorded at the bottom of this file.

## Project Structure

### Documentation (this feature)

```text
specs/001-build-torwatch-version/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── v1-compat.md                 # Frozen-during-migration V1 surface + removal gates
│   ├── v2-catalog-api.md            # Versioned BFF catalog contract
│   ├── protocol-negotiation.md      # Version payload, ranges, capabilities, error codes
│   └── leases-and-progress.md       # Shared leases, capacity admission, progress ordering
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
torrent-streamer/                  # Existing Go modular monolith — extended, not replaced
├── cmd/vod/                       # Entry point: mux assembly, lease manager wiring
├── internal/
│   ├── buildinfo/                 # NEW: version, revision, build time, protocol range, capabilities
│   ├── config/                    # EXTEND: package-safe server config (V1 env names still accepted)
│   ├── catalog/                   # NEW: server-side provider clients, merge rules, TTL cache
│   │   ├── provider.go            #      Provider interface + registry + deterministic merge
│   │   ├── tmdb.go, anilist.go, jikan.go, cinemeta.go, anizip.go   # thin HTTP adapters
│   │   └── cache.go               #      bounded TTL cache (provider outage degradation)
│   ├── httpapi/
│   │   ├── catalog_handlers.go    # NEW: /v2/catalog/* handlers + contract tests
│   │   ├── system_handlers.go     # NEW: /readyz, /v1/version handlers + contract tests
│   │   ├── session.go             # EXTEND: server-ordered progress writes (revision, client_id, session)
│   │   └── handlers.go            # EXTEND: stream auto-save reconciliation markers
│   ├── watch/
│   │   ├── watchmgr.go            # EXTEND: lease records gain client_id + session correlation
│   │   └── progress_sql.go        # EXTEND: LWW-by-commit-order + seq guard (migration 005)
│   └── admission/                 # NEW: distinct-key capacity admission policy (configurable)
├── migrations/
│   └── 005_progress_multiclient.sql   # NEW: expand phase (additive columns/indexes only)
└── tools/reference-client/        # NEW: minimal Go test/reference client (P2 journey, protocol demo)

electron-app/                      # Client 1: migrated incrementally, never broken
├── src/lib/api-client.ts          # EXTEND: configurable base URL (default http://localhost:4001)
├── src/lib/services/              # catalog services become thin adapters over /v2/catalog/*
├── electron/config/               # catalogFlag runtime flag wiring
└── scripts/                       # characterization tests for current aggregation logic (pre-port)

deploy/torwatch-server/            # NEW: server package per docs/v2-server-package/ (P7)
├── compose.yaml, compose.vpn.yaml, .env.example, Caddyfile, README.md
└── scripts/ (preflight, backup, restore, update, verify)

docs/v2-server-package/            # Authoritative packaging handoff — adopted, not duplicated
```

**Structure Decision**: Extend the single existing Go module (`torrent-streamer/`) with new
`internal/catalog`, `internal/admission`, and `internal/buildinfo` packages rather than
creating a second backend (spec Assumption; Constitution principle II). The Electron app
remains the first client and is migrated consumer-by-consumer behind a runtime flag. A
minimal Go `tools/reference-client/` provides the second-client proof (SC-002) without
shipping a polished product (spec Assumption). The deployment package is adopted from
`docs/v2-server-package/` as planned (`deploy/torwatch-server/`) in its own phase so the
BFF work never depends on unlanded packaging.

## Technical Directions & Bottlenecks

1. **Server-side catalog aggregation** — port the renderer's provider modules
   (`electron-app/src/lib/services/tmdb-service.ts`, `anilist-service.ts`,
   `jikan-service.ts`, `cinemeta-service.ts`, `anime-episode-metadata-service.ts`,
   aggregation in `anime-catalog.ts`/`anime-matching.ts`/`adapters/media.ts`) into
   `internal/catalog` behind one `Provider` interface with deterministic merge rules and
   a bounded TTL cache so provider outages degrade gracefully (spec Edge Case 1).
   Characterization tests for the current merge/matching logic are added in
   `electron-app/scripts/` BEFORE the port; parity tests keep Go output equivalent.
2. **Client-neutral surface** — new endpoints live under `/v2/catalog/*` with
   provider-opaque identifiers (mirroring how `/v1/torrents/search` already hides indexer
   credentials behind `sourceId`). No endpoint may require Electron, a platform, or
   renderer-resident credentials (FR-003).
3. **Version/capability negotiation** — `internal/buildinfo` supplies version, revision,
   build time, `protocolVersion`, `supportedProtocolRange`, and capability flags served by
   `/v1/version` (name per handoff architecture §10) and `/readyz`; `/healthz` semantics
   unchanged (V1 consumers depend on the constant `{"status":"ok"}` body). Clients decide;
   the server returns machine-readable `unsupported_protocol` / `unsupported_capability`
   errors for requests it cannot serve (spec Clarification 4).
4. **Shared leases and capacity admission** — revive the dormant `/watch/*` machinery as
   the multi-client primitive, keeping V1 semantics (per `cat|infoHash|fileIndex` key,
   multiple concurrent leases, release only when all leases expire/go stale). Add
   `client_id` (untrusted opaque UUID, format-validated) to lease records for
   correlation. New `internal/admission` enforces the configurable distinct-key limit and
   rejects only NEW stream/lease requests with `capacity_exceeded` + retry guidance
   (spec Clarifications 1 & 5).
5. **Server-ordered progress** — migration `005_progress_multiclient.sql` expands
   `watch_progress` with additive columns (`progress_revision BIGINT`, `writer_client_id`,
   `stream_session_id`, per-session sequence support). `SaveProgressUpdate` keeps
   last-write-wins by server commit order (never client timestamps), rejects
   out-of-order sequence numbers within one stream session, and records the writer.
   Furthest-position-wins is prohibited (intentional rewind must keep working).
6. **Progress write-path reconciliation** — `/stream` auto-save (byte-ratio estimate) is
   marked as low-fidelity and MUST NOT regress renderer heartbeats (`/v1/session/heartbeat`);
   both paths go through the same ordered write path so a delayed retry cannot move
   progress backward.
7. **Configurable base URL before migration** — the renderer's ~8 hardcoded
   `http://localhost:4001` call sites plus CSP in 4 HTML files are collapsed onto
   `api-client.ts` (default unchanged) BEFORE any consumer is repointed; this is a pure
   refactor verified by existing suites + new characterization tests.
8. **Deployment** — `deploy/torwatch-server/` per the handoff: single gateway (no media
   buffering), bind-mounted state, package-owned Prowlarr bootstrap, backup/restore/
   update/rollback scripts, ARM64+AMD64 images, immutable tags. Resource measurements on
   the ROCK 3A gate the release; the admission default is tuned to the measured envelope.

## Phased Delivery (vertical increments)

Each phase is a working, reviewable increment: it compiles, passes focused checks, and
ends with full affected-suite verification and a recorded result. Rollback for every
phase is `git revert` of the phase's commits plus (where applicable) the documented data
rollback; no phase requires a database down-migration because all schema work is additive
until its contract phase, which only runs after the new code is proven.

### P0 — Baseline and characterization (protect the truth)

- **Outcome**: The repository's current behavior is recorded and locked by tests. No
  behavior changes.
- **Work**: Record baseline commit, `go test ./...`, `go vet ./...`, `npm test`,
  `docker compose config` results. Add Go `httptest` contract tests capturing route-by-route
  request/response shapes for every V1 route in the inventory (search, resolve, stream
  headers/206/416, subtitles list/torrent/external, session heartbeat/resume/continue,
  buffer state/info JSON+one SSE tick, healthz, watch open/ping/close). Add Electron
  characterization tests for catalog merge/matching outputs (fixed provider fixtures).
  Document dormant routes (`/add`, `/prefetch`, `/stats`, `/v1/session/start|ended`,
  `/v1/resume/source/probe`, `/v1/resume.m3u`, `/watch/*`) and
  their in-repo consumers (none) — they are preserved until each gets an explicit removal
  gate. Correction (P0 evidence D-1): `/subtitles/configure` is live, not dormant —
  `electron-app/electron/ipc/setup-ipc.js:166` consumes it.
- **Verification**: `Set-Location torrent-streamer; go test ./...; go vet ./...`;
  `Set-Location ../electron-app; npm test`; new suites pass; baseline report committed
  under `specs/001-build-torwatch-version/` evidence notes in tasks.
- **Exit gate**: All characterization tests green on the untouched baseline; any
  pre-existing failure documented, not hidden.
- **Rollback**: Delete the added test/evidence files (no behavior changed).

### P1 — Server foundation: config, buildinfo, system endpoints (additive)

- **Outcome**: Headless-safe configuration and a truthful version/capability surface
  exist; V1 local launch behavior unchanged.
- **Work**: `internal/config` package-safe server settings (V1 env names accepted;
  container defaults via deployment env only); `internal/buildinfo` (semver, revision,
  builtAt, `protocolVersion: 1`, `supportedProtocolRange: [1,1]`, capability flags e.g.
  `catalog.bff.v2`, `leases.shared`, `progress.serverOrdered`); `GET /readyz` (component
  state, 503 when PostgreSQL unavailable, non-secret status); `GET /v1/version`. `/healthz`
  response body unchanged.
- **Migration map**: old owner: none (greenfield surface) + `main.go` env reads; new
  owner: `internal/config`, `internal/buildinfo`, `internal/httpapi/system_handlers.go`;
  consumers: Electron readiness probe (`/healthz` — untouched); compatibility: additive
  routes only; removal gate: N/A (new); rollback: remove handlers/packages; no data.
- **Verification**: `go test ./internal/config/... ./internal/httpapi/... -run 'System|Config'`;
  `go test ./...`; Electron `npm test`; manual: local backend starts and `/v1/version`
  returns the full payload while `/healthz` body is byte-identical to P0 capture.
- **Exit gate**: New unit tests green; full affected suites green; V1 smoke unchanged.

### P2 — Client-neutral transport groundwork in Electron (pure refactor)

- **Outcome**: All renderer backend calls flow through one configurable base URL;
  Electron behavior is byte-for-byte identical when the default is used.
- **Work**: Collapse hardcoded `localhost:4001` call sites and CSP entries onto
  `api-client.ts` + build-time default; keep `BACKEND_URL`/`LISTEN=127.0.0.1:4001`
  launch contract. No endpoint changes.
- **Migration map**: old owner: 8 scattered renderer constants; new owner:
  `src/lib/api-client.ts`; consumers: every renderer backend caller; compatibility:
  default value identical; verification: `npm test` + manual search→playback smoke;
  removal gate: zero remaining hardcoded base URLs (grep gate); rollback: revert commit.
- **Verification**: `Set-Location electron-app; npm test`; grep gate
  `rg "localhost:4001" src electron --glob '!api-client.ts'` returns no product-code hits;
  manual smoke: launch, search, stream, resume.
- **Exit gate**: Suites green + manual smoke passes + grep gate clean.

### P3 — Catalog framework and `/v2/catalog/*` (new, inactive until P4/P5)

- **Outcome**: The backend can serve unified search/detail/sections from all five
  providers with deterministic merge and outage degradation; no client uses it yet.
- **Work**: `internal/catalog` (provider interface, adapters, deterministic merge with
  fixed tie-break ordering, bounded TTL cache, per-provider timeouts/degradation);
  `/v2/catalog/search`, `/v2/catalog/titles/{id}`, `/v2/catalog/titles/{id}/episodes`,
  `/v2/catalog/sections` handlers + contract tests (see `contracts/v2-catalog-api.md`);
  identifiers opaque (`tmdb:123`, `anilist:456`), merge deterministic per query.
- **Migration map**: old owner: Electron renderer services (still active, untouched);
  new owner: `internal/catalog`; consumers: none yet (P4/P5 migrate them);
  compatibility: additive `/v2` namespace; removal gate: N/A (new); rollback: remove
  package/routes; no data impact beyond cache table.
- **Verification**: `go test ./internal/catalog/... ./internal/httpapi/... -run Catalog`;
  `go test ./...`; manual curl against a disposable stack with stub/real providers.
- **Exit gate**: Contract tests green including provider-outage degradation cases;
  full suite green.

### P4 — Parity: Electron aggregation vs backend aggregation

- **Outcome**: Proven behavioral parity between the characterized renderer logic and the
  backend implementation on the same fixtures.
- **Work**: Golden-fixture parity tests: identical provider payloads in → equivalent
  catalog rows out (Go vs the P0 characterization fixtures). Differences are reconciled
  in code or documented as intentional V2 contract evolution (each with a spec
  reference).
- **Verification**: parity test suite `go test ./internal/catalog/ -run Parity`;
  `npm test` (renderer characterization tests still green).
- **Exit gate**: Parity suite green; documented variance list reviewed against spec.

### P5 — Electron catalog migration (one consumer, flag-gated)

- **Outcome**: The Electron app fetches catalog data exclusively from the backend behind
  a runtime flag; user-visible experience equivalent to V1.
- **Work**: Renderer catalog services become adapters over `/v2/catalog/*`; runtime flag
  `catalogSource=renderer|bff` (default `renderer`); flip default to `bff` only after
  end-to-end verification; renderer provider HTTP code retained (inactive) until the
  removal gate; TMDb IPC/Gluetun transport tests preserved for the flag-off path.
- **Migration map**: old owner: renderer provider services + main-process TMDb transport;
  new owner: backend `/v2/catalog/*` via adapters; consumers: Electron (single client,
  verified end to end); compatibility: flag retains the old path; removal gate: flag
  `bff` verified across a full release cycle AND backend parity suite green AND owner
  approval recorded → delete renderer provider HTTP code + CSP provider hosts; rollback:
  flip flag to `renderer` (instant) and/or revert commits.
- **Verification**: `npm test`; manual full journey (search → detail → episodes →
  source → playback → subtitle → resume) with flag `bff`; repeat with `renderer`;
  then default-flip verification.
- **Exit gate**: Flag-default `bff` with zero P1-level regressions; suites green;
  V1-equivalent catalog experience confirmed against P0 characterization outputs.

### P6 — Protocol negotiation clients + minimal reference client (second consumer)

- **Outcome**: Two different clients complete the same journey against one backend
  (SC-002); negotiation is implemented, not just advertised.
- **Work**: Electron reads `/v1/version` at startup and gates workflows on range overlap
  (health/version discovery always accessible). `tools/reference-client/` — a small Go
  CLI completing search → detail → source → stream → progress → resume using only public
  endpoints and negotiation. Reference client is a test harness (not a shipped product).
- **Migration map**: old owner: none; new owner: reference client + Electron bootstrap
  check; consumers: both clients verified independently; compatibility: no V1 contract
  touched; removal gate: N/A; rollback: revert.
- **Verification**: `go test ./tools/reference-client/...`; manual dual-client run per
  `quickstart.md` (two clients, one shared title, shared resume observable);
  `npm test`; `go test ./...`.
- **Exit gate**: SC-001 and SC-002 demonstrated and recorded; suites green.

### P7 — Multi-client leases, ordered progress, server package

- **Outcome**: Concurrent clients are safe by construction (shared leases, ordered
  progress, capacity admission) and the homeserver package deploys and survives
  restart/upgrade/rollback.
- **Work**: (a) Migration `005_progress_multiclient.sql` (expand: additive columns +
  index on `(subject_id, series_id, updated_at)` — already partially present; no
  destructive change); ordered `SaveProgressUpdate` with per-session sequence guard and
  regression tests (delayed heartbeat retry must not rewind; deliberate rewind must
  work). (b) `/watch/*` records gain `client_id`; `/watch/open` returns
  `capacity_exceeded` when the distinct-key limit is hit; `/stats` reports active keys
  for admission observability. (c) Adopt `docs/v2-server-package/` implementation plan:
  `deploy/torwatch-server/` bundle, package Prowlarr bootstrap, gateway config (no
  media/SSE buffering), backup/restore/update/rollback scripts, multi-arch images,
  immutable tags. (d) ROCK 3A measurements; set admission default to the measured
  envelope (one distinct title guaranteed).
- **Migration map**: old owner: `watch.Store.SaveProgressUpdate` (LWW), dormant lease
  endpoints, Electron-owned local-only deployment; new owner: ordered write path +
  revived lease records + `internal/admission` + `deploy/torwatch-server/`; consumers:
  Electron (verified first), reference client (verified second);
  compatibility: request/response shapes of `/v1/session/heartbeat`, `/v1/resume`,
  `/watch/*` extended only additively (`clientId`, `sessionId`, `seq` fields optional
  for V1 callers); removal gate: N/A for routes; destructive SQL only after new code +
  rollback proven (none required this milestone); rollback: revert code; restore DB from
  pre-migration backup if needed (migration 005 is additive → old binary can still run).
- **Verification**: `go test ./internal/watch/... ./internal/httpapi/... -run
  'Progress|Lease|Admission'`; `go test ./...`; `go test -race ./...` (or documented
  split per handoff §2); `npm test`; Compose config checks + disposable-stack integration
  per `docs/v2-server-package/acceptance-tests.md` §5–§7; Radxa checks §8 (recorded
  measurements; no OOM; 30-minute stream).
- **Exit gate**: All acceptance-test sections applicable to this milestone pass with a
  recorded test report; binary rollback from post-005 to pre-005 verified.

### P8 — Removal gates and release

- **Outcome**: Obsolete code is gone (or explicitly retained with a recorded decision),
  and an immutable semver release candidate passes its gates.
- **Work**: Removal gate reviews — renderer provider HTTP code (from P5 flag evidence),
  dead `NEXT_PUBLIC_VOD_BASE`/`API_BASE` remnants, decision record for dormant V1 routes
  (`/add`, `/prefetch`, `/v1/session/start|ended`, `/v1/resume.m3u`,
  `/v1/resume/source/probe`, `/subtitles/configure`, `/watch/*` are now live; others
  removed only if the no-remaining-consumer gate passes). Tag release per handoff §13:
  immutable `torwatch-server:<semver>`, digests, release notes, completed acceptance
  report.
- **Verification**: full `go test ./...`, `go test -race ./...`, `npm test`,
  `docker compose config` (root, untouched), package config checks, release checklist.
- **Exit gate**: Every removal executed has its gate evidence; release report verdict
  `pass`.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | | |

## Post-Design Constitution Re-Check (after Phase 1)

- **Principle I/II (outcomes, checkpoints)**: All eight phases end in working software;
  the only dormant-by-design surface (`/v2/catalog/*` between P3 and P5) is isolated,
  additive, and flag-gated in consumers — compliant with the "safely inactive" rule.
- **Principle III (shared BFF, versioned contracts)**: `contracts/` gives each shared
  contract one documented owner; `/v2` is explicitly versioned; V1 surface is preserved
  via `contracts/v1-compat.md` with per-route removal gates. No client develops divergent
  shared rules; renderer logic moves behind the backend boundary.
- **Principle IV/V (evidence, tests)**: P0 characterization precedes every port; parity
  suite (P4) grounds the migration in evidence; every phase names focused verification +
  rollback. Existing suites are never weakened; the one intentional contract change
  (renderer provider code retirement) is spec-approved and gate-gated.
- **Principle VI (operability/secrets)**: New handlers carry redaction tests (extended
  from `logx` patterns); `/readyz` hides secret component detail; provider API keys stay
  server-side (a security *improvement* over the V1 renderer, which ships provider keys
  in the client and CSP).
- **Verdict: PASS — design is constitution-compliant; proceed to /speckit.tasks.**
