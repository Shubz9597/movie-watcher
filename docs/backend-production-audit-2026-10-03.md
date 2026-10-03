# Backend production-readiness audit — 2026-10-03

Reviewed revision: cf41dd9. Scope: the Go backend in torrent-streamer, its commands, supporting reference-client code, embedded migrations, and deployment wiring relevant to runtime behavior. This is an audit; no application fixes were made.

**Follow-up:** the concrete findings below were fixed in the subsequent working-tree change. See [fixes and verification](backend-fixes-2026-10-03.md). The verdict here describes the original cf41dd9 audit snapshot.

**Original verdict: hold a broad production release.** Normal use can terminate the backend, and stalled torrents can hold requests and worker capacity indefinitely. Concurrent catalog requests also have a reproduced data race. These issues apply even to separate installations used by individual users.

The homeserver is deliberately designed for a single trusted household. Hosting one publicly accessible instance for unrelated users would additionally require authentication, authorization, and a different data-scoping model. That requirement is conditional on deployment intent; lack of multi-tenant features is not a defect in the documented private-household design.

## Evidence and limits

- Existing tests passed with the race detector against an initialized disposable PostgreSQL 16.9 database: go test -race -short ./.... The database was created for this audit; it contained no user data.
- The existing short suite also passed using Go 1.24.2 against a separately initialized disposable database. Some database fixtures require schema initialization and fresh test data before the suite runs.
- go vet ./... passed.
- Additional temporary tests reproduced the findings marked “reproduced” below. They were injected through Go's overlay mechanism; production source and existing tests were untouched. Their expected-behavior assertions fail on the reviewed code.
- Source vulnerability scanning used the host's Go 1.26.8 compiler. A separate binary was rebuilt with Go 1.24.2, matching the Dockerfile's compiler pin, and scanned as well.
- No live-user database, running application container, provider credentials, or production torrent data was used.
- FFmpeg integration tests were compiled and attempted in disposable runtime containers. The test executables exited with signal 11 before producing test output, with both host and official Go 1.24.2 builds. Consequently these attempts provide no FFmpeg integration evidence; their cause was not established. Do not interpret them as a reproduced application defect.
- This does not certify live indexer behavior, real-world swarm performance, load capacity, or Windows/ARM64 runtime behavior. Targeted concurrency and failure tests are materially stronger evidence than passing the existing suite alone.

Evidence logs are in [backend-audit-evidence-2026-10-03](backend-audit-evidence-2026-10-03/). Only concrete defects and deployment constraints are included; formatting differences and optional architecture preferences are excluded.

## Findings

### 1. P1 — Opening a second torrent category can exit the entire backend

Location: [torrentx.go:288](/srv/movie-watcher/torrent-streamer/internal/torrentx/torrentx.go:288), especially the shared listen-port configuration and fatal initialization at line 315.

GetClientFor creates one torrent client per movie/tv/anime/misc category. Each client uses the library's default fixed TCP port, 42069. A positive TORRENT_LISTEN_PORT override is also reused for every category. When another category initializes, binding that same port fails, and log.Fatalf terminates the process. Neither the homeserver compose environment nor normal desktop launcher wiring supplies an ephemeral-port override.

**Reproduced:** an isolated subprocess called GetClientFor(movie) then GetClientFor(tv), using an otherwise free positive port. The second initialization exited with “address already in use.” Existing HTTP tests explicitly use port 0, which masks this path.

Fix: use one shared client with appropriate storage routing, or assign distinct/ephemeral ports to category clients. Return initialization errors rather than exiting the process from a request or background worker. Verify movie → TV → anime in one process using release defaults.

### 2. P1 — A taste-store failure triggers unbounded recommendation recursion

Locations: [recommendations.go:372](/srv/movie-watcher/torrent-streamer/internal/recommendations/recommendations.go:372), [recommendations.go:522](/srv/movie-watcher/torrent-streamer/internal/recommendations/recommendations.go:522), and taste wiring in [main.go:263](/srv/movie-watcher/torrent-streamer/cmd/vod/main.go:263).

