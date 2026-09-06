# Tasks: TorWatch Version 2 — Shared Backend and BFF for Multiple Clients

**Input**: Design documents from `/specs/001-build-torwatch-version/`

**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ (v1-compat.md, v2-catalog-api.md, protocol-negotiation.md, leases-and-progress.md), quickstart.md, `.specify/memory/constitution.md` (v2.0.0)

**Tests**: MANDATORY (user request + Constitution principle V). Characterization/contract tests precede every destructive refactor. Every task carries: exact file path, related user story or constitutional gate, focused verification, migration/rollback notes where applicable, and a buildable checkpoint. Old paths are never removed before their replacement and consumers are verified.

**Organization**: Nine incremental phases exactly as defined in plan.md §Phased Delivery (P0–P8). Each phase is a vertical increment: it compiles, passes focused checks, and exits with full affected-suite verification and a recorded result.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story served (US1–US4 from spec.md). Gate references (constitution principles I–VI) appear in task details.
- Sub-bullets under tasks give verification commands, migration/rollback requirements, and dependencies.

## Path Conventions

- Go backend: `torrent-streamer/` (module extended, never replaced)
- Electron client: `electron-app/`
- Reference client: `torrent-streamer/tools/reference-client/`
- Deployment package: `deploy/torwatch-server/`
- Evidence/reports: `specs/001-build-torwatch-version/evidence/`

---

## Phase 1: Baseline and Characterization — plan.md P0 (Priority: P4 story US4 + Gates IV, V)

**Purpose**: Record and lock current V1 behavior with tests BEFORE any change. No behavior changes.

**Related**: US4 (safe migration), Constitution Gates IV (evidence before change) and V (tests define the safe change boundary).

**Independent Test**: All characterization/contract tests pass on the untouched baseline; `go test ./...`, `go vet ./...`, `npm test`, `docker compose config` results recorded (pre-existing failures documented, never hidden).

- [x] T001 Record baseline evidence report in specs/001-build-torwatch-version/evidence/p0-baseline.md
  - Content: HEAD commit SHA, results of `Set-Location torrent-streamer; go test ./...; go vet ./...`, `Set-Location electron-app; npm test`, `docker compose config`, route inventory (live vs dormant per contracts/v1-compat.md with grep evidence of zero in-repo consumers for dormant routes), rollback: delete evidence file (no behavior changed).
- [x] T002 [P] [US4] Add httptest contract tests for `/v1/torrents/search`, `/v1/torrents/resolve`, `/v1/imdb/ratings/{ttID}` in torrent-streamer/internal/httpapi/contract_torrents_test.go
  - Capture request/response shapes verbatim (opaque `sourceId`, `{query,total,results[]}`); Gate V: tests green BEFORE any refactor.
- [x] T003 [P] [US4] Add httptest contract tests for `/stream` (206/416 Range semantics, Content-Range, Accept-Ranges, `trackProgress=1` auto-save marker) and `/files` in torrent-streamer/internal/httpapi/contract_stream_test.go
- [x] T004 [P] [US4] Add httptest contract tests for `/subtitles/list`, `/subtitles/torrent`, `/subtitles/external` (429 + Retry-After) in torrent-streamer/internal/httpapi/contract_subtitles_test.go
- [x] T005 [P] [US4] Add httptest contract tests for `/v1/session/heartbeat`, `/v1/resume`, `/v1/resume/source`, `/v1/continue`, `/v1/continue/dismiss` in torrent-streamer/internal/httpapi/contract_session_test.go
  - Capture the 15 s resume rewind and LWW overwrite behavior (R6) — characterization for P7's ordered rewrite.
- [x] T006 [P] [US4] Add httptest contract tests for `/buffer/state` and `/buffer/info` (JSON + one SSE tick via `sse=1`) in torrent-streamer/internal/httpapi/contract_buffer_test.go
- [x] T007 [P] [US4] Add httptest shape-documenting tests for dormant routes `/healthz` (byte-exact `{"status":"ok"}` body), `/add`, `/prefetch`, `/stats`, `/v1/session/start|ended`, `/v1/resume/source/probe`, `/v1/resume.m3u`, `/watch/open|ping|close` in torrent-streamer/internal/httpapi/contract_dormant_test.go
  - These tests document current shapes and gate future removal (FR-010); they do not revive anything. Note (D-1 correction): `/subtitles/configure` is NOT dormant — it has a live Electron consumer (`electron-app/electron/ipc/setup-ipc.js:166`) and is characterized live with the other subtitle routes in contract_subtitles_test.go.
- [x] T008 [P] [US4] Add characterization tests for renderer catalog merge/matching with fixed provider fixtures in electron-app/scripts/characterization/catalog-merge.test.mjs and electron-app/scripts/characterization/anime-matching.test.mjs
  - Fixtures cover `anime-catalog.ts`, `anime-matching.ts`, `adapters/media.ts` outputs; lock merge order + tie-breaks before the P3/P4 port.
- [x] T009 Run Phase 1 exit gate: `Set-Location torrent-streamer; go test ./...; go vet ./...`, `Set-Location electron-app; npm test`; append results to evidence/p0-baseline.md
  - Checkpoint: untouched baseline, all characterization tests green. Rollback: delete added test/evidence files.

