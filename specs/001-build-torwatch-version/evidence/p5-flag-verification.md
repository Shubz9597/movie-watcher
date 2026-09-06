# P5 Evidence — Electron Catalog Migration (flag-gated)

**Phase**: P5 (plan.md "Electron catalog migration") | **Date**: 2026-09-04 | **Baseline**: Phase 4 exit (evidence/p4-parity-variance.md)

## Gate status before this phase

- Parity suite: **PASS** (evidence/p4-parity-variance.md §exit gate).
- Divergences V1–V5: documented with spec references but **owner approval NOT yet recorded** — recorded as a blocking gate for T042 (full-journey bff acceptance), T043 (default flip), and the P8 removal gate. No approval was guessed; the default remains `renderer`, so no user-facing behavior consumes the divergences yet.

## Implementation (T039–T041)

- **T039 — runtime flag**: `electron/config/app-config-store.js` seeds/normalizes `CATALOG_SOURCE` (`renderer`|`bff`; saved config > `TORWATCH_CATALOG_SOURCE` env > default `renderer`; normalized on save too) and exposes it through the existing non-secret `config:get` surface (no new IPC channel needed; no secrets touched). Renderer resolution: `src/lib/catalog-source.ts` — priority localStorage override `mw_catalog_source` (instant rollback path) > main config > `VITE_CATALOG_SOURCE` > `renderer`; `setCatalogSourceOverride(null|'renderer'|'bff')` provides the instant rollback the plan's migration map requires.
- **T040 — BFF adapters**: `src/lib/services/catalog-bff.ts` — contract client over `buildBackendUrl` (`/v2/catalog/search|titles/{id}|titles/{id}/episodes|sections`) with `CatalogBffError` carrying the machine-readable error code + `degradedProviders` (FR-011); `clientId` (FR-013) rides on requests via the existing persisted `getDeviceId()`; `backendTitleToCard` maps contract rows onto the renderer Card shape (canonical provider drives the numeric id; opaque `catalogId`/`providerIds` ride along); `bffTitleToAniListItem` synthesizes the raw AniList item shape so the characterized consumers (`cardFromAniList`, `selectAniListCatalog`) run unchanged in bff mode; sections resolve ids via bounded detail fan-out (contract sections carry ids only).
- **T041 — gateway + call sites**: `src/lib/services/catalog-gateway.ts` dispatches per flag; legacy services are lazily imported so bff mode never loads them. Call sites rewired to the gateway: `HomePage.tsx`, `GlobalSearch.tsx` (both the suggestion pool and search), `SeeAllPage.tsx` (anime rails), `EpisodePanelWrapper.tsx` (`getTvSeason`, `getCinemetaSeasonMetadata`), `TitlePage.tsx` (`getTvSeason`, `getAnimeEpisodeMetadata`). Legacy provider services remain **active in renderer mode and untouched** (preserved for the P8 removal gate).
- Not migrated this increment (recorded for T042 interactive findings): `continue-service` detail enrichment (`getMovie`/`getTv`/`getAnime` — BFF detail lacks cast/trailer/credits fields the enrichment paths consume), `TitlePage` main detail lookups, `getTitlesByGenre` (no contracted section kind). These stay on the legacy path in BOTH modes until mapped or the contract grows.

## Verification (commands + results)

| Check | Command | Result |
|---|---|---|
| Flag selection | `node --test --experimental-strip-types scripts/characterization/catalog-gateway.test.mjs` | PASS 8/8 — default `renderer`; config>env precedence; localStorage override wins (instant rollback); invalid values normalize to `renderer` |
| Adapter behavior | same file | PASS — request construction (`/v2/catalog/search?q=…&type=…&limit=…`), row→Card mapping (canonical id, sourceKind movie/series→tv/anime), AniList-shape synthesis, section fan-out with 404 tolerance |
| Errors / no fallback | same file | PASS — 503 `providers_unavailable` propagates with `degradedProviders`; legacy services provably NOT called in bff mode (spy assertion); renderer-mode calls pass args through untouched |
| Renderer default unchanged | `npm test` | PASS 59/59 — all P0/P2 characterization suites (renderer-mode legacy paths) green; TMDb IPC/Gluetun network-routing tests preserved and green |
| Renderer bundle | `npx vite build` | PASS — all four entries build with the gateway wired |
| Full Go suite | `go test -count=1 ./...`, `go vet ./...` | PASS / PASS (backend untouched this phase) |
| Catalog parity | `go test -count=1 ./internal/catalog/` | PASS (parity suite green; backend unchanged) |

