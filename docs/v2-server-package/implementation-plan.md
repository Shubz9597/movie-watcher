# TorWatch Version 2 server-package implementation plan

This plan is intentionally executable in small checkpoints. The implementing
agent should update the checklist and attach command evidence to the final test
report. Do not skip a phase because a later phase appears to work manually.

## Phase 0: protect the baseline

### Goal

Record current behavior before packaging changes and ensure unrelated user work
is not overwritten.

### Steps

1. Read `README.md`, `PRODUCT.md`, `docs/owner-manual.md`, this handoff, and any
   applicable `AGENTS.md` files.
2. Inspect `git status --short` and preserve unrelated changes.
3. Run and record:

   ```powershell
   Set-Location torrent-streamer
   go test ./...
   go vet ./...

   Set-Location ../electron-app
   npm test

   Set-Location ..
   docker compose config
   ```

4. Capture the current route list and representative JSON shapes for health,
   search, resolve, progress, resume, subtitles, buffer info, and stats using
   tests or a local disposable stack.
5. Confirm the existing Windows backend build still succeeds when its normal
   prerequisites are available. Do not require Windows packaging on Linux CI,
   but preserve it in the Windows release gate.
6. Create a test-report file from the template described in
   `acceptance-tests.md` and record failures before changing code.

### Exit gate

Baseline failures are understood and documented. Packaging work must not be used
to conceal or reclassify an existing regression.

## Phase 1: extract package-safe server configuration

### Goal

Make the existing Go service deterministic and fail-fast in a headless Linux
container while preserving Version 1 environment compatibility.

### Planned code changes

1. Add a structured server configuration in `internal/config` rather than adding
   more global environment reads throughout the codebase.
2. Keep existing exported getters temporarily so current packages and Electron's
   backend launch contract continue working.
3. Validate required headless settings:
   - non-empty and parseable `PG_DSN`;
   - valid internal `LISTEN` address;
   - non-empty Prowlarr URL and API-key source;
   - writable torrent, subtitle, and log directories;
   - positive/valid buffer and timeout values;
   - recognized tracker and deployment modes.
4. Ensure configuration errors identify the setting but never echo its secret
   value or DSN password.
5. Keep `.env` loading as a development convenience only. Container releases
   receive explicit environment configuration and must not depend on a working
   directory containing repository files.
6. Add table-driven tests for defaults, explicit values, invalid values, secret
   redaction, path creation, and Version 1 compatibility.

### Suggested files

- edit `torrent-streamer/internal/config/config.go`;
- add `torrent-streamer/internal/config/server.go`;
- add `torrent-streamer/internal/config/server_test.go`;
- minimally edit `torrent-streamer/cmd/vod/main.go` to consume validated config.

### Exit gate

All existing Go tests pass, new config tests pass, and the Windows runtime's
current environment block remains accepted without changes.

## Phase 2: add build information and system endpoints

### Goal

Make container orchestration and future clients able to identify liveness,
readiness, version, protocol, and architecture.

### Planned code changes

1. Add `internal/buildinfo` variables populated with linker flags and safe
   development defaults.
2. Extract the inline `/healthz` handler from `cmd/vod/main.go`.
3. Implement:
   - liveness at `/healthz` without an external network dependency;
   - readiness at `/readyz` with bounded PostgreSQL and Prowlarr checks;
   - build data at `/v1/version`.
4. Use dependency injection so tests use fake checks rather than real services.
5. Preserve current `/healthz` status behavior for existing consumers. If its
   current database dependency is intentionally changed to readiness, retain a
   compatibility path or update all known consumers in the same commit with
   tests.
6. Add method restrictions, JSON content types, timeouts, and redacted component
   errors.

### Suggested files

- add `torrent-streamer/internal/buildinfo/buildinfo.go`;
- add `torrent-streamer/internal/httpapi/system_handlers.go`;
- add `torrent-streamer/internal/httpapi/system_handlers_test.go`;
- edit `torrent-streamer/cmd/vod/main.go` only for wiring.

### Exit gate

Handler tests cover healthy, degraded, timed-out, wrong-method, and version
responses. Existing runtime readiness tests still pass.

## Phase 3: make Prowlarr bootstrap headless

### Goal

Remove Electron as a runtime requirement for a fresh server package while
preserving existing Prowlarr installations.

### Planned code changes

1. Extract or port the wait/readiness/bootstrap semantics currently in
   `electron-app/electron/runtime/runtime-manager.js`.
2. Define an interface for Prowlarr system status, indexer listing, and indexer
   creation so tests can use `httptest.Server`.
3. Accept an explicit `PROWLARR_API_KEY` first.
4. When enabled and no explicit key exists, read the generated key from a
   read-only mounted Prowlarr config path. Parse XML structurally; do not use a
   broad regular expression over arbitrary files.
