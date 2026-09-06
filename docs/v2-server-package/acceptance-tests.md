# TorWatch Version 2 server-package acceptance tests

This is the release gate for the standalone package. Checkboxes must be backed
by captured commands and results. “Works on my machine” is not sufficient.

## 1. Test-report template

Create `docs/v2-server-package/test-reports/<version>-<date>.md` for each release
candidate with:

```text
Version:
Git revision:
Bundle checksum:
Application image digest:
Dependency image digests:
Host model/architecture:
OS and kernel:
Docker and Compose versions:
Storage device/filesystem/free space:
Deployment mode: direct | embedded-vpn
Commands and results:
Skipped optional live tests and reason:
Resource observations:
Known limitations:
Verdict: pass | fail
```

Do not include `.env`, credentials, magnet URIs, provider authorization headers,
or unredacted logs in the report.

## 2. Mandatory source tests

From `torrent-streamer/`:

```bash
gofmt -w <changed-go-files>
go vet ./...
go test ./...
go test -race ./...
```

The race suite may be split when a documented dependency cannot run a specific
network test under the race detector, but all application-owned packages must
remain covered. A blanket skip is not acceptable.

From `electron-app/`:

```bash
npm test
```

These existing suites protect skip-segment behavior, diagnostics/redaction,
player state contracts, secure preloads, and network routing. Packaging work
must not weaken them.

## 3. Required new unit tests

### Configuration

- [ ] Version 1 environment names still produce the same effective settings.
- [ ] Container defaults use service DNS and mounted paths supplied by Compose.
- [ ] Required values fail fast with useful, redacted errors.
- [ ] Invalid durations, sizes, modes, addresses, and paths are rejected.
- [ ] Secret values and DSN passwords never appear in errors or logs.
- [ ] Writable-directory validation handles permission failures.

### System endpoints

- [ ] `/healthz` permits GET and responds within its bound.
- [ ] `/readyz` is 200 when required dependencies are ready.
- [ ] `/readyz` is 503 with safe component state when PostgreSQL is unavailable.
- [ ] Prowlarr degraded/optional state follows the documented readiness policy.
- [ ] `/v1/version` contains version, revision, protocol, Go version, OS, and arch.
- [ ] Wrong methods return 405 with an `Allow` header.
- [ ] Dependency timeouts cancel rather than leaking goroutines.

### Prowlarr bootstrap

- [ ] Explicit API key is preferred.
- [ ] Generated key can be read from the configured read-only file.
- [ ] Missing or malformed config has a bounded, redacted failure.
- [ ] Existing indexers are never altered.
- [ ] Empty Prowlarr receives the starter set once.
- [ ] Repeated and concurrent bootstrap calls are idempotent.
- [ ] Partial starter failure is recoverable without duplicating successes.
- [ ] Cancellation stops waits promptly.
- [ ] Captured logs contain no API key.

### Existing API regression

- [ ] Search still runs query variants concurrently and does not grab a result.
- [ ] Resolve grabs only the selected source and caches the magnet.
- [ ] Invalid magnet/source inputs remain rejected.
- [ ] Range parsing handles full, prefix, suffix, invalid, and unsatisfiable ranges.
- [ ] `HEAD` returns streaming headers without writing the body.
- [ ] Buffer stop does not add a missing torrent.
- [ ] Subtitle URL building and language filtering remain compatible.
- [ ] Progress resume retains the current rewind behavior.
- [ ] Cache path traversal remains rejected.
- [ ] Diagnostics retain redaction and error-index linkage.

## 4. Image tests

- [ ] `linux/amd64` image builds from a clean checkout.
- [ ] `linux/arm64` image builds from the same revision.
- [ ] Multi-architecture manifest contains both platforms.
- [ ] Native container reports the correct architecture at `/v1/version`.
- [ ] Container process is not UID 0.
- [ ] Image contains CA certificates and completes an HTTPS provider probe.
- [ ] Image contains no `.env`, repository secrets, logs, or host data.
- [ ] Read-only root filesystem works when required paths are mounted writable,
      or every required writable exception is documented.
- [ ] `SIGTERM` performs graceful shutdown inside the configured grace period.
- [ ] Vulnerability scan has no unreviewed critical findings.
- [ ] Secret scan has no findings.

## 5. Compose configuration tests

Run against safe generated test credentials:

```bash
docker compose --env-file .env.test -f compose.yaml config --quiet
docker compose --env-file .env.test -f compose.yaml -f compose.vpn.yaml config --quiet
```

- [ ] No service references a floating `latest` tag in the release manifest.
- [ ] Only the gateway has a LAN-published port.
- [ ] PostgreSQL has no host port.
- [ ] Prowlarr has no LAN host port.
- [ ] FlareSolverr has no host port.
- [ ] Gluetun proxy/control ports have no host port.
- [ ] Secrets are not rendered into labels, commands, or healthcheck output.
- [ ] Persistent paths all resolve beneath the configured test data root.
- [ ] Log rotation and stop grace period are present.
- [ ] Direct and VPN effective configurations use the intended networks.

## 6. Disposable-stack integration tests