---

## Phase 2: Server Foundation — plan.md P1 (Priority: P3 story US3 + Gate VI)

**Purpose**: Headless-safe config, buildinfo, system endpoints. Additive only; V1 launch unchanged.

**Related**: US3 (versioned deployable service), Gate VI (operability/secrets), FR-004, FR-011, FR-012.

**Independent Test**: Local backend starts; `GET /v1/version` returns full payload (protocolVersion, supportedProtocolRange, capabilities); `GET /readyz` returns 503 when PostgreSQL is stopped; `/healthz` body byte-identical to the P0 capture.

- [x] T010 [P] [US3] Implement `internal/buildinfo` (version, revision, builtAt, protocolVersion=1, supportedProtocolRange=[1,1], capabilities) with unit tests in torrent-streamer/internal/buildinfo/buildinfo.go and torrent-streamer/internal/buildinfo/buildinfo_test.go
  - Capability flags: `catalog.bff.v2`, `leases.shared`, `progress.serverOrdered` (contracts/protocol-negotiation.md). Rollback: delete package.
- [x] T011 [P] [US3] Implement package-safe server config (accepts ALL V1 env names: `PG_DSN`, `PROWLARR_URL`, `PROWLARR_API_KEY`, `TORRENT_DATA_ROOT`, `SUB_CACHE_DIR`, `LOG_FILE`, `ERROR_LOG_FILE`, `TORWATCH_APP_VERSION`, `LISTEN`) with unit tests in torrent-streamer/internal/config/config.go and torrent-streamer/internal/config/config_test.go
  - Gate VI: container defaults via deployment env only; migration map: old owner `main.go` env reads, compatibility: V1 names accepted unchanged; rollback: revert.
- [x] T012 [P] [US3] Implement machine-readable negotiation error helpers (`unsupported_protocol`, `unsupported_capability` with `supportedProtocolRange`) with unit tests in torrent-streamer/internal/httpapi/system_errors.go
  - Contract: contracts/protocol-negotiation.md error table; no secrets/magnets in bodies (FR-012).
- [x] T013 [US3] Implement `GET /readyz` and `GET /v1/version` handlers with httptest contract tests in torrent-streamer/internal/httpapi/system_handlers.go and torrent-streamer/internal/httpapi/system_handlers_test.go
  - `readyz` 503 when PostgreSQL unavailable; component detail non-secret (FR-012). Depends on T010, T011, T012.
- [x] T014 [US3] Wire new handlers into the mux and inject config/buildinfo in torrent-streamer/cmd/vod/main.go
  - Verify `/healthz` body is byte-identical to the T007 capture (test asserts it). Rollback: revert commit (additive routes only).
- [x] T015 [P] [US3] Extend log redaction tests to cover new system/config paths in torrent-streamer/internal/logx/redact_test.go (FR-012: DSN passwords, API keys never in logs)
- [x] T016 Run Phase 2 exit gate: `go test ./internal/config/... ./internal/buildinfo/... ./internal/httpapi/... -run 'System|Config|Redact'`; then `Set-Location torrent-streamer; go test ./...; go vet ./...`, `Set-Location electron-app; npm test`; manual: local launch, `Invoke-RestMethod http://127.0.0.1:4001/v1/version`
  - Checkpoint: V1 smoke unchanged (Electron launch contract intact), full suites green, results recorded in evidence/.

---

## Phase 3: Client-Neutral Transport Groundwork in Electron — plan.md P2 (Pure refactor, US4 + Gate II)

**Purpose**: All renderer backend calls flow through one configurable base URL; behavior byte-for-byte identical with defaults. NO endpoint changes.

**Related**: US4 (zero regressions), Gate II (refactoring separated from feature changes), R7 step 1.

**Independent Test**: `npm test` green; grep gate clean; manual search→stream→resume smoke passes unchanged.

- [x] T017 [US4] Add configurable backend base URL (build-time default `http://localhost:4001`, env-overridable) to electron-app/src/lib/api-client.ts with a characterization test in electron-app/scripts/characterization/api-client.test.mjs
  - Pure refactor — no call-site changes yet. Rollback: revert commit.
- [x] T018 [P] [US4] Replace hardcoded `localhost:4001` call sites with api-client imports across electron-app/src (renderer services/components referencing the backend origin)
  - Migration map: old owner ~8 scattered constants; new owner `api-client.ts`; default value identical. Depends on T017.
- [x] T019 [P] [US4] Replace hardcoded backend origin in CSP meta tags across the 4 electron-app HTML files (electron-app/src/**/*.html or per repo layout) with the api-client-injected origin
  - Depends on T017. Rollback: revert.
- [ ] T020 [US4] Phase 3 exit gate: run `rg "localhost:4001" electron-app/src electron-app/electron --glob '!**/api-client.ts'` (must return zero product-code hits); `Set-Location electron-app; npm test`; `Set-Location torrent-streamer; go test ./...`; manual smoke: launch, search, stream, resume
  - Automated portion PASS (grep gate clean, npm test 51/51, go test/vet green — see evidence/p2-transport-refactor.md); **manual smoke PENDING** — interactive launch unavailable in this session; must be run by the operator before the Phase 4 exit review. Task completes only when the smoke passes.
  - Removal gate for the old constants: grep clean + suites green + smoke passes. Checkpoint: Electron behavior identical.

