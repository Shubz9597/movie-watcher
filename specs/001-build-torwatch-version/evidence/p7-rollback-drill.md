# P7 migration/rollback drill (T062)

Executed: 2026-09-06, this session. Disposable PostgreSQL only (`postgres:16-alpine` container `torwatch-pg-drill`, published to 127.0.0.1:54329, user `torwatch`, throwaway password). No production volume or data touched. Docker Desktop engine was started during this session (`ServerVersion 28.3.2`); it was unavailable in the earlier audit.

## Environment

- Working directory for builds/tests: `torrent-streamer` (module root), `GOCACHE` redirected to a writable temp dir.
- Current binary: `go build -o %TEMP%\torwatch-drill\current\torWatcher.exe ./cmd/vod` (working tree incl. migrations 005/006).
- Pre-005 binary: `git worktree add %TEMP%\torwatch-drill\pre005-src HEAD` (HEAD `bd11a90a` predates the untracked migrations/005+006), then `go build -o %TEMP%\torwatch-drill\pre005\torWatcher.exe ./cmd/vod` inside the worktree. The dirty working tree was not touched by the worktree.

## 1. Migration set applied by the current binary (disposable DB `torwatch_drill`)

- Env: `PG_DSN=postgres://torwatch:...@127.0.0.1:54329/torwatch_drill?sslmode=disable`, `LISTEN=127.0.0.1:40011`.
- `GET /healthz` → `{"status":"ok"}`; `GET /readyz` → 200.
- `schema_migrations` recorded exactly: 001_core.sql, 002_resume_integrity.sql, 003_progress_source.sql, 004_imdb_ratings.sql, 005_progress_multiclient.sql, 006_progress_session_sequences.sql. The current set including **006** is covered, not only 005.

## 2. DB-gated suites against the same disposable engine

- `go test -p 1 -count=1 -v ./migrations/ ./internal/watch/` with `TORWATCH_TEST_PG_DSN` set: ALL PASS —
  - TestMigration005Additive, TestMigration006PreservesKnownSessionSequence, TestMigrationFilesAreWellFormed, TestEmbedIntegrity;
  - all ordered-write decision/DB-level tests incl. TestConcurrentFirstProgressWrites (sameSession true/false), TestSessionSequencesSurviveStoreReopen, TestOrderedProgressRevisionMonotonic, characterization LWW/rewind/resume-queueing/source-snapshot tests.
  - Note: package binaries must run with `-p 1` (or separate DBs per package) — concurrent application of the migration set to one database collides on `schema_migrations`; the tests are written for a disposable DB per run.
- Full suite `go test -p 1 ./...`: PASS (exit 0).

## 3. Pre-005 binary against the migrated database (additive rollback proof)

- Env: same `PG_DSN`, `LISTEN=127.0.0.1:40012`.
- The pre-005 binary started, `GET /healthz` → `{"status":"ok"}`, and `schema_migrations` still recorded 6 entries (no destructive or re-entrant migration behavior observed).

## 4. Backup / restore round trip

- Row inserted: `watch_progress(subject_id='drill-subject', series_id='tmdb:tv:1', season=1, episode=1, position_s=600, duration_s=1440, percent=41.7)` (note: `percent` is NOT NULL; the first insert attempt without it failed — schema behavior recorded honestly).
- `pg_dump` → DROP DATABASE → CREATE DATABASE → restore: exit 0.
- Post-restore: `schema_migrations` count = 6; `watch_progress` row intact (position_s=600, progress_revision=1). Household/progress data survive a binary rollback scenario.

## Limits

- The disposable stack ran the backend directly on the host, not inside the compose package (Prowlarr/Caddy not exercised here; T059/T061 remain open).
- `go test -race ./...` was not run (no suitable C toolchain in this session; CGO_ENABLED=0) — T064's race gate stays open.
- No real provider/media traffic in this drill.