compute dispatches to computeFromTaste whenever the taste dependency exists. On a HouseholdSignals error, computeFromTaste calls compute again as its supposed legacy fallback. The dependency still exists, so it immediately retries the same failing path. Persistent failure or cancellation can repeatedly query the store until stack/memory exhaustion; it never reaches the favourites-only fallback.

**Reproduced safely:** a fake store failed three times and then recovered. One recommendation request called the taste store four times instead of attempting it once and falling back. A permanent failure follows the same recursion indefinitely; the audit did not intentionally exhaust process memory.

Fix: extract a legacy computation method that bypasses taste dispatch, or return a degraded/unavailable result on failure. Test persistent errors and an already-cancelled context.

### 3. P1 — Torrent reads do not honor the advertised timeout or cancellation

Locations: [torrentx.go:387](/srv/movie-watcher/torrent-streamer/internal/torrentx/torrentx.go:387), [handlers.go:284](/srv/movie-watcher/torrent-streamer/internal/httpapi/handlers.go:284), [torrentsource.go:68](/srv/movie-watcher/torrent-streamer/internal/playback/torrentsource.go:68), [prep.go:430](/srv/movie-watcher/torrent-streamer/internal/downloads/prep.go:430), and [ctl.go:232](/srv/movie-watcher/torrent-streamer/internal/buffer/ctl.go:232).

Prebuffer checks its deadline between Read calls, but a single Read can block indefinitely while waiting for a missing piece. Readers are created without SetContext throughout these paths. Checking request cancellation outside Read cannot interrupt the blocked call.

Download preparation and buffer warming try to unblock reads by calling Reader.Close from another goroutine. In the pinned torrent library, Close removes the reader but does not signal the piece-availability wait. The reader API also does not promise concurrent operation safety. Playback sidecar reads and loopback media readers inherit the same missing cancellation boundary.

**Reproduced:** a local torrent with metadata but no available pieces remained blocked after a 50 ms prebuffer timeout and after Reader.Close. Dropping the torrent finally released the read.

Impact: a dead swarm can hang session creation, leave a disconnected stream holding its active reference, occupy a preparation slot beyond its six-hour timeout, or prevent a warmer stop from completing.

Fix: attach the appropriate request/session/worker context before reading, use a real timeout context for prebuffering, and propagate cancellation through reader factories. Verify missing-piece reads, disconnects, stop, timeout, and shutdown. Preserve the longer lifetime needed by a playback session rather than attaching its media readers to an already-finished creation request.

### 4. P1 — Catalog merging mutates shared cache values and races across requests

Locations: [cache.go:37](/srv/movie-watcher/torrent-streamer/internal/catalog/cache.go:37), [cache.go:87](/srv/movie-watcher/torrent-streamer/internal/catalog/cache.go:87), and [cache.go:176](/srv/movie-watcher/torrent-streamer/internal/catalog/cache.go:176).

Sorting copies Title/Episode structs shallowly. Artwork and ProviderIDs maps still belong to cached provider values. mergeTitle and mergeEpisode write into these maps. The cache's mutex protects cache lookup/storage, not subsequent mutation or JSON serialization of returned values.

**Reproduced:** MergeTitles changed its original provider input. Concurrent Search calls using the same cached overlapping results produced race-detector warnings at cache.go:97–98. Concurrent map reads and writes can also cause a fatal runtime error outside the protection of HTTP panic recovery.

Fix: make cached entities immutable to callers, and deep-copy mutable maps/slices before merging or returning independently mutable values. Add concurrent cached Search/Detail/Episodes tests, including response serialization.

### 5. P1 — The release compiler and dependencies have known security advisories

Locations: [Dockerfile:10](/srv/movie-watcher/deploy/torwatch-server/Dockerfile:10), [go.mod](/srv/movie-watcher/torrent-streamer/go.mod).

The Docker build pins Go 1.24.2. The source scan with the newer host compiler identified five advisories on reachable call paths. Scanning the Go 1.24.2 rebuild identified 37 advisories at symbol level, including standard-library advisories and an additional x/net issue. Binary symbol inclusion is weaker evidence than source call-path analysis: these counts are **not counts of proven exploitable application bugs**.

The source scan's dependency findings include:

