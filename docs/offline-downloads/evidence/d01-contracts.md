# D01 evidence — finalized download/progress/server-identity contracts

Recorded: 2026-09-29 · Source: branch `001-build-torwatch-version` (D01 commit).

## Deliverables

- **`docs/offline-downloads/contracts.md`** — the finalized contract: `downloads.offline.v1`
  capability gate, persistent `instanceId` in `/v1/version`, preparation-job
  create/read/cancel/renew schemas, closed safe reason codes, ready-manifest
  schema with URL-ownership rules, asset serving headers (ETag/Range/If-Range,
  200/206/416), retention (48h default, renewable, 14-day cap), and the
  conditional idempotent offline-progress import with conflict shape.
  Includes the data-ownership/migration note (§7).
- **`torrent-streamer/internal/downloads`** — the contract as tested pure logic
  BEFORE any HTTP consumer:
  - `jobs.go`: job state machine (`preparing → ready|failed|cancelled`,
    `ready → cancelled|expired`, terminal states have no exits), closed
    (state, reasonCode) enumeration, retention math (renewal from the renewal
    instant, clamped to the 14-day cap, expired jobs are not renewable).
  - `manifest.go`: manifest validation — origin-relative asset paths owned by
    the job, character whitelist (credentials/tokens/`..`/queries structurally
    impossible), positive sizes, 64-hex SHA-256 validators, future expiry,
    unique subtitle languages.
  - `progress.go`: conditional offline-progress decision — idempotency ledger
    replay wins; commit only when the record state matches the device's base
    (absent+0, or base == revision); deliberate rewind is a valid write;
    stale base → conflict carrying the CURRENT position/revision (WF08 input);
    no furthest-position-wins and no wall-clock inference anywhere.
  - `instance.go`: `EnsureInstanceID` — singleton persistent identity,
    race-safe creation, stable across calls/restarts.
- **`migrations/009_downloads.sql`** — additive only: `server_instance`,
  `download_jobs` (UNIQUE (client_id, idempotency_key), state/reason CHECK
  mirroring the Go enumeration, ready-state/ready-at consistency),
  `download_assets` (immutable, cascade with the job), and
  `offline_progress_updates` (idempotency ledger). No existing table or column
  is altered; downgrade is safe.
- **Version discovery** — `buildinfo.Info` gained optional `instanceId`
  (omitempty), wired in `cmd/vod/main.go` after the DB is up;
  `specs/001-build-torwatch-version/contracts/protocol-negotiation.md`
  documents the additive field. Existing streaming/session/watch APIs are
  untouched; `downloads.offline.v1` is deliberately NOT advertised until D02
  makes it functional.

## Test results

| Suite | Result |
|---|---|
| `go vet ./...` | pass |
| `go test ./...` (full, `-count=1`) | pass — includes 30+ new contract tests: state machine, retention, manifest rejection matrix (17 unsafe-path/schema cases), offline-progress outcomes (commit/conflict/duplicate/invalid, rewind, clamp, ledger replay), instance-identity stability |
| `migrations/009` DB verification | pending `TORWATCH_TEST_PG_DSN` (skipped honestly, per the 005 pattern) — needs a disposable PostgreSQL run |
| Client suites | `npm test` unchanged-green; `version-check.ts` type gained optional `instanceId` |

## Honest scope notes

- HTTP handlers, bounded admission, and the prep pipeline are D02; the D01
  tests pin the semantics those consumers must implement (contract-first).
- DB-dependent verification (migration apply + instance stability) is
  recorded as pending, never passed, until a disposable database run.