---

## Phase 4: Catalog Framework and /v2/catalog/* — plan.md P3 (US1 + Gate III)

**Purpose**: Backend serves unified search/detail/episodes/sections from five providers with deterministic merge and outage degradation. No client uses it yet (safely inactive per Gate I).

**Related**: US1 (SC-001), FR-001, FR-003, contracts/v2-catalog-api.md.

**Independent Test**: Contract tests green including provider-outage degradation; manual curl against a disposable stack returns merged results with `degraded` fields; no V1 route touched.

- [x] T021 [P] [US1] Implement Provider interface, registry, and deterministic merge (fixed provider priority + fixed tie-break keys, no map-iteration dependence) with unit tests in torrent-streamer/internal/catalog/provider.go and torrent-streamer/internal/catalog/provider_test.go
  - Contract: contracts/v2-catalog-api.md §Merge determinism; identifiers opaque `provider:externalId` (R4). Rollback: delete package.
- [x] T022 [P] [US1] Implement bounded TTL cache with per-provider timeouts and stale-but-valid degradation in torrent-streamer/internal/catalog/cache.go with tests in torrent-streamer/internal/catalog/cache_test.go
  - In-memory this phase; DB-backed `catalog_cache` table deferred to migration 005 (Phase 8). Edge Case 1: provider down ⇒ degraded results, never hang.
- [x] T023 [P] [US1] Implement TMDb provider adapter with fixture-driven unit test in torrent-streamer/internal/catalog/tmdb.go and torrent-streamer/internal/catalog/tmdb_test.go
  - Server-side API key (moved out of renderer — Gate VI improvement; operator config surface per handoff §7).
- [x] T024 [P] [US1] Implement AniList (GraphQL) provider adapter with fixture-driven unit test in torrent-streamer/internal/catalog/anilist.go and torrent-streamer/internal/catalog/anilist_test.go
- [x] T025 [P] [US1] Implement Jikan provider adapter with fixture-driven unit test in torrent-streamer/internal/catalog/jikan.go and torrent-streamer/internal/catalog/jikan_test.go
- [x] T026 [P] [US1] Implement Cinemeta provider adapter with fixture-driven unit test in torrent-streamer/internal/catalog/cinemeta.go and torrent-streamer/internal/catalog/cinemeta_test.go
- [x] T027 [P] [US1] Implement AniZip/Kitsu provider adapter with fixture-driven unit test in torrent-streamer/internal/catalog/anizip.go and torrent-streamer/internal/catalog/anizip_test.go
- [x] T028 [US1] Add provider-outage degradation tests (timeout, 429, partial data, all-providers-failed ⇒ `providers_unavailable` 503) in torrent-streamer/internal/catalog/degradation_test.go
  - Depends on T021–T027. Verifies Edge Case 1 + error code contract.
- [x] T029 [US1] Implement `GET /v2/catalog/search` handler with httptest contract tests in torrent-streamer/internal/httpapi/catalog_handlers.go and torrent-streamer/internal/httpapi/catalog_handlers_test.go
  - Response per contract (results, degraded, degradedProviders); depends on T021, T022, T028.
- [x] T030 [US1] Implement `GET /v2/catalog/titles/{id}` handler (404 `title_not_found`; externalLinks, ratings, runtime, genres) with contract test in torrent-streamer/internal/httpapi/catalog_handlers.go / catalog_handlers_test.go
- [x] T031 [US1] Implement `GET /v2/catalog/titles/{id}/episodes` handler (season-scoped deterministic episode merge) with contract test in torrent-streamer/internal/httpapi/catalog_handlers.go / catalog_handlers_test.go
- [x] T032 [US1] Implement `GET /v2/catalog/sections` handler (provider kinds; `kind=continue-watching` proxies `/v1/continue` household semantics) with contract test in torrent-streamer/internal/httpapi/catalog_handlers.go / catalog_handlers_test.go
- [x] T033 [US1] Add `providers_unavailable` 503 path + `unsupported_protocol`/`unsupported_capability` enforcement on `/v2/catalog/*` contract tests in torrent-streamer/internal/httpapi/catalog_handlers_test.go
  - Machine-readable codes with server range (FR-011); no secrets in error bodies.
- [ ] T034 Run Phase 4 exit gate: `go test ./internal/catalog/... ./internal/httpapi/... -run Catalog`; `Set-Location torrent-streamer; go test ./...; go vet ./...`, `Set-Location electron-app; npm test`; manual curl of all four endpoints against a disposable stack
  - Automated portion PASS (all catalog/httpapi/cmd suites, full Go suite, vet, Electron tests, end-to-end wiring test over local provider stubs — see evidence/p3-catalog-bff.md); **live disposable-stack curl EXECUTED 2026-09-06 — see evidence/p3-live-curl.md**: all four endpoints live-verified incl. degradation, seasons, genre/pagination, and validation errors; AniList/Jikan egress blocked from this host (degraded paths exercised live instead; anime live-data gap recorded). Task box left unticked pending operator review of the anime-provider network gap.
  - Checkpoint: `/v2/catalog/*` live but unused by any client (Gate I: isolated, additive, inactive). Rollback: remove package/routes; no data impact.