| Dependency | Present → advisory fixed version | Relevant condition |
| --- | --- | --- |
| pion/stun/v3 | 3.0.0 → 3.1.5 | Malformed XOR-MAPPED-ADDRESS parsing can panic. [GO-2026-6163](https://pkg.go.dev/vuln/GO-2026-6163) |
| pion/dtls/v3 | 3.0.3 → 3.1.4 | Crafted ECDHE_PSK handshake parsing can panic. Actual exploitation depends on the exercised handshake path. [GO-2026-6165](https://pkg.go.dev/vuln/GO-2026-6165) |
| x/text | 0.27.0 → 0.39.0 | Invalid UTF-8 normalization can loop indefinitely; catalog normalization uses affected functions. This audit did not demonstrate malicious bytes reaching those functions through a production route. [GO-2026-5970](https://pkg.go.dev/vuln/GO-2026-5970) |
| gorilla/websocket | 1.5.0 → 1.5.3 | Weak WebSocket mask randomness; used transitively by torrent networking. [GO-2026-6278](https://pkg.go.dev/vuln/GO-2026-6278) |
| pgx/v5 | 5.7.5 → 5.9.2 | Injection requires nondefault simple protocol plus an attacker-controlled parameter inside a dollar-quoted literal. No matching application query/configuration was identified, so **application SQL injection is not established**. [GO-2026-5004](https://pkg.go.dev/vuln/GO-2026-5004) |

Examples of old-toolchain findings include excessive URL-resolution work and TLS post-handshake work. Their exposure depends on input and connection behavior. [GO-2026-6218](https://pkg.go.dev/vuln/GO-2026-6218), [GO-2026-6090](https://pkg.go.dev/vuln/GO-2026-6090).

Fix: upgrade to a currently supported patched Go toolchain and compatible patched dependencies, rebuild the actual release artifacts, and repeat both source and binary scans. Use a coherent dependency upgrade rather than forcing incompatible transitive versions. Preserve the advisory-condition review so a scan result is not mislabeled as an exploit.

### 6. P1 when concurrent preparation is enabled — A live download claim can be stolen

Locations: [prep.go:68](/srv/movie-watcher/torrent-streamer/internal/downloads/prep.go:68), [prep.go:154](/srv/movie-watcher/torrent-streamer/internal/downloads/prep.go:154), and [store_worker.go:75](/srv/movie-watcher/torrent-streamer/internal/downloads/store_worker.go:75).

Preparation is allowed six hours, while claims become stale after 15 minutes. claimed_at is set once; no heartbeat renews it. The sweeper releases any preparing claim older than that threshold, even if its worker remains active. If another preparation slot is available, Pump can start another worker for the same job.

Both workers use the same staging/ready directories. Finalization and failure operations check state but do not fence by claim generation. Competing workers can fail a healthy preparation or interfere with its files. With the default single preparation slot, a simultaneous second worker is normally prevented by the in-process running count; the claim itself is still incorrectly released.

**Reproduced:** an active claimed job was aged to 16 minutes, swept, and successfully claimed by a second worker. Concurrent file corruption was not deliberately exercised.

Fix: heartbeat leases and fence finalization by a claim token/generation. Alternatively, for a strictly single-process worker, never reset jobs known to be running and reconcile crashed work at startup. Test a preparation that lasts longer than the stale threshold with spare capacity.

### 7. P2 — Valid empty indexer responses are treated as failures

Location: [service.go:312](/srv/movie-watcher/torrent-streamer/internal/search/service.go:312).

HTTP 200 with an empty JSON array decodes successfully, but the function only returns the decoded array when its length is positive. It then tries to decode the same array into a wrapped-response struct and fails. If every indexer returns no results, a normal empty search becomes an upstream error/HTTP 502.

**Reproduced:** a stub Prowlarr returning 200 and [] caused query to return “cannot unmarshal array into Go value” instead of zero results and nil error.

Fix: distinguish a successfully decoded array, including an empty array, from a wrapped object response. Test both empty and populated response shapes.

### 8. P2 — Renewed downloads still expire according to their original manifests

Locations: [store.go:241](/srv/movie-watcher/torrent-streamer/internal/downloads/store.go:241), [store.go:338](/srv/movie-watcher/torrent-streamer/internal/downloads/store.go:338).

Renew updates download_jobs.expires_at but leaves the manifest JSON unchanged. Manifest validates the stored JSON's expiresAt against the current time. After the original deadline, a renewed ready job can therefore return ErrNotReady even though its job expiry is still in the future. Clients also receive the obsolete deadline before that point.

**Reproduced:** renewal extended the job by 48 hours from the renewal time, while the returned manifest retained its earlier deadline.

Fix: update job expiry and manifest expiry/revision atomically, or derive expiry from the authoritative job row when building the manifest. Test manifest access after the original deadline and before the renewed deadline.

### 9. P2 — Cross-origin browser writes fail their preflights

Locations: [cors.go:42](/srv/movie-watcher/torrent-streamer/internal/httpapi/cors.go:42), [downloads_handlers.go:62](/srv/movie-watcher/torrent-streamer/internal/httpapi/downloads_handlers.go:62), [taste_handlers.go:17](/srv/movie-watcher/torrent-streamer/internal/httpapi/taste_handlers.go:17).

Downloads registers POST creation/cancellation/renewal routes, but its CORS wrapper advertises only GET, HEAD, OPTIONS, PUT. Browser JSON POSTs from an otherwise allowed origin fail preflight. Taste registers only a POST method pattern, so OPTIONS never reaches its in-handler CORS branch and returns 405.

**Reproduced:** download creation OPTIONS omitted POST from Access-Control-Allow-Methods; taste OPTIONS returned 405.

Fix: advertise the methods used by each surface and register OPTIONS for taste. This affects standard cross-origin browser/WebView fetches; it does not imply failure for same-origin or native HTTP clients.

### 10. P2 — An incompatible HDR codec bypasses the HDR rejection

Locations: [planner.go:75](/srv/movie-watcher/torrent-streamer/internal/playback/planner.go:75), [runner.go:56](/srv/movie-watcher/torrent-streamer/internal/playback/runner.go:56).

The planner returns a video-codec transcode decision before checking whether the profile supports the source's HDR. The runner has scaling but no verified tone-map filter. For example, AV1 HDR10 on the default Android Media3 profile with transcoding enabled is accepted for H.264 conversion, bypassing the existing HDR unsupported branch.

**Reproduced:** that combination returned transcode/video_codec_incompatible instead of unsupported/hdr_unsupported. Incorrect output colors are the expected consequence of the missing conversion; actual HDR fixture output was not rendered during this audit.

Fix: apply HDR compatibility policy before every video-transcode decision, or implement and verify appropriate tone mapping. The default homeserver disables video transcoding, so that deployment does not exercise this case until it is enabled.

### 11. P2 — Diagnostic logging retains every unique record in memory

Locations: [logx.go:104](/srv/movie-watcher/torrent-streamer/internal/logx/logx.go:104), [logging.go:36](/srv/movie-watcher/torrent-streamer/internal/config/logging.go:36).

Every admitted log record is inserted into lastSeen and entries are never pruned. This also happens for the diagnostic writer configured with a zero deduplication window. Timestamps and request details make many records unique, so the map keeps growing for the entire process lifetime even when deduplication is disabled.

**Reproduced:** writing 10,000 distinct records through a zero-window writer retained 10,000 entries. No claim is made about the exact time until memory exhaustion; it depends on traffic/log volume.

Fix: keep no history for a zero window, and bound/prune history for a positive window. Verify stable memory use under sustained logging. Expired subtitle cache entries also remain in their process maps; apply bounded eviction there as part of resource cleanup.

### 12. P2 — Storage reclamation misses download-only torrent payloads

Locations: [prep.go:227](/srv/movie-watcher/torrent-streamer/internal/downloads/prep.go:227), [janitor.go:33](/srv/movie-watcher/torrent-streamer/internal/janitor/janitor.go:33), [config.go:74](/srv/movie-watcher/torrent-streamer/internal/config/config.go:74), [compose.yaml:115](/srv/movie-watcher/deploy/torwatch-server/compose.yaml:115).

Download preparation downloads the torrent's original file into the torrent cache and copies it to the job's staging/ready directory. It never calls TouchTorrent to create the durable cache manifest that the janitor uses as its candidate list. A torrent used only for offline preparation can therefore leave its original payload outside the janitor's accounting. The 48-hour job sweep deletes the prepared copy, not that original cache payload.

The general streaming cache's byte limit and eviction TTL also default to zero, disabling those two eviction policies, and compose does not set them. The buffer-ahead limit controls read-ahead, not total accumulated cache size.

Additional cleanup weakness: the sweep marks jobs expired before deleting assets/files. A deletion error or crash afterward leaves cleanup incomplete, and later ExpireDue calls only return ready jobs, so they do not retry those expired jobs.

**Evidence:** source control-flow review; no full offline torrent download or disk-exhaustion experiment was performed.

Fix: register every cache-producing torrent for reclamation, define bounded retention/size policies for the shipped deployment, and use a retryable cleanup queue or reconciliation scan for orphaned/expired job files. Add free-space admission appropriate to both the source payload and prepared copy. Verify download-only cache eviction and interrupted cleanup.

### 13. P2 if migrators run concurrently — Database initialization is not serialized

Location: [migrate.go:16](/srv/movie-watcher/torrent-streamer/migrations/migrate.go:16).

Apply creates the migration ledger and checks each version before executing its transaction, without a database-wide migration lock. Two callers can both decide to apply the same migration. PostgreSQL's concurrent CREATE TABLE IF NOT EXISTS does not by itself serialize creation of all dependent catalog objects; later ledger inserts also compete.

**Observed:** parallel test packages against a newly created empty database produced duplicate-key errors in PostgreSQL's type/procedure catalogs while applying migrations. Other packages also failed because their test fixtures expect initialized tables. The concurrent migration errors are the relevant production behavior; fixture ordering errors are not separate application defects.

One backend starting by itself does not exercise this failure. Concurrent backend starts, or starting the backend and imdb-import together against a fresh/upgrading database, can. The documented single-process homeserver reduces this risk.

Fix: take a PostgreSQL advisory lock on a dedicated connection around the complete migration sequence, including ledger creation and version checks, or enforce one migration job before application processes start. Test simultaneous Apply calls on empty and partially migrated databases.

## Conditional deployment blocker: one household is not independent user accounts

Locations: [library.go:1](/srv/movie-watcher/torrent-streamer/internal/library/library.go:1), [session.go:76](/srv/movie-watcher/torrent-streamer/internal/httpapi/session.go:76), [downloads_handlers.go:93](/srv/movie-watcher/torrent-streamer/internal/httpapi/downloads_handlers.go:93), and [Caddyfile](/srv/movie-watcher/deploy/torwatch-server/Caddyfile).

Library and recommendation data are household-wide. subjectId/clientId are caller-supplied identifiers, not authenticated ownership. The gateway supplies a reverse proxy, not account authentication. Any reachable caller can use these endpoints within that trust model. CORS is not authorization, and non-browser requests can omit Origin.

For separate per-user installations, retain a deliberate local/private boundary and fix the reliability issues above. For one public service used by unrelated people, add authenticated identity, server-enforced ownership, TLS at the public boundary, and per-user resource admission. Household-wide queries must be scoped or intentionally offered as a shared feature. Simply adding a login page would not provide data isolation.

## Suggested release order

1. Fix category-client initialization, recommendation failure recursion, reader cancellation, and catalog cache ownership. Add regressions for the reproduced failures.
2. Update the compiler/dependencies, rebuild release artifacts, and rescan. Fix claim ownership before enabling concurrent preparation.
3. Fix empty searches, manifest renewal, CORS, HDR policy, and memory/storage retention. Re-run PostgreSQL and race tests on fresh disposable state.
4. Complete packaged-runtime playback tests and a viewing journey across movie/TV/anime, including a dead swarm, disconnect, slow download, renew, restart, and cleanup. Run on the actual supported Windows/Linux/ARM64 targets.
5. If deployment is public/shared, implement the identity and ownership boundary before exposure, then test access using two independent accounts.

The backend already has useful safeguards: transactional migrations and progress ordering, idempotent download creation, constrained asset/import paths, explicit playback capacity limits, safe argument-array process execution, provider request deadlines, and a substantial existing test suite. The problems above are specific missing failure cases, not evidence that the backend needs a wholesale rewrite.
