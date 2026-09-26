# React best-practices audit (vercel-react-best-practices skill)

Executed 2026-09-06 against `electron-app/src` using the `.agents/skills/react-best-practices/react-best-practices` rule set (Vite SPA, React 19; RSC/Next-specific rules N/A). Two parallel audit passes (pages+entries; components+libs), every finding verified against the code before acting. No behavior changes intended — performance/correctness hardening only.

## Applied fixes (verified: tsc clean, npm test 179/179 green, both builds pass)

| # | File | Rule | Problem → Fix |
|---|---|---|---|
| 1 | `pages/WatchPage.tsx` | rerender-dependencies | Effect depended on the `params` **object** (fresh identity per App render) → cleanup called `stopMpv()` and the effect re-ran `playInMpv()`, restarting playback on any parent re-render. → Destructured primitive fields (`streamUrl/magnet/title/cat/fileIndex/season/episode`) as deps. |
| 2 | `components/shared/RecommendationRow.tsx` | rerender-dependencies | `load` useCallback depended on the inline `deps` object prop → `useEffect([load])` refired per parent render → status reset to loading + refetch. → Deps reduced to the primitive `deps?.fetchImpl`. |
| 3 | `pages/TitlePage.tsx` | async-parallel | Anime route fetched detail then episodes sequentially (independent) → now `Promise.all` (one RTT saved per anime page); the empty-list fallback still uses `row.seasons`. |
| 4 | `components/PosterCard.tsx` + `pages/SeeAllPage.tsx` + `pages/SearchPage.tsx` | rerender-memo | Unmemoized PosterCard + fresh `movie` objects/closures per render → whole grids re-rendered per keystroke/load-more. → `memo(PosterCard)`; SeeAllPage: hoisted stable `openTitle`/`prefetchTitle` callbacks; SearchPage: stable per-item cards + callbacks via a state ref for `query`/`recent`. |
| 5 | `pages/HomePage.tsx` | rerender-memo / functional-setstate | `ContinueRail` re-rendered every 8 s hero tick → `memo(ContinueRail)`; inline `onDismiss` defeated the memoized `ContinueCarousel` → `handleDismiss` callback; `dismiss` read a stale `dismissingKey` from `[]` deps (double-POST guard dead) → `dismissingRef` in-flight guard. |
| 6 | `lib/router-adapter.tsx` | rerender-memo | Fresh `{navigate, goBack}` context value re-rendered every `useRouter()` consumer per provider render → `useMemo`. |
| 7 | `components/EpisodePanelWrapper.tsx` | rerender-memo | `displayedTorrentRows` re-ranked the torrent list every render → `useMemo` (mirrors TorrentPanel). |
| 8 | `browser/main.tsx` | rerender-memo-with-default-value | Inline `deps={{ fetchImpl }}` objects defeated memoized recommendation components → `useMemo` `recommendationDeps` used by HomePage/RecommendationRow/RecommendationsAllPage. |
| 9 | `pages/TitlePage.tsx` | rerender-memo-with-default-value | Inline fallback `seasons` array prop → module-level `DEFAULT_SINGLE_SEASON`. |
| 10 | `mobile/ServerSettings.tsx` | js-cache-storage | `getPreference` read on every keystroke render → lazy `useState` initializer. |
| 11 | `player-controls/PlayerControlsApp.tsx` | advanced-event-handler-refs | Global `mousemove` listener torn down/re-registered per pause/menu/segment state flip (and the handler re-armed its timer per event) → `showHudRef` + single stable listener. |
| 12 | `components/EpisodePanelWrapper.tsx` | rerender-derived-state-no-effect | Artwork `loadState` reset from the `src` prop in an effect → removed; both call sites key the component on the artwork URL so a src change remounts and the initializer yields `loading`. |
| 13 | `pages/SeeAllPage.tsx` | js-combine-iterations | Load-more re-deduplicated the entire accumulated anime array (O(n²) per session) → Set-based dedupe of the new page only. |

## Audited and intentionally unchanged

- `pages/SearchPage.tsx` dead `AbortController` (aborted but no fetch receives the signal): state writes are guarded by `cancelled`; passing the signal would require gateway API changes — recorded, not fixed (follow-up candidate if gateway gains signal support).
- `components/shared/LibraryToggle.tsx` dep-less tracking effect: intentional previous-value tracking; work is O(1) per toggle.
- `lib/pull-to-refresh.tsx` non-passive `touchmove`: required for `preventDefault()` gesture ownership; bails out O(1) when scrolled — legitimate exception.
- `components/primitives` barrel imports (GlobalSearch, RecommendationRow, LibraryPage): barrel has 3 tiny exports and tree-shakes; direct-file split deferred.
- `browser/main.tsx` dev-only `ToggleStateCapture` re-reads `URLSearchParams` per render: fixture-only surface, cosmetic.
- `pages/HomePage.tsx` `featuredIndex` normalization effect kept: normalizes the raw index so indicator dots stay correct after item-list changes (removal would change behavior, not just performance).

## Verified already-correct (highlights)

Route-level `lazy()` + hover/focus chunk preload (AppHeader, HomePage, SeeAllPage); `Promise.allSettled` search fan-out; passive scroll listeners with cleanup everywhere; sliced library-store subscriptions (`useLibrarySelector`); `content-visibility` rails/grids; bounded localStorage (recent searches capped); module-scope regexes and `Intl.DisplayNames`; memoized `CarouselRow`/`ContinueCarousel`/`RecommendationRow`; no inline-defined components; no `0`/NaN conditional-render leaks.

## Verification

`tsc --noEmit` clean · `npm test` 179/179 across all suites · `npm run build:renderer` PASS · `npm run build:browser` PASS. Runtime behavior unchanged by design; the fixes eliminate wasted re-renders/refetches and a playback-restart hazard rather than altering features.