---

## Phase 5: Parity — Electron Aggregation vs Backend Aggregation — plan.md P4 (US1 + Gate V)

**Purpose**: Prove behavioral parity between P0 renderer characterization fixtures and the Go implementation on identical provider payloads.

**Related**: US1, US4 evidence; Gate V. Prerequisite for P5 migration.

**Independent Test**: `go test ./internal/catalog/ -run Parity` green; renderer characterization tests still green; variance list reviewed against spec.

- [x] T035 [P] [US1] Export golden fixture set from the P0 renderer characterization fixtures into torrent-streamer/internal/catalog/testdata/parity/ (identical provider payloads in)
  - Depends on T008.
- [x] T036 [US1] Implement golden-fixture parity suite (Go vs characterization outputs; byte-identical id/ordering for same query) in torrent-streamer/internal/catalog/parity_test.go
  - Depends on T035, T021–T034. Differences reconciled in code or documented in T037.
- [x] T037 [US1] Document each divergence as intentional V2 contract evolution with spec reference in specs/001-build-torwatch-version/evidence/p4-parity-variance.md
  - Rollback: none (documentation); variance requires owner approval before T039/T040.
- [x] T038 Run Phase 5 exit gate: `go test ./internal/catalog/ -run Parity`; `Set-Location electron-app; npm test`; `Set-Location torrent-streamer; go test ./...`
  - Checkpoint: parity proven; renderer path still the only active catalog source.

---

## Phase 6: Electron Catalog Migration — plan.md P5 (US1 + Gate II)

**Purpose**: Electron fetches catalog exclusively from `/v2/catalog/*` behind runtime flag `catalogSource=renderer|bff` (default `renderer`); flip default only after end-to-end verification.

**Related**: US1 + US4; Gate II (flag coexistence, one consumer at a time), FR-010 removal-gate sequencing.

**Independent Test**: Full journey (search → detail → episodes → source → playback → subtitle → resume) passes with flag `bff`; identical experience with flag `renderer`; instant rollback = flip flag.

- [x] T039 [US1] Add runtime catalog flag `catalogSource=renderer|bff` (default `renderer`) wiring in electron-app/electron/config/ (config loader + IPC exposure)
  - Rollback: revert; flag-off path untouched.
- [x] T040 [P] [US1] Convert electron-app/src/lib/services/tmdb-service.ts, anilist-service.ts, jikan-service.ts into thin adapters over `/v2/catalog/*` behind the flag
  - Renderer provider HTTP code RETAINED (inactive) under flag=renderer — removal only at P8 gate. Depends on T039 and Phase 4.
- [x] T041 [P] [US1] Convert electron-app/src/lib/services/cinemeta-service.ts, anime-episode-metadata-service.ts, and aggregation call sites (anime-catalog.ts, anime-matching.ts, adapters/media.ts) into flag-gated adapters
  - TMDb IPC/Gluetun transport tests preserved for the flag-off path (Gate V: suites not weakened). Depends on T039.
- [x] T042.1 [US1] (child of T042) Close server-side detail/section gaps from the P5 gap audit: add `seasons` to the `/v2/catalog/titles/{id}` response (TMDb tv seasons; AniList/Jikan single-season episode counts), add `genre`+`type`+`page` support to `/v2/catalog/sections` for provider sections, with httptest contract tests in torrent-streamer/internal/catalog/ and torrent-streamer/internal/httpapi/catalog_handlers_test.go, and update contracts/v2-catalog-api.md additively
  - Evidence: specs/001-build-torwatch-version/evidence/p5-bff-gap-audit.md. Additive only; existing section/detail shapes unchanged for existing clients. VERIFIED 2026-09-06: catalog + httpapi suites green (`go test ./internal/catalog/ ./internal/httpapi/ -run 'Season|Section|TitleDetail|TMDb|AniList'`), go build clean; contract doc updated. Rollback: revert.
- [x] T042.2 [US1] (child of T042) Extend electron-app/src/lib/services/catalog-bff.ts (seasons/ratings/runtime/genres fields, paged+genre section client) and catalog-gateway.ts (getTitleDetail, getTitlesByGenre, paged sections) with adapter mapping in src/lib/adapters/media.ts; characterization tests in electron-app/scripts/characterization/catalog-gateway.test.mjs
  - VERIFIED 2026-09-06: `npm run test:characterization` 43/43 including new detail/genre/pagination/enrichment-mapping cases. Renderer-mode gateway behavior unchanged (characterized). Rollback: revert client files.
