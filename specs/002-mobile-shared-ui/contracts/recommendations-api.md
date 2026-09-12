# Contract: Household recommendations (`/v2/recommendations`) — FINALIZED for M4

**Feature**: `002-mobile-shared-ui` | **Owner**: Go recommendation service (M4.1) + HTTP handler | **Status**: finalized design derived from plan.md §Light recommendation rules and [library-api.md](library-api.md) §Recommendation proposals. No ML, embeddings, external AI, profiles, or new recommendation infrastructure.

## Identity

- Recommendations reference canonical ids from the library identity: media-qualified TMDb forms (`tmdb:movie:N` / `tmdb:tv:N`), `anilist:N`, `jikan:N`. Anime is a classification over the structural id (`type: "anime"`), never a separate namespace. The unqualified `tmdb:N` alias never appears.

## Endpoint

### `GET /v2/recommendations?limit={n}`

- `limit`: optional, default 20, min 1, **max 20**. Invalid values → `400 {error:{code:"invalid_request"}}` (existing versioned error envelope).
- Requires the `recommendations.basic.v1` capability (see Negotiation). Unadvertised-capability requests → existing `unsupported_capability` negotiation error.

Response `200`:

```json
{
  "revision": "18446744073709551615",
  "fallback": false,
  "degraded": false,
  "generatedAt": "2026-09-10T12:00:00Z",
  "items": [
    {
      "canonicalId": "tmdb:movie:456",
      "type": "movie",
      "title": "Some Movie",
      "year": 2024,
      "artwork": { "poster": "https://…" },
      "reason": { "code": "seed_genre", "text": "Because you favourited Dune: Part Two", "seedCanonicalId": "tmdb:movie:693134" }
    }
  ]
}
```

- `revision`: the household revision the result was computed against (lossless decimal string; may be `"0"` for a household with no effective mutations).
- `fallback: true` means there were no usable seeds and every item is a Popular pick.
- `degraded: true` means the candidate source failed and a cached or empty section is served truthfully.
- `reason.code`: `"seed_genre"` (scored by favourite-genre overlap) or `"popular"` (zero-score filler / fallback). `reason.text` is human-readable and grounded in the contributing seed title; `reason.seedCanonicalId` is present only for `seed_genre`.

## Rules (plan.md §Light recommendation rules)

1. **Seeds**: the up-to-20 most recently favourited titles. Seed genres resolve through the existing catalog detail path (bounded: at most one detail call per seed, only during a cache build). A seed whose genre metadata is unavailable contributes nothing (but its title is still excluded from results). Provider-qualified genre keys: `"<canonical namespace>:<normalized genre>"` until an explicit tested cross-provider mapping exists — e.g. an AniList seed matches AniList-genre candidates only.
2. **Candidates**: a bounded cache of up to 200 popular/trending candidates WITH genres, supplied by the existing catalog providers (TMDb trending + genre list mapping; bounded number of upstream calls per build, never per request).
3. **Scoring**: each candidate scores the number of DISTINCT favourite seeds sharing at least one normalized genre. One seed contributes at most one point to a candidate regardless of shared-genre count.
4. **Exclusions and dedup**: every current Favourite AND Watch Later title is excluded; candidates deduplicate by canonical id.
5. **Ordering (deterministic)**: score descending, then the provider's existing popularity rank ascending, then canonical id ascending.
6. **Reason**: the most recent contributing seed (by favourite-added order) supplies the reason text. Zero-score items kept as filler say "Popular pick".
7. **No blocking**: provider failure never fails Home or playback — a degraded cached/empty section is returned with `degraded: true`.

## Caching and invalidation

- The ranked result is cached in memory keyed by `(household revision, candidate-cache version)` with a **15-minute** expiry.
- Effective Library mutations advance the household revision → new cache key → next request recomputes. **No-op writes do not advance the revision and therefore do not invalidate.**
- The candidate-cache version changes when the candidate pool's inputs change (provider-side), also forcing a recompute.
- The cache is in-memory; loss on restart is harmless (recomputed on demand).

## Negotiation

- `recommendations.basic.v1` is added to `/v1/version` capabilities ONLY when the recommendation service and its dependencies (library storage + catalog candidates) are actually wired. Older servers 404 the route; clients treat a missing capability as "no recommendation section".

## Non-goals (M4.1)

No watch-progress signals, no per-device profiles, no writes, no cross-provider genre mapping beyond the provider-qualified key, no pagination (bounded result, max 20).
