# P1 Evidence — Server Foundation: config, buildinfo, system endpoints

**Phase**: P1 (plan.md "Server foundation") | **Date**: 2026-09-04 | **Baseline**: Phase 1 exit (commit `bd11a90a` + Phase 1 test/evidence additions)

## Migration map (constitution principle IV)

| Field | Value |
|---|---|
| Old owner | `cmd/vod/main.go` inline env reads (`PG_DSN`, `INDEXER_URL`/`PROWLARR_URL`, `INDEXER_API_KEY`/`PROWLARR_API_KEY`); no version/readiness surface existed |
| New owner | `internal/config` (`server_config.go`), `internal/buildinfo`, `internal/httpapi/system_handlers.go`, `internal/httpapi/system_errors.go` |
| Consumers | Electron launch contract (`/healthz` — untouched); new clients of `/readyz` + `/v1/version` (none yet; consumed from P6/P7) |
| Compatibility | Additive routes only (`/readyz`, `/v1/version`); V1 env names accepted with identical precedence (`INDEXER_*` → `PROWLARR_*`); `LISTEN` still flows through the unchanged `config.Load()`/`ListenAddr()` path; `/healthz` closure byte-identical (source-literal test passes) |
| Removal gate | N/A (new surface) |
| Rollback | `git revert` of the Phase 2 commits removes the new packages/handlers and restores the inline env reads; no data involved |

## Changes

- **T010** `internal/buildinfo` — `Info` payload (serverVersion, revision, builtAt, `protocolVersion: 1`, `supportedProtocolRange: [1,1]`, goVersion, os, arch, capabilities) with ldflags-injectable `AppVersion`/`Revision`/`BuiltAt` and `Options` for the caller-supplied version. Per the "advertise only implemented capabilities" constraint, `capabilities` is an **empty list** in this phase; `catalog.bff.v2` is added in the catalog phase, `leases.shared`/`progress.serverOrdered` only in P7.
- **T011** `internal/config/server_config.go` — package-safe `ServerConfig` + `LoadServerConfig()` reading the V1 env names (`PG_DSN`, `INDEXER_URL`/`PROWLARR_URL`, `INDEXER_API_KEY`/`PROWLARR_API_KEY`, `TORRENT_DATA_ROOT`, `SUB_CACHE_DIR`, `LOG_FILE`, `ERROR_LOG_FILE`, `TORWATCH_APP_VERSION`, `LISTEN`); `Validate()` names missing settings without echoing secret values; `SecretValues()` exposed for tests. No container-specific defaults baked in — deployment env supplies them.
- **T012** `internal/httpapi/system_errors.go` — machine-readable `unsupported_protocol` (400, includes `supportedProtocolRange`) and `unsupported_capability` (400, includes `capabilities`) error envelopes per contracts/protocol-negotiation.md.
- **T013** `internal/httpapi/system_handlers.go` — `GET /v1/version` (full buildinfo payload) and `GET /readyz` (component status; **503 when PostgreSQL is unavailable**; Prowlarr failure is reported as `degraded` without failing readiness). Component checks are injected funcs with a 2 s timeout; error details are never included in responses (FR-012).
- **T014** `cmd/vod/main.go` — `mustOpenDB` now takes the DSN from `config.LoadServerConfig()`; Prowlarr URL/key from the same config (same names, same precedence); `TORWATCH_APP_VERSION` feeds `buildinfo`; `SystemHandlers` registered on the mux with `db.PingContext` (postgres) and a Prowlarr `/api/v1/health` probe (prowlarr). `/healthz` closure untouched.
- **T015** `internal/logx/redact_test.go` — redaction coverage extended to the new paths' shapes: postgres/postgresql DSN passwords, `?apikey=` query strings, `X-Api-Key:` header form, JSON-shaped `"api_key":"…"`, magnet in error text, and a Writer-level `/readyz`-style diagnostic. One minimal pattern fix was required (regression-test-driven): `keySecretPattern` now allows a closing JSON quote between the key name and `:` so `"api_key":"secret"` forms are redacted.
- **Reconciliation (pre-implementation)** — D-1 corrected across artifacts: `/subtitles/configure` reclassified **live** in `contracts/v1-compat.md` (moved to the live table), plan.md P0, research.md R2, tasks.md T007; T001–T009 marked `[x]` after verifying against `evidence/p0-baseline.md` (exit gate PASS; deferred items — DB-backed happy paths, live 206/416, OpenSubtitles 429 — remain recorded as deferrals, not completions).

## Verification (commands + results)

| Check | Command | Result |
|---|---|---|
| Focused tests | `go test ./internal/config/... ./internal/buildinfo/... ./internal/httpapi/... -run 'System\|Config\|Build\|Readyz\|Version\|Protocol\|Capability\|Redact\|ServerConfig\|Validate'` | PASS (exit 0) — config env-compat + secret-free validation, buildinfo payload shape, readyz 200/503/degraded + method contract, version payload contract incl. empty capabilities, negotiation error envelopes |
| Affected packages | `go test ./internal/buildinfo/... ./internal/config/... ./internal/logx/... ./internal/httpapi/...` | PASS (exit 0) |
| Full Go suite | `go test ./...` | PASS (exit 0) — all packages, including Phase 1 characterization suites (V1 behavior still locked) |
| Go vet | `go vet ./...` | PASS (exit 0) |
| Electron tests | `npm test` | PASS (exit 0) — 46/46 |
| `/healthz` byte-identity | `go test ./cmd/vod` (`healthz_characterization_test.go`) | PASS — closure untouched per `git diff`; body literal frozen |
| DB-unavailability isolation | `TestReadyzReturns503WhenPostgresUnavailable` (injected failing checker, no real database touched) | PASS — user's live PostgreSQL never contacted by tests |

## Unverified checks (recorded, not hidden)

- **Live local launch smoke** (plan P1: "manual: local backend starts and `/v1/version` returns the full payload while `/healthz` body is byte-identical"): NOT performed — it requires a real PostgreSQL instance, which the user directed me not to touch. Equivalent coverage via httptest: version payload contract (`TestVersionEndpointContract`), readyz 503-on-postgres-failure (`TestReadyzReturns503WhenPostgresUnavailable`), and the `/healthz` body-literal lock. The live smoke should be done at the next convenient moment when a dev stack is running.
- **`go test -race`**: unavailable on this host — `-race` requires cgo and no C compiler is installed (`gcc` not found). Plan P7 already scopes race verification ("or documented split per handoff §2"); recorded here as an environment limitation, not a pass.
- **Prowlarr degraded path against a real Prowlarr**: covered only by injected-checker tests; live Prowlarr probe deferred to disposable-stack integration checks.

## Rollback

`git revert` of the Phase 2 changes (new packages `internal/buildinfo`, files `internal/config/server_config*.go`, `internal/httpapi/system_*.go`, `internal/logx/redact_test.go`, `cmd/vod/main.go` wiring, `electron-app` untouched this phase). Additive routes disappear; no schema, no data, no client-contract impact; V1 launch flow restored exactly.

## Remaining risks

- `firstEnv` in `cmd/vod/main.go` is now unused (superseded by `config.LoadServerConfig`); left in place to keep the diff strictly additive — remove in the P8 dead-code sweep or a later refactor task.
- Prowlarr readiness uses `/api/v1/health` with the API key header; if a deployment's Prowlarr requires a different health path, `/readyz` would report `prowlarr: degraded` — configurable surface arrives with the P7 server package.