## T042 — end-to-end journey verification: **PENDING (not passed)**

The search → detail → episodes → source → playback → subtitles → resume journey in BOTH modes requires an interactive Electron session with a running backend + PostgreSQL — unavailable in this session (no Docker daemon for a disposable DB; no display automation). Recorded as pending, NOT passed. Automated coverage obtained so far:

- bff-mode: contract request shapes, response mapping, error propagation (gateway tests) — unit level.
- renderer-mode: full characterization suites green (legacy path untouched).
- Backend contract behavior: Phase 4 httptest suites + end-to-end wiring test green.

When the operator runs the interactive verification: set `CATALOG_SOURCE=bff` (env `TORWATCH_CATALOG_SOURCE=bff` or config), exercise both journeys, record results here, and only then proceed to T043.

## T043 — default flip: **NOT EXECUTED**

Default `CATALOG_SOURCE` remains **`renderer`**. The flip is gated on T042 passing in both modes plus owner approval of parity divergences V1–V5. No flip was performed.

## Remaining risks / known bff-mode gaps (pending T042)

- Detail-page data (cast/trailer/credits), `continue-service` enrichment, and genre rails still use legacy services in both modes — bff mode is partial until mapped; the interactive run will show the user-visible effect.
- `getAnimeEpisodeMetadata` bff path requests season 1 only (AniZip mappings are absolute-numbered); verify against a multi-season anime during T042.
- Sections fan-out is N+1 detail requests (contract returns ids only) — acceptable at household scale; contract evolution candidate.

## Rollback

- Instant: `setCatalogSourceOverride('renderer')` or clear `mw_catalog_source` / set `CATALOG_SOURCE=renderer` — bff code paths stop being consulted (lazy legacy import means renderer mode behaves exactly as before).
- Full: `git revert` the Phase 6 commits — removes `catalog-source.ts`, `catalog-bff.ts`, `catalog-gateway.ts`, the call-site import changes, the `CATALOG_SOURCE` config-store wiring, and the gateway tests. Legacy provider code was never modified or removed.

---

## Addendum 2026-09-06 (T042.x reconciliation � supersedes the stale sections above)

The "Not migrated this increment" list and "Remaining risks" in the 2026-09-04 body are **stale**. Child tasks T042.1�T042.5 (see tasks.md and evidence/p5-bff-gap-audit.md) closed them:

- TitlePage detail lookups: bff mode resolves detail/seasons/episodes via `/v2/catalog/*` (incl. the new `seasons` field); renderer mode unchanged.
- continue-service enrichment and PlayerPage playback metadata: flag-routed; provider services load lazily so bff mode makes no provider calls.
- `getTitlesByGenre` / genre rails and section paging: contracted server-side (`/v2/catalog/sections?kind&genre&type&page`, `totalPages`).
- The build's `INEFFECTIVE_DYNAMIC_IMPORT` warnings are gone (static provider imports removed from bff-capable pages).

Still true from the body: T042 (interactive dual-flag journey) is PENDING, T043 is NOT EXECUTED, the default remains `renderer`, and parity divergences V1�V5 still lack recorded owner approval. The bff-mode season-1-only anime episode metadata note remains open for the interactive run; the operator checklist (docs/mobile-ui/OPERATOR-CHECKLIST-T020-T042.md) lists both effective modes.