- [x] T042.3 [US1] (child of T042) Migrate TitlePage.tsx detail loading behind the flag: bff mode resolves detail/seasons/episodes via the gateway BFF client (tmdb movie/tv, tmdb-backed anime, anilist anime incl. episode lists and artwork hydration); renderer mode keeps the exact legacy path
  - VERIFIED 2026-09-06: npm test 70/70, `npm run build:renderer` clean (the pre-existing INEFFECTIVE_DYNAMIC_IMPORT warnings are gone because bff-capable pages no longer statically import provider services). Live bff-mode journey still pending the T042 manual run. Rollback: revert TitlePage.tsx; flag flip remains instant.
- [x] T042.4 [US1] (child of T042) Migrate continue-service.ts enrichment and PlayerPage.tsx playback metadata behind the flag: bff mode resolves titles via the BFF detail client; renderer mode keeps the legacy provider calls
  - VERIFIED 2026-09-06: npm test 70/70; legacy provider imports in these files became lazy, so bff mode performs no provider calls. Rollback: revert the two files; flag flip remains instant.
- [x] T042.5 [US1] (child of T042) Migrate SeeAllPage.tsx collections to the flag-routed gateway (getMovies/getTvShows/getTitlesByGenre + anime sections with paging) so bff mode serves genre rails and pages beyond one
  - VERIFIED 2026-09-06: npm test 70/70 + build clean. Rollback: revert SeeAllPage.tsx.
- [ ] T042 [US1] Verify end-to-end with flag `bff` AND flag `renderer`: manual full journey per quickstart §2; record results in specs/001-build-torwatch-version/evidence/p5-flag-verification.md
  - Depends on T040, T041, and the T042.x child tasks closing the documented detail/genre/enrichment/pagination gaps (evidence/p5-bff-gap-audit.md). Regression here halts the phase (Gate I: unexplained regression stops restructuring).
- [ ] T043 [US1] Flip default `catalogSource` to `bff` in electron-app/electron/config/ only after T042 passes; re-run `npm test` + smoke
  - Removal gate (renderer provider code) stays OPEN until P8: flag verified across a full release cycle AND parity suite green AND owner approval. Rollback: flip flag to `renderer` (instant) and/or revert commits.
- [ ] T044 Run Phase 6 exit gate: `Set-Location electron-app; npm test`, `Set-Location torrent-streamer; go test ./...`; zero P1-level regressions; catalog experience equivalent to P0 characterization outputs
  - Checkpoint: Electron consumes BFF; renderer providers dormant but intact.

---

## Phase 7: Protocol Negotiation Clients + Reference Client — plan.md P6 (US2 + US3 + Gate III)

**Purpose**: Two different clients complete the same journey against one backend (SC-002); negotiation implemented, not just advertised (SC-001 + US2 acceptance 1–3).

**Related**: US2 (second client), US3 (negotiation), FR-005, FR-011.

**Independent Test**: Reference client (Go CLI, public endpoints only) completes search → detail → source → stream → progress → resume; Electron does the same; shared progress observable between them (quickstart §3).

- [x] T045 [P] [US2] Create reference-client skeleton with `/v1/version` negotiation module (range overlap check, block-incompatible-workflow with actionable message) and unit tests in torrent-streamer/tools/reference-client/main.go and torrent-streamer/tools/reference-client/negotiate_test.go
  - Test harness, not a shipped product (spec Assumption). Rollback: delete directory.
- [x] T046 [P] [US2] Implement reference-client catalog commands (search, title detail, episode list) against `/v2/catalog/*` with integration test in torrent-streamer/tools/reference-client/catalog.go and torrent-streamer/tools/reference-client/catalog_test.go
  - Client-generated persisted UUID `clientId` (FR-013), validated format only. Depends on T045.
- [x] T047 [P] [US2] Implement reference-client playback journey (resolve via `/v1/torrents/resolve`, ranged `GET /stream`, heartbeat, `/v1/resume`) with integration test in torrent-streamer/tools/reference-client/playback.go and torrent-streamer/tools/reference-client/playback_test.go
  - Depends on T045. Uses only public endpoints (FR-003).
- [x] T048 [US3] Add Electron startup `/v1/version` check gating workflows on protocol-range overlap (health/version discovery never gated) in electron-app/src/lib/version-check.ts with test in electron-app/scripts/characterization/version-check.test.mjs
  - Depends on Phase 2 `/v1/version`.
- [x] T049 [US2] Add contract tests proving server returns `unsupported_protocol`/`unsupported_capability` (with supportedProtocolRange) and NEVER rejects on differing app version for requests declaring out-of-range protocol, in torrent-streamer/internal/httpapi/system_handlers_test.go
  - Contract rule 5/6 (protocol-negotiation.md); depends on T012, T013.
- [ ] T050 [US2] Run dual-client verification per quickstart §3 (Electron + reference client, same title, shared resume, shared leases) and record evidence in specs/001-build-torwatch-version/evidence/p6-dual-client.md
  - SC-001 and SC-002 demonstrated. Exit gate: `go test ./tools/reference-client/...`; `Set-Location torrent-streamer; go test ./...`, `Set-Location electron-app; npm test`.
  - Harness-level demonstration PASS (two independent clients, one backend, shared progress visibility — see evidence/p6-dual-client.md); **interactive Electron + reference-client run PENDING** (needs the P7 lease surface + a live deployment); task completes when that run is recorded.

