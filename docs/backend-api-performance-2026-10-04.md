Backend API performance audit — 2026-10-04

The slow catalog responses were caused by provider orchestration and cache behavior, amplified by an actual Jikan connectivity failure. TMDb and AniList returned useful data, but the backend waited for unavailable Jikan on every request. Movie search previously took about 8.5 seconds, anime details 8–9 seconds, and anime episodes about 16.8 seconds. The fixes are pushed and deployed.

Measurements below are through the live gateway with two probe workers and two attempts per endpoint. “First observed” does not guarantee an empty cache: recommendation startup warming, previous requests, and persisted torrent releases can already populate caches. A separate real-provider test creates a fresh catalog service for each operation and verifies empty metadata caches. Neither measurement is a browser paint-time or concurrent-user capacity benchmark.

Confirmed causes and changes:

- Search, sections, details, and episode providers ran sequentially. They now run concurrently, with results merged in configured provider priority order.
- Detail populated a provider cache but did not read it. Repeated details and merged episode lists now read their caches, preserving cross-links and copying mutable fields.
- Episode loading repeated detail resolution and provider waits. Metadata and initial episodes now overlap within one three-second response budget. Usable episodes are cached even when enrichment times out.
- Failed Jikan requests were repeated even when other provider results were cached. Provider outages now have a 30-second cooldown. HTTP 429 cooldowns honor longer Retry-After values; 404 and other client errors remain scoped to their request key.
- Expired entries waited for a failing upstream before serving stale data. They now return immediately and coalesce bounded refreshes in the background. Cache replacement no longer evicts unrelated entries or flushes all expired fallback data.
- Identical concurrent misses duplicated provider calls. They now share a load. One caller canceling does not cancel its siblings; service shutdown cancels and joins owned work. Eight shared network slots bound catalog bursts.
- Movie/series searches unnecessarily invoked anime-only AniList/Jikan. These sources now skip incompatible searches. TMDb remains eligible for anime because it can return Japanese animation.
- Jikan’s search limit is capped at 25 instead of forwarding the unified limit of 50. Non-transient HTTP client errors no longer incur the extra retry delay.
- Unsupported ID types are checked before provider cooldowns, so a Jikan outage does not falsely mark ordinary TV metadata/episodes degraded.

Jikan is still unreachable from this server: DNS resolved in roughly 10 ms, but IPv4 TCP connection did not establish within the four-second diagnostic limit. The recorded response code was 000. This is a remaining connectivity issue; the catalog now isolates it and returns other providers’ data. These observations do not establish whether the cause is local routing, network filtering, or the provider.

