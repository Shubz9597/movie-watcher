# P3 catalog BFF live checks (T034)

Executed: 2026-09-06, this session. Docker Desktop engine started during the session; a disposable PostgreSQL container (`torwatch-pg-drill`, `postgres:16-alpine`, 127.0.0.1:54329, DB `torwatch_t034`) plus the current working-tree backend binary (`go build ./cmd/vod`, `LISTEN=127.0.0.1:40013`, throwaway DSN) served the live checks. No production data or volume used.

## Live results (Invoke-WebRequest, exit codes recorded)

| Request | Result |
|---|---|
| `GET /v1/version` | 200; capabilities `catalog.bff.v2`, `leases.shared`, `progress.serverOrdered`; `supportedProtocolRange [1,1]` |
| `GET /v2/catalog/search?q=frieren&limit=5` | 200; real TMDb results; `degraded:true` with `degradedProviders:["anilist","jikan"]` — provider-outage degradation verified LIVE |
| `GET /v2/catalog/titles/tmdb:209867` | 200; runtime 25, genres, and the NEW `seasons` field (Specials/26, Season 1/38 with posters) — T042.1 contract addition verified live |
| `GET /v2/catalog/titles/tmdb:209867/episodes?season=1` | 200; 38 real episodes, stills present, `degraded:true` (blocked providers degraded, TMDb data served) |
| `GET /v2/catalog/titles/tmdb:209867/episodes?season=2` | 503 `providers_unavailable` (no season-2 data and blocked providers degraded) — documented degradation shape |
| `GET /v2/catalog/sections?kind=trending` | 200; 20 merged summaries, `degraded:true`/`anilist` — provider sections with summaries verified live |
| `GET /v2/catalog/sections?kind=popular&genre=28&type=movie&page=2` | 200; 20 results, `page:2`, `totalPages:2486` — genre rails + pagination (T042.1) verified live |
| `GET /v2/catalog/sections?kind=bogus` | 400 `unsupported_section_kind` |
| `GET /v2/catalog/sections?kind=trending&page=99999` | 400 `invalid_request` |

## Environment limits (honest gaps)

- **AniList/Jikan/AniZip/Cinemeta egress is blocked from this host session** (direct `POST https://graphql.anilist.co` times out; TMDb works). Anime-detail and anime-episode live responses therefore could not be exercised against real AniList data here; they remain covered by the httptest contract suites (`go test ./internal/httpapi/ ./internal/catalog/`), and the degraded paths were exercised live.
- The four endpoints were exercised over the local backend directly, not through the Caddy gateway of the deploy package (gateway pass-through remains T061).
- No TMDb API key was committed anywhere; the key came from the operator's local environment/config.

## Correction 2026-09-06 (M2.1): wildcard CORS replaced

The CORS behavior described as " ACAO *" earlier in this file was corrected in M2.1: `/v1/version`, `/readyz`, and `/v2/catalog/*` now use an explicit configurable origin allowlist (`TORWATCH_ALLOWED_CLIENT_ORIGINS`, default `null,http://localhost:5173` preserving the Electron file:// renderer and dev server; wildcards are ignored with a boot warning). Contract tests: `TestSystemAndCatalogEndpointsUseOriginAllowlistCORS` (allowed/disallowed/no-Origin GET + preflight methods/headers) and `TestOriginAllowlistNeverAcceptsWildcard`. No other (legacy) endpoint was changed.