---

## Phase 8: Multi-Client Leases, Ordered Progress, Server Package — plan.md P7 (US2 + US3 + Gates I, II, VI)

**Purpose**: Concurrent clients safe by construction: shared leases with clientId, deterministic capacity admission, server-ordered progress (migration 005 additive), homeserver deployment package, Radxa-measured admission default.

**Related**: US2 (FR-006, FR-007), US3 (FR-008, FR-009, SC-004/SC-005/SC-006), Gate VI (backup/restore/rollback).

**Independent Test**: quickstart §4 interleaved-heartbeat scenario; two clients share one lease key (`activeLeases: 2`); second distinct title beyond limit gets 503 `capacity_exceeded` while healthy streams continue; migration 005 rollback drill (pre-005 binary runs against migrated DB).

- [x] T051 [US2] Add characterization tests for current `SaveProgressUpdate` LWW semantics and `/watch/open|ping|close` shapes BEFORE changes, in torrent-streamer/internal/watch/progress_characterization_test.go and torrent-streamer/internal/httpapi/contract_watch_test.go
  - Gate IV/V: capture before restructuring (extends T005/T007 captures with DB-level assertions). Also re-derive `/watch/*` key-parsing quirks (R10: watchmgr.go JSON fileIndex quirk).
- [x] T052 [US2] Write migration 005_progress_multiclient.sql (ADDITIVE only: `progress_revision BIGINT` default/backfill 1, `writer_client_id`, `stream_session_id`, `last_seq` per-session tracking, new `catalog_cache` table) in torrent-streamer/migrations/005_progress_multiclient.sql
  - Expand phase — no destructive change; pre-005 binaries ignore new columns (data-model.md migration plan). Rollback: none needed (additive); DB restore from pre-migration backup documented.
- [x] T053 [US2] Implement ordered `SaveProgressUpdate` (server-assigned monotonic `progress_revision`, commit-order LWW, per-session `seq` guard returning `{ok:true,ignored:"stale_seq"}`, deliberate rewind valid, furthest-position-wins prohibited) with regression tests in torrent-streamer/internal/watch/progress_sql.go and torrent-streamer/internal/watch/progress_sql_test.go
  - Regression tests: delayed heartbeat retry must NOT rewind; deliberate rewind MUST work; V1 bodies (no clientId/sessionId/seq) behave as before (contract rule 7). Depends on T051, T052.
- [x] T054 [US2] Route `/v1/session/heartbeat` and `/stream` auto-save through the ordered write path with reconciliation tests in torrent-streamer/internal/httpapi/session.go and torrent-streamer/internal/httpapi/handlers.go
  - Auto-save (low-fidelity byte-ratio estimate) can never overwrite a newer heartbeat (contract rule 6); renderer heartbeats remain preferred. Depends on T053.
- [x] T055 [US2] Extend lease records with `clientId` (format/length-validated opaque UUID) + `sessionId` correlation and add `activeLeases` observability to responses in torrent-streamer/internal/watch/watchmgr.go with tests in torrent-streamer/internal/watch/watchmgr_test.go
  - V1 semantics preserved: multiple concurrent leases per key, release only when ALL expire/go stale, close does not stop torrent immediately, staleAfter/reaper configurable (defaults 20 s/30 s). Depends on T051.
- [x] T056 [P] [US3] Implement distinct-key capacity admission policy (configurable limit, deterministic, counts active DISTINCT resource keys) with unit tests in torrent-streamer/internal/admission/admission.go and torrent-streamer/internal/admission/admission_test.go
  - Denial affects ONLY new requests (FR-007/Clarification 5). Independent of T053–T055 wiring.
- [x] T057 [US2] Wire admission into `/watch/open` (`503 capacity_exceeded` + retryAfterSeconds) and admission observability into `/stats`, with contract tests in torrent-streamer/internal/httpapi/watch_handlers.go (or existing mux wiring) and torrent-streamer/internal/httpapi/contract_watch_test.go
  - `/stats` becomes live (closes its v1-compat removal gate — update evidence). Depends on T055, T056.
- [x] T058 [US3] Create deployment bundle per docs/v2-server-package/: compose.yaml, compose.vpn.yaml, .env.example, Caddyfile, README.md in deploy/torwatch-server/
  - Single gateway entrypoint (FR-008); internal deps not exposed; root docker-compose.yml NEVER repurposed; secrets only in .env (Gate VI). Depends on T011, T014.
- [ ] T059 [P] [US3] Add package scripts (preflight, backup, restore, update, verify) in deploy/torwatch-server/scripts/ with smoke checks against a disposable Compose stack
  - Gate VI: backup/restore/update/rollback functional. Depends on T058.
  - Scripts WRITTEN (preflight fail-closed validated via compose config); **executable smoke checks PENDING** (Docker daemon unavailable this session) — see evidence/p7-report.md. Completes when the disposable-stack run is recorded.
- [ ] T060 [P] [US3] Add multi-arch image build (ARM64 + AMD64) with immutable tags and package-owned Prowlarr bootstrap config in deploy/torwatch-server/ (Dockerfile + build docs in README.md)
  - Depends on T058. Rollback: prior immutable tag.
  - Dockerfile + build-images.sh (buildx arm64+amd64, immutable tags) WRITTEN; **image build PENDING** (no Docker daemon) — completes when a build is recorded.
