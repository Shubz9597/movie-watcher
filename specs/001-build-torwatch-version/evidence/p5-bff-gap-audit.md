# P5 BFF migration gap audit (pre-T042)

Checked: 2026-09-06 against the current dirty working tree (HEAD `bd11a90a6f3c207392bdadd0c89377dcf240752f` plus the recorded modified/untracked feature 001 work). No task checkboxes were changed by this audit; child tasks were added to the Phase 6 ledger instead.

## Baseline reproduction (this session)

| Check | Working directory | Command | Result |
|---|---|---|---|
| Electron tests | `electron-app` | `npm test` | PASS, exit 0, 38/38 (node --test) |
| Renderer build | `electron-app` | `npm run build:renderer` | PASS, exit 0. Pre-existing `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings for tmdb-service.ts / anilist-service.ts (dynamic import in catalog-gateway.ts shadowed by static imports in continue-service.ts, PlayerPage.tsx, SeeAllPage.tsx, TitlePage.tsx). Not silenced; they are evidence of the gaps below. |
| Go tests | `torrent-streamer` | `go test ./...` | PASS, exit 0 (GOCACHE redirected to a writable temp dir; first attempt hit an access-denied build cache, no product code changed) |
| Go vet | `torrent-streamer` | `go vet ./...` | PASS, exit 0 |
| Docker | system | `docker info` | Docker Desktop was not running at session start; engine started during the session (`ServerVersion 28.3.2`). Live disposable-stack checks (T034/T059–T062) are therefore re-attemptable this session. |
| DB-gated tests | `torrent-streamer` | `TORWATCH_TEST_PG_DSN` | NOT set in this session; DB-gated migration/progress tests were skipped, not verified. |

## Confirmed gaps: catalogSource=bff still depends on renderer provider calls

The gateway (`src/lib/services/catalog-gateway.ts`) correctly routes search/sections/season-episodes behind the `catalogSource` flag, and `bffTitleDetail` exists in `catalog-bff.ts`. But the title-detail and enrichment surfaces were never migrated, so with flag `bff` the following still issue direct renderer→provider HTTP calls (TMDb/AniList/Jikan), contradicting the Phase 6 goal "Electron fetches catalog exclusively from /v2/catalog/* behind the flag":

1. **TitlePage.tsx detail** — `getTmdbMovie`/`getTmdbTv` (movie, tv, and tmdb-backed anime), `getAniListAnime` + `getJikanAnime` (anime), and `findAnimeIMDbId` are called directly with no flag check. The BFF detail endpoint is never used by the page. Seasons for tv come from the TMDb raw payload; the BFF detail response currently has no `seasons` field.
2. **PlayerPage.tsx playback metadata** — `getTmdbMovie`/`getTmdbTv`/`getAnime` called directly before MPV start regardless of flag.
3. **continue-service.ts enrichment** — `enrichItem` resolves continue-watching titles via `getTmdbMovie`/`getTmdbTv`/`getAniListAnime`/`getAnimeByMalId` directly regardless of flag. This is the "detail enrichment" gap named in the Phase 6 evidence.
4. **SeeAllPage.tsx collections** — `getTitlesByGenre` (no BFF equivalent at all: `/v2/catalog/sections` supports only `kind=trending|popular|continue-watching`, single page, no genre), and `getMovies`/`getTvShows` imported from tmdb-service directly although flag-routed gateway equivalents exist. BFF sections are also a single curated page, so See-All pagination stops after page 1 in bff mode.
5. **Static import overlap** — the four static provider-service imports above defeat catalog-gateway's lazy legacy loading in the renderer bundle (build warnings), so bff-mode bundles still contain the provider paths.

## Server-side gaps behind the client gaps

- `catalog.Title` has genres/runtime/externalLinks/ratings (detail handler) but **no seasons list**; TMDb detail payload contains seasons and drops them (`tmdb.go detailToTitle`).
- `/v2/catalog/sections` has no `genre`, `page`, or media-type scoping; TMDb section provider supports only trending-all-day/week; AniList Section hardcodes `Page(page: 1)`. Genre rails and See-All paging therefore cannot be served by the BFF.
- Anime episode skeletons in bff mode need episode counts: AniList/Jikan providers do not surface `episodes`/`episodes_count` into `Title`.

## Disposition

Child tasks T042.1–T042.5 added under Phase 6 in tasks.md close these before T042 runs:

- T042.1 server: seasons on detail (TMDb; AniList/Jikan single-season episode counts), section `genre`/`type`/`page` support + contract tests + contract doc update.
- T042.2 client: catalog-bff/gateway detail + genre/paged sections + adapter mapping + characterization tests.
- T042.3 TitlePage bff-mode detail loader (movie/tv/tmdb-anime/anilist-anime).
- T042.4 continue-service + PlayerPage bff-mode enrichment.
- T042.5 SeeAllPage gateway migration (incl. genre + pagination).

Renderer mode stays byte-for-byte the fallback (rollback = flip flag). T042 dual-flag journey, T043 default flip, and the removal gates remain open until their own evidence exists.