5. Preserve any non-empty indexer list exactly.
6. On an empty installation, add the same starter definitions Version 1 uses.
7. Make retries bounded, cancellable, and safe across restarts.
8. Treat optional starter failures as degraded status, not a fatal database or
   API failure. Expose the state through logs/readiness without secrets.
9. Add parity protection between Electron and server starter definitions until
   both can import a single declarative file.

### Suggested files

- add `torrent-streamer/internal/bootstrap/prowlarr.go`;
- add `torrent-streamer/internal/bootstrap/prowlarr_test.go`;
- optionally add `config/prowlarr-starters.json` if both runtimes can consume it;
- edit `cmd/vod/main.go` to run bootstrap before advertising full readiness.

### Required tests

- explicit API key path;
- generated config key path;
- missing/malformed config;
- Prowlarr not ready then ready;
- existing indexers untouched;
- empty instance receives starters once;
- one starter failure does not duplicate successful starters on restart;
- cancellation and timeout;
- logs contain no API key.

### Exit gate

A clean Prowlarr volume becomes usable without Electron, and a populated volume
is byte-for-byte unchanged except for Prowlarr's own normal runtime writes.

## Phase 4: build a multi-architecture application image

### Goal

Produce one minimal non-root Go server image for ARM64 and AMD64.

### Planned files

- `torrent-streamer/Dockerfile`;
- `torrent-streamer/.dockerignore`;
- optionally `torrent-streamer/cmd/healthcheck/main.go`.

### Steps

1. Create a pinned multi-stage builder using the module's Go version.
2. Download modules from `go.mod`/`go.sum` before copying changing source files
   so dependency layers are cacheable.
3. Build with `-trimpath` and linker flags for version, revision, build time, and
   protocol. Do not strip information needed for useful crash diagnostics until
   stack traces have been verified.
4. Prove native `linux/amd64` and `linux/arm64` outputs. Inspect manifests and
   binaries rather than trusting build command output.
5. Use a maintained minimal runtime with CA roots and timezone data.
6. Create and use a non-root user. Declare mounted writable directories but do
   not bake host data into the image.
7. Configure `STOPSIGNAL SIGTERM`; rely on the Go server's graceful shutdown.
8. Add a healthcheck that does not require a large shell/tooling layer. A small
   static Go healthcheck binary is acceptable.
9. Scan the built image for critical/high known vulnerabilities and secrets.
10. Generate an SBOM if the release environment supports it.

### Required commands

The final workflow must have equivalents of:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --tag torwatch-server:2.0.0-alpha.1 \
  --file torrent-streamer/Dockerfile torrent-streamer
