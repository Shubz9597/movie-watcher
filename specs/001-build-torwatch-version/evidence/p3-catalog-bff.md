# P3 Evidence — Catalog Framework and /v2/catalog/*

**Phase**: P3 (plan.md "Catalog framework") | **Date**: 2026-09-04 | **Baseline**: Phase 2/3 exits (evidence/p1-server-foundation.md, p2-transport-refactor.md)

## Migration map (constitution principle IV)

| Field | Value |
|---|---|
| Old owner | Electron renderer provider services (TMDb/AniList/Jikan/Cinemeta/AniZip calls live in the renderer; credentials ship in the client) — **untouched this phase** |
| New owner | `internal/catalog` (providers, merge, cache) + `internal/httpapi/catalog_handlers.go` (`/v2/catalog/*`) + `cmd/vod/main.go` wiring (`buildCatalogProviders`) |
| Consumers | None yet — the surface is live but unused (Gate I: safely inactive; P5 migrates Electron behind the `catalogSource` flag) |
| Compatibility | Additive `/v2` namespace only; V1 routes untouched; renderer provider code/CSP/provider credentials unchanged |
| Removal gate | N/A (new surface) |
| Rollback | `git revert` of the Phase 4 commits removes the package/routes/wiring; renderer keeps its own providers; no data involved |

## Implementation summary

- **T021** `provider.go`/`service.go`/`types.go` — `Provider` interface with optional capabilities (`SearchProvider`, `DetailProvider`, `EpisodeProvider`, `SectionProvider`), fixed priority-order registry, deterministic merge (`MergeTitles`/`MergeEpisodes`): join on normalized-title+year+type (renderer's characterized `normalizeAnimeTitle` ported via `x/text` NFKD), within-provider ambiguity resolved by lexicographic external-ID order, priority wins scalar fields, `providerIds`/`mergedFrom` accumulate. Verified no map-iteration-order dependence by repeated-run tests.
- **T022** `cache.go` — bounded in-memory TTL cache: fresh (within TTL) short-circuits provider calls; stale-but-valid served on provider outage; eviction only when the entry bound is exceeded (oldest-expiry first). No database involved (persistent `catalog_cache` table is deferred to migration 005, Phase 8).
- **T023–T027** adapters, each fixture-tested with local stub servers: `tmdb.go` (api-key query param, movie→tv detail fallback, anime classification via ja+genre-16 — the characterized renderer rule, episodes, trending/popular sections; missing key ⇒ provider absent), `anilist.go` (GraphQL POST, search/detail/sections, HTML-stripped overview, MAL cross-link), `jikan.go` (search/detail/episodes, duration parsing), `cinemeta.go` (series→movie fallback, string-or-object poster form, season-filtered videos), `anizip.go` (mappings by anilistId→malId→kitsuId preference, deterministic episode output, IMDb cross-link). Status mapping: 404 → `ErrNotFound`, 429 → `ErrRateLimited`, others → transport error.
- **T028** `degradation_test.go` — timeout bounding (slow provider cut off at configured deadline), rate-limit ⇒ degradation, partial outage ⇒ remaining providers still serve + `degradedProviders` recorded, all-provider failure ⇒ empty result for the handler's 503, stale-cache fallback on outage, detail not-found vs outage distinction, detail cross-link enrichment with one not-found retry pass.
- **T029–T032** `catalog_handlers.go` — `GET /v2/catalog/search` (`{query,total,results,degraded,degradedProviders}`; 503 `providers_unavailable` with `degradedProviders` only when everything failed), `GET /v2/catalog/titles/{id}` (merged detail + `ratings.imdb` enrichment via the existing IMDb store; 404 `title_not_found`), `GET /v2/catalog/titles/{id}/episodes` (`{titleId,season,episodes,…}`; detail-resolved cross-links so AniZip/Cinemeta can enrich), `GET /v2/catalog/sections` (`trending`/`popular` provider sections; `continue-watching` household section with injected resolver, empty until the household subject wiring lands with the multi-client milestone). Extra fields on sections (`degraded`, `degradedProviders`) are additive beyond the contract example, justified by spec Edge Case 1.
- **T033** negotiation enforcement on all `/v2/catalog/*`: optional `X-Torwatch-Protocol` header (or `protocol` query) outside `supportedProtocolRange` ⇒ 400 `unsupported_protocol` with the server range; `X-Torwatch-Capability` not advertised ⇒ 400 `unsupported_capability` with the capability list; invalid `clientId` ⇒ 400 `invalid_client_id` (format/length only — FR-013). Error bodies carry no secrets (FR-012). `catalog.bff.v2` is now advertised in `/v1/version` because the capability is implemented.
- **main.go wiring** — `buildCatalogProviders` reads `TMDB_API_KEY` server-side (never leaves the backend) and `TORWATCH_{TMDB,ANILIST,JIKAN,CINEMETA,ANIZIP}_BASE_URL` overrides for disposable-stack testing; a provider without credentials is simply absent from the registry.

## Verification (commands + results)

| Check | Command | Result |
|---|---|---|
| Adapter/cache/degradation/merge tests | `go test -count=2 ./internal/catalog/` | PASS (stable across repeats) |
| Handler contract tests | `go test -count=1 ./internal/httpapi/` | PASS — includes negotiation enforcement, 404/503 paths, all four endpoint shapes |
| End-to-end wiring | `go test -count=1 ./cmd/vod/ -run TestCatalogEndpointsEndToEnd` | PASS — real main-style mux over five local provider stubs: search merge (3 providers join into one title, providerIds accumulate), detail enrichment (AniList→AniZip IMDb cross-link), episode merge (AniZip enrichment visible), sections (provider + household) |
| Full Go suite | `go test -count=1 ./...`, `go vet ./...` | PASS / PASS |
| Electron tests | `npm test` | PASS 51/51 (client untouched — additive backend only) |
| Flakiness | repeated `-count=2` runs of catalog+httpapi; subtitle credential tests de-parallelized | PASS — fixed a latent parallel-test interference on the OpenSubtitles credential global (tests serialized; documented, no assertions weakened) |

## Unverified checks (pending, not passed)

- **Disposable-stack live curl of all four endpoints**: PENDING — Docker daemon is not running on this host, so no disposable PostgreSQL stack could be launched. Compensated by the end-to-end wiring test, which exercises the identical mux/handler/provider stack over local stubs; the live curl (including real provider reachability) remains for the operator.
- **Real provider reachability** (TMDb with a real `TMDB_API_KEY`, AniList/Jikan/Cinemeta/AniZip network calls): PENDING — no credentials and no external network verification in this session; fixtures only.
- **`go test -race`**: still unavailable on this host (no C compiler; see P1 evidence).

## Remaining risks

- AniList `Detail` uses `Media(id:)` GraphQL — verified against the stub; live AniList behavior (rate limits, NotFound semantics) pending real-network validation.
- Continue-watching household section returns an empty list until the household subject wiring lands (multi-client milestone / P5 consumer migration); the injection point is `CatalogHandlers.HouseholdContinue`.
- AniZip episode `duration` is treated as minutes (`*60`) per its API docs; confirm against live data during P4 parity.

## Rollback

`git revert` the Phase 4 commits. `internal/catalog` disappears, `/v2/catalog/*` routes vanish (clients: none), `catalog.bff.v2` capability disappears from `/v1/version`, Electron renderer keeps its own provider code. No data or V1 behavior touched.
