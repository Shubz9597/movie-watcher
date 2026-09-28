# D02a evidence — durable download job store + HTTP surface (capability unadvertised)

Recorded: 2026-09-29 · Source: branch `001-build-torwatch-version` (D02a commit).

## Scope of this increment

The first D02 vertical slice, deliberately kept safely inactive per the
constitution ("partial implementations MUST be protected by an isolation
boundary"):

- `internal/downloads/store.go` — PostgreSQL `Store` implementing the D01
  `Service` contract: idempotent create (UNIQUE client+key, replay returns
  the same job with 200), client-scoped get, cancel rules (preparing only —
  device removal is device-side), renewal (extends from the renewal instant,
  expired jobs refused), `MarkReady` (re-validates the complete manifest so
  an invalid package can never become ready — acceptance D7), read-time
  manifest re-validation, and bounded `ExpireDue` for retention cleanup.
- `internal/httpapi/downloads_handlers.go` — the `/v1/downloads/*` surface
  from contracts.md §3–§4: `POST jobs`, `GET jobs/{id}`, `POST …/cancel`,
  `POST …/renew`, `GET …/manifest`. Safe machine-readable error envelopes
  (`not_found`, `not_cancellable`, `retention_expired`, `invalid_source`,
  `bad_json`); internal failures never leak details; `clientId` UUID
  validation comes from the shared `negotiationContext` convention.
- Wired in `cmd/vod/main.go` additively. **`downloads.offline.v1` is NOT
  advertised** — clients never call unadvertised surfaces, so the routes are
  verifiably inert until the prep pipeline (D02b) makes them functional.

## Verification

| Suite | Result |
|---|---|
| `go vet ./...` | pass |
| `go build ./...` | pass |
| `go test ./... -count=1` | pass — all packages green |
| New HTTP contract tests (`contract_downloads_test.go`, scripted service) | create 201/200-replay, safe bodies, client scoping (foreign/missing clientId → 404, no leak), cancel 200/409, renew 200/409-retention_expired, manifest 200/not-ready-and-internal-error safety |
| New store test (`store_test.go`, real SQL lifecycle) | passes logically; **DB execution pending `TORWATCH_TEST_PG_DSN`** — skipped honestly, never claimed passed |

## Honest notes

- The prep pipeline (acquisition via torrentx, byte movement into the
  download root, hashing, restart reconciliation) is D02b; until then NO
  code path flips a job to `ready` in production, and the capability is not
  advertised, so there is no dead-end user journey.
- DB-backed verification (store lifecycle + migration 009 apply) both await a
  disposable PostgreSQL run (`TORWATCH_TEST_PG_DSN`); both are recorded as
  pending, not passed.
- Asset serving (`GET …/assets/*`, Range/If-Range) is D02b; the retention and
  reader-pinning semantics it must satisfy are already contract-tested.
