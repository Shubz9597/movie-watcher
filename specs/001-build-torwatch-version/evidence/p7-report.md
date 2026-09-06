# P7 Report — Multi-Client Leases, Ordered Progress, Server Package

**Phase**: P7 (plan.md) | **Date**: 2026-09-04 | **Baseline revision**: `bd11a90a6f3c207392bdadd0c89377dcf240752f` (pre-005 reference for the T062 drill)

## Implemented (tasks marked complete)

| Task | Summary | Verification |
|---|---|---|
| T051 | Characterization BEFORE changes: `/watch/*` release semantics (shared leases, close-does-not-stop, reaper timing) pass; DB-level `SaveProgressUpdate` behavior captured in gated tests (`progress_characterization_test.go`, `TORWATCH_TEST_PG_DSN`) | `go test ./internal/httpapi/ -run TestWatch*` PASS; DB-level tests SKIP without disposable DB (pending, not passed) |
| T052 | `migrations/005_progress_multiclient.sql` — strictly additive expansion (`progress_revision` default/backfill 1, `writer_client_id`, `stream_session_id`, `last_seq`, `catalog_cache` table + index); no DROP/RENAME/TRUNCATE/DELETE (statically asserted); applied by the existing ordered `schema_migrations` framework | `go test ./migrations/` PASS (static guards); DB application + `TestMigration005Additive` SKIP → pending disposable DB |
| T053 | Server-commit-order LWW with monotonic `progress_revision`; per-session seq guard returning `{ok:true,ignored:"stale_seq"}`; deliberate rewind accepted; furthest-position-wins absent; V1 bodies unchanged (anonymous session, rule 7) | Pure decision tests (`progress_order_test.go`) 7/7 PASS; DB-level ordered tests (`progress_ordered_db_test.go`) written, SKIP → pending |
| T054 | `/v1/session/heartbeat` + `/stream` auto-save route through `SaveProgressUpdate`; heartbeat accepts optional `clientId`/`sessionId`/`seq`; auto-save marked `LowFidelity` so it never overwrites an explicit-session heartbeat row (contract rule 6; interpretation documented below) | Full httpapi suite PASS incl. Phase 1 session contracts (V1 shapes unchanged) |
| T055 | `watch.Manager` lease metadata (`ClientID`/`SessionID` per lease, reaper-aware), `activeLeases` additive response field, clientId UUID format validation (400 `invalid clientId`), sessionId length validation; V1 shared-lease semantics + stale/reaper timings preserved and now configurable (`WATCH_STALE_AFTER`/`WATCH_REAPER_INTERVAL`, defaults 20 s/30 s) | watch + httpapi suites PASS incl. release-timing characterization |
| T056 | `internal/admission` — deterministic DISTINCT-key counting; same-key sharing always allowed; denial (`ErrCapacityExceeded`) affects only the new key; release frees the slot only after the last lease; sanitized `Snapshot` (counts only) | admission tests 5/5 PASS |
| T057 | Wired into `/watch/open` (`503 capacity_exceeded` + `retryAfterSeconds`), `/stats` (`admission:{activeKeys,limit}` — no keys/clients exposed), main.go (`WATCH_MAX_ACTIVE_TITLES` default 1); `/stats` v1-compat removal gate closes (now live) | Route tests PASS (`TestWatchOpenCapacityExceededContract`, `/stats` admission field) |
| T058 | `deploy/torwatch-server/` bundle: compose.yaml (gateway-only exposure, `internal: true` network), compose.vpn.yaml override, Caddyfile (SSE + media `flush_interval -1`), .env.example (secrets operator-only), README runbook, Dockerfile (multi-stage, CGO_ENABLED=0), torwatch.sh dispatcher | `docker compose config` PASS with placeholders; missing-required-variable fail-closed behavior verified; root `docker-compose.yml` untouched (git status clean) |
| T059–T061 | Scripts written: preflight / backup / restore / update (auto-rollback) / verify (healthz byte-exact + readyz + version through gateway; range 206/1024 + SSE first-tick when stream URLs provided) / build-images.sh (buildx arm64+amd64, immutable tags) | Files complete; **executable checks PENDING** (Docker daemon down — no disposable stack, no buildx) |

## Verification commands (this phase)

| Check | Command | Result |
|---|---|---|
| Focused progress/lease/admission/migration tests | `go test -count=1 ./internal/watch/ ./internal/admission/ ./internal/config/ ./migrations/` | PASS |
| API suite | `go test -count=1 ./internal/httpapi/` | PASS |
| Full Go suite | `go test -count=1 ./...` | PASS (15 packages) |
| go vet | `go vet ./...` | PASS |
| `go test -race ./...` | attempted | **UNAVAILABLE** — requires cgo, no C compiler on this host (documented environment limitation; not suppressed, not passed) |
| Electron tests | `npm test` | PASS 64/64 |
| Compose config checks | `docker compose -f deploy/torwatch-server/compose.yaml config -q` (placeholders; VPN overlay too) + root compose config | PASS; exactly one published port (gateway 8080), `internal: true` for postgres/prowlarr/vod; root compose untouched |
| Package acceptance (live) | `docs/v2-server-package/acceptance-tests.md` §5–§7 | **PENDING** — requires Docker daemon / disposable stacks |
| T062 rollback drill | see `evidence/p7-rollback-drill.md` | **PENDING** (drill prepared; requires disposable DB; never touches production data) |
| T063 Radxa | see `evidence/p7-radxa.md` | **PENDING** (no hardware; conservative 1-distinct-title default kept) |

## Contract interpretation recorded for owner review

- **Rule 6 (auto-save fidelity)**: implemented as "a low-fidelity stream estimate is ignored (`stale_estimate`) when the current row was written by an explicit client session; anonymous V1 writes behave as before." This is the deterministic reading of "can never overwrite a newer heartbeat with an older estimate / renderer heartbeats remain preferred" that avoids prohibited furthest-position-wins. Owner sign-off requested at the phase exit review.

## Capabilities

`/v1/version` now advertises `["catalog.bff.v2", "leases.shared", "progress.serverOrdered"]` — all three implemented in this codebase as of this phase (no planned-but-missing capabilities advertised).

## Pending (not passed)

1. Migration 005 application + backward-compat drill on a disposable DB (T052 DB portion, T062).
2. Package scripts executable checks: preflight/backup/restore/update/verify, image builds, live gateway range/SSE checks (T059–T061) — need Docker.
3. Radxa measurements (T063) — need hardware; default kept conservative.
4. `go test -race ./...` — no cgo on this host.
5. Package acceptance §5–§7 live run.

## Rollback

`git revert` the Phase 8 commits removes: migration 005 file (never applied to any production database — no disposable DB was available, so nothing to down-migrate), the ordered-progress SQL changes, lease/admission wiring, the deployment package, and the capability additions. `git status` confirms the root `docker-compose.yml` and all operator data are untouched.