- [ ] T061 [US3] Verify gateway passes media byte-ranges and SSE without buffering (config test in deploy/torwatch-server/Caddyfile + disposable-stack check documented in deploy/torwatch-server/README.md)
  - Depends on T058, T060. Performance goal: streaming/SSE latency no worse than V1.
  - Caddyfile config written and compose-validated (`flush_interval -1` for /stream + /buffer/info); **live gateway pass-through check PENDING** (needs disposable stack).
- [ ] T062 [US3] Run migration/rollback drill: apply migration 005 on a disposable stack, run pre-005 binary against migrated DB (must work), restore backup, record in specs/001-build-torwatch-version/evidence/p7-rollback-drill.md
  - Depends on T052, T053. Exit-gate requirement from plan P7.
  - DRILL EXECUTED 2026-09-06 (see evidence/p7-rollback-drill.md): migrations 001–006 applied by the current binary on a disposable PostgreSQL; DB-gated migration/ordered-progress suites PASS (`-p 1`); pre-005 binary (built from a HEAD worktree) runs against the migrated DB; pg_dump drop/restore round trip preserves schema+data. Checklist box left unticked pending operator review because the drill ran the backend binary directly (not inside the deploy/torwatch-server compose stack) and the race gate (T064) is still open.
- [ ] T063 [US3] Take ROCK 3A measurements (30-minute stream, CPU/memory, no OOM; quickstart §6 + acceptance-tests §8) and set the admission default to the measured envelope in torrent-streamer/internal/admission/admission.go (one guaranteed distinct title)
  - Depends on T057, T058–T061. SC-006 evidence recorded in evidence/p7-radxa.md.
- [ ] T064 Run Phase 8 exit gate: `go test ./internal/watch/... ./internal/httpapi/... -run 'Progress|Lease|Admission'`; `Set-Location torrent-streamer; go test ./...`; `go test -race ./...`; `Set-Location electron-app; npm test`; `docker compose config` (root untouched) + package config checks; record test report in evidence/p7-report.md
  - Acceptance sections §5–§7 of docs/v2-server-package/acceptance-tests.md must pass with recorded results.

---

## Phase 9: Removal Gates and Release — plan.md P8 (US4 + Gates I, II, III, V)

**Purpose**: Obsolete code removed only after documented gates pass (or explicitly retained with a recorded decision); immutable semver release candidate passes its gates.

**Related**: US4 (SC-003), FR-010 removal-gate procedure (contracts/v1-compat.md §Change procedure).

**Independent Test**: Every removal has gate evidence (no remaining consumer + contract tests green + rollback recorded); final full-suite run has zero unexplained regressions; release report verdict `pass`.

- [ ] T065 [US4] Execute renderer provider HTTP code removal gate: verify flag `bff` ran through a full release cycle + parity suite green + owner approval recorded in specs/001-build-torwatch-version/evidence/p8-removal-gate-renderer.md, THEN delete now-dead renderer provider HTTP code paths from electron-app/src/lib/services/ and CSP provider hosts
  - Old path removed ONLY after replacement (Phase 6) and consumer verification (T042/T043). Rollback: git revert (flag `renderer` path is already gone — revert restores it).
- [ ] T066 [P] [US4] Remove dead env remnants (`NEXT_PUBLIC_VOD_BASE`, `API_BASE` and similar) from electron-app/ after grep proves zero consumers; record in evidence/p8-removal-gate-renderer.md
  - Depends on T065.
- [ ] T067 [US4] Write dormant-route decision record (remove only gated routes: `/add`, `/prefetch`, `/v1/session/start|ended`, `/v1/resume/source/probe`, `/v1/resume.m3u`, `/subtitles/configure` — each with no-remaining-consumer grep evidence + contract-test disposition; `/watch/*` and `/stats` now live and retained) in specs/001-build-torwatch-version/evidence/p8-removals.md; execute only the removals whose gates pass, updating contract_dormant_test.go in the SAME task
  - Gate order per contracts/v1-compat.md; Windows/local V1 launch flow retained until its own gate (not this milestone). Depends on Phases 7–8.
- [ ] T068 [US3] Cut release candidate: tag immutable `torwatch-server:<semver>`, record digests, write release notes, complete acceptance report in specs/001-build-torwatch-version/evidence/p8-release.md per docs/v2-server-package/ §13
  - Depends on T060, T063, T064, T067.
- [ ] T069 Run final verification: full `Set-Location torrent-streamer; go test ./...; go vet ./...`, `go test -race ./...`, `Set-Location electron-app; npm test`, `docker compose config`, package config checks, and quickstart.md §1–§7 walkthrough; confirm zero unexplained regressions (every difference traces to an approved contract change)
  - Release checklist exit: verdict `pass` recorded before milestone close.

---

## Dependencies & Execution Order

### Phase Dependencies (nine incremental phases, plan.md order)

