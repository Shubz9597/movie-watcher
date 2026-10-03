# Backend audit fixes — 2026-10-03

The 13 concrete findings in the [original audit](backend-production-audit-2026-10-03.md)
have been addressed in the working tree. The backend remains a single trusted
household service. This change does not add independent public user accounts.

| Audit finding | Result |
| --- | --- |
| 1. Category client initialization | Free ports by default; configured base plus per-category offset; errors return to callers and support retry. |
| 2. Recommendation recursion | A failed taste lookup calls the favourites fallback once and marks the result degraded; cancellation stops work. |
| 3. Stalled torrent reads | Prebuffer uses a deadline context; stream, warmer, preparation, subtitle and playback readers use the operation context. Session deletion/revocation cancels media reads. Shutdown cancels requests and joins preparation workers. |
| 4. Catalog data race | Cache ingress/egress and merges copy maps and slices, including detail, sections and episodes. |
| 5. Compiler/dependencies | Go 1.27.1, torrent 1.61.0, pgx 5.11.0, and patched networking/text/telemetry dependencies. Source, release binary, and actual Docker binary rescanned; see the scan qualification below. |
| 6. Live claim stolen | The single process serializes admission and recovers abandoned claims at startup. Elapsed time never releases a running preparation claim. |
| 7. Empty search response | Successful empty arrays stay successful. Wrapper objects are decoded by their shape. |
| 8. Renewal expiry | A row-locked transaction updates job and manifest expiry together. Read-time expiry comes from the authoritative job column, repairing legacy manifests. Content revision stays immutable. |
| 9. Browser preflight | Download CORS permits POST; taste registers OPTIONS. |
| 10. HDR policy | Unsupported HDR is rejected before codec conversion decisions. |
| 11. Memory retention | Zero-window logs retain no dedup history; positive windows prune and cap records. Subtitle/search memory caches bound age, entries and bytes; provider disk cache is bounded too. |
| 12. Storage reclamation | Preparation records source manifests, reserves disk capacity, and preserves active-use guards. Source cache defaults to 20 GiB/24 hours and excludes prepared packages from its budget. Eviction handles final and `.part` storage names, including legacy manifests. Expired cleanup persists until file and row removal succeed; startup removes unpublished leftovers. |
| 13. Concurrent migrations | One transaction takes an advisory lock before creating the ledger and holds it across all version checks and pending migrations. |

Verification also exposed a search-cache ordering issue: a fast initial response
could overwrite completed background results, and persisted completion could
be observed before the memory cache update. Completed publication now happens
first; initial publication cannot replace an existing completed result. Its
race tests passed 30 repetitions.

## Verification

The [evidence directory](backend-fix-evidence-2026-10-03/README.md) records:

- All-package race tests on fresh PostgreSQL state and the new failure regressions.
- Concurrent migrations on empty/upgrading schemas, renewal, cleanup retry after a real permission failure, restart recovery, and source reclamation.
- Actual unavailable-piece timeout/cancellation tests and session/reader lifecycle tests.
- FFmpeg integration tests in the built non-root runtime image, plus image health and clean SIGTERM exit.
- `go vet`, Docker/Compose checks, and Windows AMD64/Linux ARM64 cross-builds.

Source and unstripped-binary scans find **zero affected symbols and zero
advisory-bearing imported packages**. The stripped Docker binary reports
GO-2026-5932 using the scanner's module-level fallback: the OpenPGP packages in
x/crypto are unmaintained, but the backend does not import them. The dependency
is required for other cryptographic packages. This residual module alert is
recorded rather than described as an application exploit or a fully empty scan.

## Deployment implications

- Build with Go 1.27.1 or newer; the Docker compiler is pinned to 1.27.1.
- Migration `011_download_cleanup.sql` runs automatically on startup and adds a nullable completion timestamp and index. It is additive.
- Run one backend process per database and persistent data tree. This is the existing process-owned storage model; shared replicas need a different worker/claim design.
- `CACHE_MAX_BYTES` defaults to 21474836480; `CACHE_EVICT_TTL` defaults to 24h. Zero explicitly disables the corresponding policy. Prepared packages keep their independent renewable retention.
- `TORRENT_LISTEN_PORT=0` selects free ports. A positive base uses four consecutive ports in movie/TV/anime/misc order, and must be at most 65532.
- Disk admission accounts conservatively for source and copy plus a 256 MiB reserve and other preparation workers. Other processes can still consume disk space during a transfer.

The audited code blockers are resolved for the private-household deployment.
Real swarm/indexer performance, load capacity, and physical Windows/ARM64
playback remain outside this verification. Hosting unrelated users on one public
instance still requires authenticated identity and server-enforced ownership;
caller-provided client/subject IDs are not account authentication.