docker buildx imagetools inspect torwatch-server:2.0.0-alpha.1
```

For local, non-pushed verification, build and run the native architecture first.

### Exit gate

Both architecture manifests exist, `/v1/version` reports the correct native
architecture, the process runs non-root, and SIGTERM exits cleanly.

## Phase 5: add the standalone Compose bundle

### Goal

Create an additive deployment under `deploy/torwatch-server/`; leave the root
Version 1 manifest functional.

### Planned files

- `deploy/torwatch-server/compose.yaml`;
- `deploy/torwatch-server/compose.vpn.yaml`;
- `deploy/torwatch-server/.env.example`;
- `deploy/torwatch-server/Caddyfile`;
- `deploy/torwatch-server/README.md`;
- narrow `.gitignore` exception for the example environment file.

### Compose requirements

1. Define an internal application network.
2. Publish only the gateway port.
3. Use service DNS names for PostgreSQL, Prowlarr, and FlareSolverr.
4. Mount every path from the persistent-storage contract.
5. Add health checks and `depends_on` readiness where Compose supports it, while
   retaining application-level retry behavior.
6. Set `restart: unless-stopped` for persistent services.
7. Configure Docker log rotation.
8. Set a stop grace period of at least the Go server's shutdown window.
9. Use tested semantic tags/digests; no `latest`.
10. Keep credentials in the operator-created `.env` with mode 0600, not Compose
    labels, command arguments, or checked-in configs.
11. Do not set `container_name` unless an operational requirement justifies it;
    Compose project scoping is safer for parallel test deployments.
12. Add a direct mode and a full-tunnel embedded-VPN overlay as defined in the
    architecture. Validate the kill switch.

### Gateway requirements

1. Default to a configurable LAN port suitable for first installation.
2. Provide a hostname/TLS example without requiring public DNS for the Radxa
   acceptance path.
3. Disable buffering/compression for media and SSE.
4. Preserve byte-range request and response headers.
5. Do not publish an internal admin route.

### Exit gate

Both of these render valid, secret-free effective configurations:

```bash
docker compose --env-file .env -f compose.yaml config
docker compose --env-file .env -f compose.yaml -f compose.vpn.yaml config
```

Inspection shows exactly one intended LAN-facing port.

## Phase 6: add operator scripts

### Goal

Make installation and lifecycle tasks explicit, safe, and repeatable.

### `preflight.sh`

Validate without modifying disks:

- 64-bit `arm64/aarch64` or `amd64/x86_64` host;
- Docker Engine and Compose plugin versions;
- reachable Docker daemon;
- required data root exists on the expected mounted filesystem;
- directory ownership and free disk space;
- `.env` exists, is not world-readable, and contains no unchanged placeholders;
- port availability;
- `/dev/net/tun`, capabilities, and VPN settings when VPN overlay is selected;
- architecture availability for every configured image.

### `verify.sh`

- render Compose configuration;
- report container health without printing secrets;
- check gateway `/healthz`, `/readyz`, and `/v1/version`;
- verify that internal ports are not published;
- issue a range request against a configured test asset when supplied;
- report filesystem usage and recent sanitized errors.

### `backup.sh`

- acquire a lock to prevent concurrent backups;
- create a timestamped temporary directory;
- run `pg_dump` in a consistent format;
- archive Prowlarr configuration and application metadata/configuration;
- exclude disposable torrent payloads by default, but document an opt-in;
- write a manifest containing versions, image digests, and checksums;
- atomically rename a successful backup;
- retain the previous known-good backup if any step fails.

### `restore.sh`

- require an explicit backup path and confirmation;
- validate checksums and manifest compatibility before stopping writers;
- stop gateway/API/background writers while restoring;
- restore into an empty/staged location where practical;
- run migrations through the restored server version;
- restart and call `verify.sh`;
- leave failed restore material available for diagnosis rather than deleting it.

### `update.sh`

- require an explicit target version, never an implicit floating update;
- run preflight and create a backup;
- pull target images and record digests;
- recreate services without deleting bind-mounted data;
- wait for readiness and run verification;
- print exact rollback instructions if verification fails.

PowerShell-specific behavior is not required for Radxa scripts. Keep shell code
POSIX-compatible where reasonable, use `set -eu`, quote every path, and never
construct destructive targets from unchecked empty variables.

### Exit gate

Shell lint passes, scripts have dry-run/help modes where applicable, and backup/
restore is proven with disposable data.

## Phase 7: CI and release workflow

### Goal

Make server releases reproducible and prevent untested ARM64 or Compose changes.

### Required jobs

1. Go format/vet/test.
2. Existing Electron unit tests, because the shared backend contract remains in
   scope for regression protection.
3. Native application image build and smoke test.
4. ARM64 and AMD64 build matrix or multi-architecture buildx manifest.
5. Base and VPN Compose rendering.
6. Disposable Compose integration with health/readiness and persistence checks.
7. Gateway range/SSE behavior.
8. Image vulnerability and secret scan.
9. Release-only signing/checksums/SBOM when supported.

### Release rules

- tags use semantic versions such as `v2.0.0-alpha.1`;
- an immutable image and bundle are produced from the same clean revision;
- dependency digests are recorded;
- database migration and rollback notes are mandatory;
- a release is blocked when mandatory tests fail;
- credential-dependent provider live tests may be reported separately but may
  not make default CI depend on private secrets.

## Phase 8: Radxa acceptance and documentation

### Goal

Prove the release on the actual 4 GB ARM64 target, not only under emulation.

### Steps

1. Follow `radxa-runbook.md` from a clean 64-bit OS and empty data directory.
2. Record board model, OS/kernel, Docker/Compose versions, storage filesystem,
   image digests, and deployment mode.
3. Complete every Radxa test in `acceptance-tests.md`.
4. Record idle, Prowlarr search, torrent metadata, initial buffer, steady direct
   stream, and FlareSolverr memory/CPU observations.
5. Reboot the board during a controlled test and verify automatic recovery and
   persistence.
6. Execute backup, destructive changes only inside the disposable test dataset,
   restore, update to a test tag, and rollback.
7. Correct the package or runbook for every undocumented manual intervention.

### Exit gate

An owner can deploy and operate the package using only the released bundle and
runbook. Source checkout, Electron, Go, and Node.js are not required on Radxa.

## Suggested commit sequence

1. `docs: define v2 server package contract`
2. `server: validate headless configuration`
3. `server: add readiness and build information`
4. `server: own prowlarr bootstrap`
5. `build: add multi-architecture server image`
6. `deploy: add standalone direct-mode compose stack`
7. `deploy: add verified embedded-vpn overlay`
8. `ops: add preflight backup restore update and verify scripts`
9. `ci: verify server images and compose deployments`
10. `docs: record radxa acceptance results`

Each commit must keep `go test ./...` passing. Commits that touch shared Electron
or backend contracts must also keep `npm test` passing.

