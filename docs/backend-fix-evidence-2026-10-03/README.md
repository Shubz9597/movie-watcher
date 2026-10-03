# Backend fix verification — 2026-10-03

These logs concern the working-tree fixes following the original cf41dd9 audit.
No live application data or credentials were used. PostgreSQL state was created
in a task-labelled PostgreSQL 16.9 container. Tests that require existing tables
ran after schema initialization, against fresh data.

- `tests-race-verified.txt`: all packages passed `go test -race -short -count=1 ./...` with Go 1.27.1 and a disposable PostgreSQL DSN.
- `search-completion.txt`: the background-search completion tests passed 30 repetitions under the race detector.
- `migrations-concurrent.txt`: eight simultaneous migrators passed on empty and upgrading isolated schemas; a legacy download row survived the upgrade.
- `torrent-cancellation.txt`: a warmer blocked on an unavailable torrent piece stopped; category clients used distinct configured ports, and initialization could be retried after an occupied-port failure.
- `storage-reclamation.txt`: renewal preserves the content revision and exposes the renewed expiry; inactive source bytes are reclaimable while active preparation and prepared copies are protected.
- `playback-integration-verified.txt`, `httpapi-integration-verified.txt`: real FFmpeg fixture/probe/remux/transcode/subtitle and HTTP tests passed in the built non-root runtime image, with networking disabled.
- `image-smoke.txt`: built image health and SIGTERM shutdown passed against disposable PostgreSQL. Indexer/IMDb URLs deliberately point to an unavailable local test endpoint; this is not provider integration evidence.
- `release-imports.txt`: imported packages of the release build.
- Vulnerability logs: scanner `govulncheck@v1.8.0`, Go 1.27.1, database updated 2026-10-01. Source and unstripped release-binary scans find zero affected symbols and zero advisory-bearing imported packages. One module advisory remains for the unimported, unmaintained OpenPGP packages within x/crypto.

The Docker release strips symbols (`-s -w`). Its binary scan consequently
reports that OpenPGP advisory using module-level matching. This fallback was
verified in `golang.org/x/vuln@v1.8.0/internal/vulncheck/binary.go`, lines 105–112:
when package symbols are unavailable the scanner substitutes all known vulnerable
symbols in the modules. OpenPGP is absent from `release-imports.txt`; this alert
is not evidence that the application imports or calls OpenPGP.

The earlier bind-mounted test executables still exited 139 before test output.
Copying the same binaries into disposable containers let both FFmpeg integration
suites execute and pass. No host FFmpeg tools were used.

Additional completed checks: `go vet ./...`, Linux AMD64 Docker build,
Windows AMD64 and Linux ARM64 cross-builds, Compose configuration validation,
and `git diff --check`. Cross-builds do not constitute device runtime tests.