- **Phase 1 (P0)**: No dependencies — starts immediately. BLOCKS everything (characterization before any change).
- **Phase 2 (P1)**: Depends on Phase 1 exit gate. Additive server foundation.
- **Phase 3 (P2)**: Depends on Phase 1 (characterization must exist first). Independent of Phase 2 — can run in parallel with it.
- **Phase 4 (P3)**: Depends on Phase 2 (config/error helpers). Produces inactive `/v2/catalog/*`.
- **Phase 5 (P4)**: Depends on Phases 1 (fixtures) and 4 (implementation).
- **Phase 6 (P5)**: Depends on Phase 5 exit gate (parity proven) and Phase 3 (configurable base URL).
- **Phase 7 (P6)**: Depends on Phases 2 (version endpoint) and 4 (catalog endpoints). Independent of Phase 6.
- **Phase 8 (P7)**: Depends on Phase 1 characterization (T051 re-extends), Phase 2 (config), and supplies deployment for release. Admission (T056) parallelizes with progress work (T053–T055).
- **Phase 9 (P8)**: Depends on all prior phases; removals only after their gates' evidence exists.

### User Story Completion Order

- **US1 (P1, defining capability)**: Phases 4 → 5 → 6 (catalog BFF, parity, Electron migration). Verification: bare client journey, quickstart §2.
- **US2 (P2, second client)**: Phase 7 (reference client) + Phase 8 (leases/progress/admission make concurrency safe). Verification: quickstart §3–§4.
- **US3 (P3, deployable service)**: Phase 2 (system endpoints) + Phase 8 (server package) + Phase 9 (release). Verification: quickstart §1, §6.
- **US4 (P4, safe migration — constraint story)**: Phases 1, 3 (pure refactor), 9 (removal gates) + exit gates of every other phase. Verification: quickstart §5 invariants at each phase exit.

### Within Each Phase

- Characterization/contract tests BEFORE destructive refactoring (T051 precedes T052–T055; T008 precedes T040–T041).
- Models/packages before handlers; handlers before wiring; wiring before consumer migration.
- No removal of an old path before its replacement AND its consumers are verified (T065 after T043 release-cycle evidence; dormant routes only in T067).

### Parallel Opportunities

- Phase 1: T002–T008 all independent test files.
- Phase 2: T010, T011, T012, T015.
- Phase 4: T021–T027 (separate files), T035 in Phase 5.
- Phase 7: T045–T047 reference-client modules; T048 Electron check.
- Phase 8: T056 admission package; T059/T060 package scripts/images.
- Phases 2 and 3 can overlap; Phases 6 and 7 can overlap after their prerequisites.

---

## Parallel Example: Phase 4 (Catalog)

```text
# Launch provider adapters together (independent files):
Task: "T023 TMDb adapter in torrent-streamer/internal/catalog/tmdb.go"
Task: "T024 AniList adapter in torrent-streamer/internal/catalog/anilist.go"
Task: "T025 Jikan adapter in torrent-streamer/internal/catalog/jikan.go"
Task: "T026 Cinemeta adapter in torrent-streamer/internal/catalog/cinemeta.go"
Task: "T027 AniZip/Kitsu adapter in torrent-streamer/internal/catalog/anizip.go"
# Then merge/cache consumers (T021, T022 already parallel), then handlers T029–T033 sequentially.
```

## Parallel Example: Phase 8 (Multi-client)

```text
# Independent tracks:
Track A: T051 → T052 → T053 → T054 (ordered progress)
Track B: T055 → T057 (leases) with T056 (admission, parallel) 
Track C: T058 → T059 / T060 / T061 (deployment package)
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1: Baseline + characterization (protect the truth)
2. Phase 2: Server foundation (additive)
3. Phases 3–6: transport refactor → catalog BFF → parity → Electron migration
4. **STOP and VALIDATE**: quickstart §2 bare-client journey + §5 invariants
5. Backend is now the single source of the viewing journey (SC-001)

### Incremental Delivery

1. Phases 1–2 → foundation; 2. Phase 3 → refactor checkpoint; 3. Phases 4–5 → BFF exists + parity; 4. Phase 6 → Electron on BFF (MVP+); 5. Phase 7 → SC-002 dual-client; 6. Phase 8 → concurrency-safe + deployable (SC-004/005/006); 7. Phase 9 → gated removals + release.

### Rollback Strategy (per plan.md)

Every phase: `git revert` of the phase's commits; data rollback only where documented (migration 005 is additive → pre-005 binaries run; T062 drill proves it). Renderer catalog migration rollback = flip `catalogSource` flag (instant). No phase requires a database down-migration.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps tasks to US1–US4; constitutional gates cited in task details.
- Full affected-suite check (`go test ./...`, `go vet ./...`, `npm test`) at EVERY phase exit — see T009, T016, T020, T034, T038, T044, T050, T064, T069.
- Secrets/magnets redacted in all new paths (FR-012); root `docker-compose.yml` never repurposed; generated directories never edited as source.
- Verify characterization tests fail-meaningfully/pass-before-refactor ordering: P0 tests run on untouched code; P7 characterization (T051) precedes the destructive `SaveProgressUpdate` rewrite (T053).