Use a temporary absolute data root created solely for the test. Resolve and
verify it before cleanup; never point automated cleanup at the repository root,
home directory, `/`, or an unvalidated environment variable.

### Startup and readiness

- [ ] Empty volumes initialize successfully.
- [ ] PostgreSQL migrations apply exactly once.
- [ ] API becomes healthy and ready within the documented cold-start bound.
- [ ] Prowlarr bootstrap completes or reports optional degradation clearly.
- [ ] FlareSolverr is reachable from Prowlarr where configured.
- [ ] Restarting every container does not reinitialize or lose data.

### Networking and isolation

- [ ] Gateway is reachable from a second LAN host.
- [ ] Internal API port is not reachable directly from that host.
- [ ] PostgreSQL, Prowlarr, FlareSolverr, and Gluetun are not reachable directly.
- [ ] Direct mode uses the expected host egress route.
- [ ] VPN mode API/torrent namespace uses the Gluetun egress address.
- [ ] Stopping Gluetun blocks VPN-mode egress and does not leak through the host.
- [ ] Gateway remains able to report a safe unavailable state during VPN failure.

### Gateway streaming contract

Using a legal local fixture or controlled test torrent:

- [ ] Full GET has expected content length and checksum.
- [ ] `Range: bytes=0-1023` returns 206 and exactly 1024 correct bytes.
- [ ] Mid-file and suffix ranges return correct bytes.
- [ ] Invalid range returns 416 with correct total length.
- [ ] HEAD returns the same relevant headers with no body.
- [ ] Seeking through a test player produces range requests and resumes promptly.
- [ ] Gateway does not buffer the complete object before sending the first byte.
- [ ] Client cancellation closes upstream work promptly.
- [ ] SSE buffer updates arrive incrementally and survive at least two keepalives.
- [ ] Subtitle delivery retains its content type and byte contents.

### Persistence

- [ ] A progress record survives API recreation.
- [ ] A source pick survives API and PostgreSQL restart.
- [ ] Prowlarr settings survive recreation.
- [ ] Subtitle cache survives recreation.
- [ ] Partially downloaded torrent data resumes rather than starting from zero.
- [ ] IMDb ratings remain available after a failed refresh.

### Backup, restore, update, rollback

- [ ] Backup produces a manifest and valid checksums.
- [ ] Failed backup leaves the previous successful backup untouched.
- [ ] Restore rejects a corrupt checksum before stopping the live stack.
- [ ] Restore recreates database progress/picks and Prowlarr configuration.
- [ ] Update requires an explicit version and makes a pre-update backup.
- [ ] Update preserves data and passes verification.
- [ ] Rollback to the declared compatible prior version preserves data.
- [ ] A migration that prevents binary rollback is clearly detected and reported
      before update, with restore-from-backup instructions.

## 7. Existing Version 1 regression checks

- [ ] Root `docker compose config` still succeeds.
- [ ] The root Compose service names and environment contract used by Electron
      remain unchanged unless a separately reviewed Version 1 fix requires it.
- [ ] Windows backend build still produces `torWatcher.exe`.
- [ ] Electron can start its local backend and reach `/healthz`.
- [ ] Search-to-resolve-to-stream works in the existing desktop flow.
- [ ] Embedded MPV can seek, pause, resume, select subtitles, save progress, and
      reopen the saved source.
- [ ] Closing Version 1 Electron retains its documented local shutdown behavior.

The Version 2 package does not need Electron to operate, but shared Go changes
must not break the frozen Version 1 line.

## 8. Radxa hardware acceptance

Run on the actual ROCK 3A 4 GB target:

- [ ] Host is using a 64-bit OS and native ARM64 images.
- [ ] Persistent data is on the intended SSD/NVMe mount after reboot.
- [ ] Cold boot brings the stack to readiness automatically.
- [ ] No container is OOM-killed during startup, search, metadata acquisition,
      one sustained direct 1080p stream, subtitle fetch, and IMDb refresh.
- [ ] CPU/memory are recorded for idle, search, initial buffer, and steady stream.
- [ ] At least 30 minutes of direct playback completes without server failure.
- [ ] Seeking forward and backward works repeatedly.
- [ ] A second metadata/search operation during playback does not interrupt it.
- [ ] Disk usage and cache eviction behave as configured.
- [ ] Controlled power/reboot recovery retains PostgreSQL, Prowlarr, progress,
      subtitles, and partial download data.
- [ ] Embedded VPN kill-switch test passes when that mode is released.
- [ ] Backup and restore complete using the Radxa storage paths.

This milestone does not require software video transcoding. Test media must be
direct-play compatible with the chosen test client.

## 9. Optional credential-dependent live checks

These are valuable but must be explicitly enabled and skipped safely otherwise:

- OpenSubtitles live search/download;
- real configured Prowlarr indexer search;
- FlareSolverr-backed challenge resolution;
- VPN-provider connection;
- IMDb dataset refresh from the official source.

Record only pass/fail, duration, and redacted error information.

## 10. Release verdict

A release is a pass only when every applicable mandatory checkbox is satisfied.
Any skipped mandatory item makes the verdict fail. Optional live checks may be
skipped when credentials are unavailable, but the corresponding mocked and
integration contracts must still pass.

