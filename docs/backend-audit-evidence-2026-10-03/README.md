# Audit evidence

These logs belong to the audit of revision cf41dd9. Application source was not modified.

| File | Meaning |
| --- | --- |
| existing-suite-race.txt | Existing race-enabled suite against an initialized disposable database. |
| existing-suite-go124.txt | Existing suite using the Dockerfile's Go 1.24.2 compiler, against a separately initialized disposable database. |
| reproductions.txt | Expected-behavior tests demonstrating recommendation fallback recursion, empty search errors, renewal inconsistency, stale claims, category port collisions, and stalled reads. Failures are intentional audit evidence. |
| catalog-race.txt | Shared cached catalog mutation and concurrent race reproduction. |
| additional-reproductions.txt | Browser preflight, HDR planning, and diagnostic log retention reproductions. |
| vulnerabilities-source.txt | govulncheck source analysis with host Go 1.26.8. |
| vulnerabilities-go124-binary.txt | govulncheck binary analysis after rebuilding with Go 1.24.2. Symbol matches do not prove exploitation. |
| fresh-db-concurrent-initialization.txt | Suite run on an empty database: concurrent migration failures plus fixture ordering failures. |

make-reproductions.py generates temporary Go tests and an overlay JSON outside the source tree. It accepts the module directory and an output directory:

    python3 make-reproductions.py /srv/movie-watcher/torrent-streamer /tmp/torwatch-review-repros

From the module directory, run the generated tests using the overlay:

    TORWATCH_TEST_PG_DSN='<disposable PostgreSQL DSN>' go test -race -overlay=/tmp/torwatch-review-repros/overlay.json -run '^TestAudit' ./internal/recommendations ./internal/search ./internal/catalog ./internal/downloads ./internal/torrentx ./internal/httpapi ./internal/playback ./internal/logx

The database must be disposable; reproduction tests create jobs and modify their claim timestamps. The category-port test uses a child process and temporary storage. The stalled-reader test uses a local torrent with no peers and drops it during cleanup. The recursion test uses recoverable errors to avoid deliberately exhausting memory. A working C/C++ compiler is needed for the race-enabled torrent build.

These tests assert the desired behavior and are expected to fail until the corresponding issues are repaired. They use existing package test fakes and are therefore tied to the reviewed revision.
