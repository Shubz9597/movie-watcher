# Contract: V2 Catalog BFF API (`/v2/catalog/*`)

**Feature**: `001-build-torwatch-version` | **Owner**: `internal/catalog` + `internal/httpapi/catalog_handlers.go` | **Status**: designed (implemented in P3, consumed from P5)

Versioned, client-neutral contract. No endpoint requires Electron, a specific platform,
or renderer-resident credentials (FR-003). Provider credentials never appear in any
response. Identifiers are opaque namespaced strings (`tmdb:123`, `anilist:456`,
`imdb:tt…`, `kitsu:…`) — clients must not parse them.

## Conventions

- Base: same gateway/origin as the V1 API (single entrypoint, FR-008).
- Content type: `application/json; charset=utf-8`.
- Errors: machine-readable codes per
  [protocol-negotiation.md](./protocol-negotiation.md) — `unsupported_protocol`,
  `unsupported_capability` (with `supportedProtocolRange`), plus standard 4xx/5xx with
  `{error: {code, message}}`. Provider outages NEVER surface as raw 5xx when degradation
  is possible (see per-endpoint degradation notes).
- Compatibility: clients negotiate via `/v1/version` before starting catalog workflows;
  overlapping protocol range ⇒ use highest mutually supported protocol.

## Endpoints

### `GET /v2/catalog/search?q={query}&type={movie|series|anime|all}&limit={n}&clientId={uuid}`

Unified search across integrated providers, merged deterministically server-side.

Response `200`:

```json
{
  "query": "frieren",
  "total": 2,
  "results": [
    {
      "id": "tmdb:209867",
      "type": "anime",
      "title": "Frieren: Beyond Journey's End",
      "originalTitle": "葬送のフリーレン",
      "year": 2023,
      "overview": "…",
      "artwork": { "poster": "https://…", "background": "https://…" },
      "providerIds": { "tmdb": "209867", "anilist": "154587", "imdb": "tt…", "jikan": "…" },
      "imdbId": "tt…",
      "mergedFrom": ["tmdb", "anilist", "jikan"]
    }
  ],
  "degraded": false,
  "degradedProviders": []
}
```

Degradation: if a provider is down/rate-limited, `degraded=true`, its name appears in
`degradedProviders`, results from remaining providers (and stale-but-valid cache) are
returned. Total failure of ALL providers ⇒ `503` with
`{error:{code:"providers_unavailable", message}}` (clear error, no hang).

### `GET /v2/catalog/titles/{id}?clientId={uuid}`

Title detail (merged metadata + images + identifiers needed to reach a playable source).

Response `200`: single Title object as above plus `externalLinks`, `ratings`
(`{imdb: {...}}` when present), `runtime`, `genres`, and `seasons`
(`[{number, name?, episodeCount?, airDate?, poster?}]`, present when a
contributing provider supplies them — TMDb tv season lists, or a single
anime season with the known episode count; movie-format anime keep no
seasons). Unknown `id` ⇒ `404 {error:{code:"title_not_found"}}`.

### `GET /v2/catalog/titles/{id}/episodes?season={n}&clientId={uuid}`

Episode list for a series/anime title. Merges TMDb/AniZip/Jikan/Kitsu/Cinemeta episode
data deterministically (fixed provider priority; episode number + season as join keys).

Response `200`:

```json
{
  "titleId": "tmdb:209867",
  "season": 1,
  "episodes": [
    {
      "id": "tmdb:209867:1:1",
      "season": 1,
      "episode": 1,
      "title": "…",
      "airDate": "2023-09-29",
      "still": "https://…",
      "overview": "…",
      "duration_s": 1440,
      "providerIds": { "anilist": "154587", "anizip": "…", "kitsu": "…" }
    }
  ],
  "degraded": false,
  "degradedProviders": []
}
```

Same degradation contract as search.

### `GET /v2/catalog/sections?kind={trending|popular|...}&type={...}&clientId={uuid}`

Curated/computed catalog sections. `kind=continue-watching` is `household`-scoped and
proxies the local `/v1/continue` semantics (shared progress subject).

Response `200`:

```json
{ "id": "trending", "kind": "provider", "titleIds": ["tmdb:…", "anilist:…"], "cachedAt": "2026-09-04T12:00:00Z" }
```

Provider sections additionally return `results: Title[]`, in the same order as
`titleIds`. These are the merged summaries already fetched for the section;
clients render cards directly and request full detail only when opening a title.
`titleIds` remains available for existing clients. Empty provider sections return
`results: []`. Household sections retain their existing IDs-only contract.
Provider sections currently expose one curated page; clients must not repeat it
as additional pages. Clients requiring summaries from an older IDs-only server
show an actionable backend-upgrade error.

Additive parameters (P5 gap closure, T042.1): provider sections accept an
optional 1-based `page` (1–500) and, for genre rails, either
`genre={tmdbGenreId}&type={movie|series}` or
`genre={urlEncodedAniListGenreName}&type=anime`. When `page > 1` or `genre` is set, the
response also carries `page` and `totalPages` (omitted when the contributing
providers do not expose a total). Genre sections are served only by providers
with the matching genre-discovery capability (TMDb for numeric movie/series
genres; AniList for named anime genres); other providers are skipped, not
degraded. Invalid parameter combinations (`type` without `genre`, `genre`
without `type`, numeric anime genres, named movie/series genres, out-of-range values) return
`400 {error:{code:"invalid_request"}}`.

## Merge determinism (normative for implementation)

1. Provider priority is a fixed, configuration-declared list (V1 renderer order as
   captured by P0 characterization tests).
2. Entities join on exact match keys (title+year+type; season/episode numbers for
   episodes). Ambiguous joins resolve by provider priority, then lexicographic
   external-ID order — never by map iteration order.
3. Same query parameters ⇒ byte-identical `id`/ordering results (cache aside). Parity
   suite (P4) enforces this against the P0 renderer fixtures.
4. Search presentation is ranked after identity merging: exact normalized title
   or original-title matches, title prefixes, complete query-token matches, then
   substrings. Equal matches retain provider priority and upstream result order.
   Apply the requested result limit after ranking. ID sorting resolves merge
   conflicts; it does not determine search relevance.

## Client requirements

- Send `clientId` (client-generated UUID v4, persisted locally; validated server-side for
  format/length only — never authentication).
- Negotiate protocol before first catalog call; handle `unsupported_protocol` /
  `unsupported_capability` by showing an actionable upgrade message and blocking only
  the incompatible workflow (health/version discovery stays accessible).
