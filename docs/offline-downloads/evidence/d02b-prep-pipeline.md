# D02b evidence — preparation pipeline (torrent acquisition → atomic finalize → serving)

Recorded: 2026-09-29 · Source: branch `001-build-torwatch-version` (D02b commit).

## What was built

- **`internal/downloads/prep.go`** — the `Prepper`:
  - Bounded admission (`TORWATCH_DOWNLOAD_MAX_CONCURRENT`, default 1): a claim
    loop fills capacity; `claimed_by`/`claimed_at` with a 15-minute stale-claim
    window recovers from crashes while running.
  - Startup reconciliation releases claims held by a previous process
    (contracts.md §3 "server restart resumes/reconciles preparation").
  - Per job: resolve the validated pick by id (opaque identity, never user
    URLs) → hold the engine's active reference BEFORE adding the torrent so
    idle/size eviction can never drop it mid-preparation → metadata wait
    (bounded 10m) → file selection from the pick's validated file index (no
    silent source replacement) → full-file copy through the engine reader
    into `<downloadsRoot>/staging/<jobId>` with SHA-256 computed on the fly
    and progress logging → subtitle sidecars from torrent-internal files
    matching the requested languages.
  - Atomic finalize: rename staging → ready on the same volume, then ONE
    transaction (`MarkReady`) attaches the asset rows and flips the state; a
    concurrent client cancellation is detected and the staged bytes are
    discarded. A requested subtitle language the source cannot provide fails
    the job with `preparation_failed` — never silently ready (contracts §4).
  - Retention sweep: `ExpireDue` flips expired jobs, deletes asset rows and
    removes files under a containment-checked path (`filepath.Base(jobID)`
    + prefix checks; never outside the resolved root).
- **Asset serving** — `GET /v1/downloads/jobs/{id}/assets/{rest...}`: ETag
  derived from the recorded SHA-256 (stale If-Range downgrades to full 200 —
  never mixed-revision bytes), `Accept-Ranges`, and net/http's native
  Range/If-Range handling for correct 200/206/416. Containment-checked disk
  resolution; client-scoped like every other surface.
- **Storage isolation** — prepared bytes live under
  `TORWATCH_DOWNLOAD_ROOT` (default `<dataRoot>/downloads`), a root the cache
  janitor never reads or evicts: downloading cannot starve streaming and can
  never be evicted mid-transfer.
- **Capability** — `downloads.offline.v1` is advertised ONLY when the storage
  root is writable at boot (verified ready/staging dirs); otherwise the
  server boots without it and the surface stays inert.
- **Contract amendment** (migration 009 is unapplied anywhere, so amending it
  is safe): create request gained optional `subtitles` (lowercase ISO 639-1
  list); `download_jobs` gained `requested_subtitles`/`claimed_by`/
  `claimed_at`; `download_assets` carries both the public URL path and the
  disk-relative path.

## Verification

| Suite | Result |
|---|---|
| `go vet ./...` / `go build ./...` | pass |
| `go test ./... -count=1` (all packages) | pass — new tests: manifest assembly validates under its own contract, extension whitelist, download-path containment, hostile job-id containment |
| HTTP contract tests | extended via the updated `Service` interface (asset resolution included) |
| Store lifecycle + migration 009 against a disposable DB | **pending `TORWATCH_TEST_PG_DSN`** — skipped honestly |
| Live end-to-end prep (real torrent → ready → local playback) | **pending** — requires a running homeserver + controlled authorized media; server cases D1/D2/D5/D6/D10 and "stream while preparation is active" remain unexecuted until then |

## Honest notes

- The pipeline reuses the engine's proven primitives (client per category,
  magnet sanitization, tracker tiers, responsive readers, active-reference
  protection) rather than introducing a second torrent path.
- Simultaneous streaming + preparation of the same title shares one client
  and one torrent object; the active reference keeps both safe. The
  concurrent-viewing acceptance case (D6) still needs a live run.
- Windows development environment: long-path handling reuses the engine's
  existing `winLongPath` behavior implicitly via the engine's own data dirs;
  the downloads root uses plain relative assembly and the containment checks
  above.