Provider references: [Jikan API documentation](https://docs.api.jikan.moe/) and [AniList rate-limit documentation](https://docs.anilist.co/guide/rate-limiting). The server timings and root-cause conclusions above come from this application’s code and measurements.

Live gateway timings (milliseconds):

| Endpoint | Before first observed | Before repeat | After first observed | After repeat | After status |
| --- | ---: | ---: | ---: | ---: | --- |
| health | 5 | 1 | 19 | 3 | 200/200 |
| ready | 5 | 2 | 18 | 6 | 200/200 |
| version | 1 | 1 | 4 | 5 | 200/200 |
| continue-section | 1 | 1 | 3 | 4 | 200/200 |
| library | 2 | 2 | 7 | 6 | 200/200 |
| library-overview | 2 | 2 | 35 | 3 | 200/200 |
| memberships | 1 | 1 | 5 | 4 | 200/200 |
| recommendations | 1 | 1 | 5 | 3 | 200/200 |
| trending | 1941 | 7 | 1024 | 6 | 200/200 |
| popular | 1872 | 2 | 952 | 10 | 200/200 |
| movie-genre | 155 | 4 | 141 | 4 | 200/200 |
| anime-genre | 1160 | 5 | 1137 | 6 | 200/200 |
| search-movie | 8490 | 8003 | 141 | 5 | 200/200 |
| search-anime | 8781 | 8006 | 3005 | 4 | 200/200 |
| movie-detail | 171 | 175 | 184 | 4 | 200/200 |
| tv-detail | 1312 | 178 | 181 | 1 | 200/200 |
| anime-detail | 9008 | 8569 | 1 | 1 | 200/200 |
| jikan-detail | 8683 | 8231 | 3001 | 2 | 200/200 |
| tv-episodes | 515 | 176 | 449 | 3 | 200/200 |
| anime-episodes | 16778 | 16552 | 392 | 4 | 200/200 |
| imdb-rating | 4 | 4 | 4 | 4 | 200/200 |
| resume-empty | 5 | 4 | 12 | 4 | 200/200 |
| resume-source-empty | 4 | 4 | 4 | 4 | 200/200 |
| continue-empty | 4 | 4 | 12 | 5 | 200/200 |
| watched-empty | 5 | 4 | 4 | 3 | 200/200 |
| torrent-search | 1791 | 2 | 71 | 2 | 200/200 |

The movie search still returned 18 titles, anime search 6, and anime episodes 28. A directly Jikan-keyed detail can return reduced fallback metadata while Jikan is down; HTTP 200 is not evidence that every provider completed. After the fix, ordinary TV episodes no longer report unrelated anime providers as degraded. The first observed anime detail was already warm from startup activity, so its small latency is not a cold-load claim. Recommendations were also already warm; torrent discovery after restart can read persisted releases.

The initial smaller baseline had an invalid library sort (`added`, HTTP 400); it is retained for transparency but excluded from comparisons. The extended baseline uses `sort=recent`, HTTP 200.

Fresh-cache real-provider checks (separate new service for each operation):

| Operation | Empty-cache first load | Immediate repeat | Result |
| --- | ---: | ---: | --- |
| Anime search | 3.004 s | 0.122 ms | 6 titles; Jikan degraded |
| Anime detail | 3.002 s | 0.011 ms | Found; Jikan degraded |
| Anime episodes | 3.003 s | 0.010 ms | 28 episodes; Jikan degraded |

These are service-level timings using the deployed provider configuration, without gateway/JSON encoding overhead. The helper creates new caches, never modifies PostgreSQL, and records only counts, availability and duration. An intermediate empty-cache test exposed a second three-second episode enrichment wait on the next visit; the final merged episode cache removes it. These cold checks establish the deadline under the observed outage, rather than claiming every first load completes in a few milliseconds.

Controlled six-run benchmarks use four fake providers with fixed one-millisecond latency, fresh service instances for cold cases, and no internet. Compared with the first detail-cache fix:

| Benchmark | Before parallel calls | After parallel calls | Change |
| --- | ---: | ---: | ---: |
| Search, cold | 4.774 ms | 1.506 ms | -68.46% |
| Section, cold | 4.760 ms | 1.555 ms | -67.34% |
| EpisodesWithIDs, cold | 4.720 ms | 1.453 ms | -69.22% |
| Detail, warm | 2.728 µs | 1.079 µs | -60.47% |

All latency comparisons have p=0.002, n=6. The original uncached-on-revisit detail benchmark was 4.749 ms. Cold-operation allocations increased because shared work, deadlines, independent results and copied cache ownership add bookkeeping; the measured absolute increase was approximately 3–6 KiB per operation. This is an intentional tradeoff for substantially shorter network waits, rather than an allocation optimization.

Additional live playback metadata checks returned HTTP 200: anime skip segments took 666 ms then 2 ms (two segments); movie subtitle listing took 2.172 s then 1.950 s (seven tracks). Subtitle lookups still perform upstream work on repeat requests. A bounded result cache keyed by title/episode, language selection and provider configuration is a measured follow-up opportunity for subtitle-panel latency. Provider URL expiry and configuration changes would need to be handled when implementing it. This catalog patch does not claim to fix that separate flow.

Coverage and limits:

| API family | Verification |
| --- | --- |
| Catalog search/detail/episodes/sections | Live first/repeat probes, fresh-cache real providers, controlled benchmarks, race/cancellation/stale-cache regressions |
| Library list/overview/memberships | Live valid GET probes; PostgreSQL integration suite covers writes and ordering |
| Recommendations | Live warm GET; existing cold/fallback/parallel behavior tests; no live cold recommendation latency claim |
| Watch resume/source/continue/watched | Live empty-subject GET probes; PostgreSQL integration suite covers heartbeat, dismissal, watched sync and updates |
| Torrent search | Live discovery-only POST and repeat; cache and source-resolution tests; no source selected or downloaded by the performance probe |
| Files/stream/buffer/SSE | Deployment fixture validates real torrent transport, exact initial/seek/suffix ranges, 416, and consecutive SSE events |
| Playback/offline jobs/manifests/assets | Full race suite and existing FFmpeg/DB integration coverage; no real user job creation or destructive changes for timing |
| Subtitles/skip segments | Code timeout/cache review, functional tests, and separate live metadata-only probes |
| IMDb/system | Live GET probes and backend tests |

Mutating endpoints and actual media preparation were not load-benchmarked. Successful functional tests do not establish their latency for arbitrary media, nor production capacity for many simultaneous users. Page rendering, image loading, mobile network time and browser paint were not measured here. The remaining demonstrated catalog problem is Jikan connectivity; the cold-cache ceiling is now approximately three seconds while that outage persists.

The backend cache is in memory and resets on restart. Persisting last-good catalog metadata would be a possible follow-up if restart-time cold loads remain frequent, but the current measurements do not justify adding a new database cache immediately.

Validation and deployment:

- Final full `go test -race -short -count=1 ./...` and `go vet ./...` passed on the clean release snapshot, with disposable PostgreSQL and applied migrations. The temporary database container was removed afterward.
- Catalog tests cover simultaneous provider starts, deterministic priority, shared misses, caller cancellation, stale refreshes, cooldown expiry, Retry-After, client-error isolation, ID eligibility, shutdown joining, and merged episode cache ownership/repeat latency.
- Production build passed. The binary scan found zero reachable vulnerable symbols; it also reported one required-module advisory in code this binary does not call.
- Deployed image: `torwatch-server:git-e512ed5a8bd7`, revision `e512ed5a8bd7`, built from a clean pinned checkout. Other work in the shared checkout was preserved. The release also includes independently committed torrent-search/subtitle work that was covered by the final backend test suite.
- Health/readiness/version and published-port checks passed. Fixture ranges returned exact expected bytes. Initial SSE data arrived in 1 ms, with the next event about 1.001 seconds later. Stream fixture timings do not measure playable-media decoding.

Raw evidence: [directory](backend-api-performance-evidence-2026-10-04). The first `live-after.json` file belongs to the intermediate `e1641f9` deployment; `live-after-final.json` belongs to the final `e512ed5` deployment. Benchmark outputs document the two optimization stages. No credentials or response contents are recorded by the API timing probe.

Repeat the gateway measurement:

```bash
python3 deploy/torwatch-server/scripts/measure-apis.py --torrent-search --output /tmp/api-latency.json
```

Repeat deterministic benchmarks from `torrent-streamer/`:

```bash
go test ./internal/catalog -run '^$' -bench BenchmarkCatalog -benchmem -count=6 -benchtime=250ms
```
