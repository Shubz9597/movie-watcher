# Example: Client-Ready Final Report

This is the shape the agent should produce after an audit, following the Output Format in `SKILL.md`. Numbers below are illustrative — replace with real measurements.

---

# React Native Performance Audit — Feed Screen

**Project:** Acme Mobile · **RN:** 0.74 · **Expo:** none · **Platforms:** iOS + Android
**Scope:** Feed screen scroll performance + cold start
**Build used for verdicts:** Release (Android, Samsung A14 + Pixel 7)

## Summary
Audited the Feed screen and app cold start. The Feed stutter was caused by a list that re-rendered every row on each interaction and loaded full-resolution images in cards. Cold start was blocked on a startup network call and eager analytics/preloading. Applied surgical fixes (stable list rendering, memoized rows, thumbnails, deferred startup work) with no behavior changes. Re-measured in release.

## Issues Found
| # | Area | Issue | Severity |
|---|------|-------|----------|
| 1 | Startup | `await api.get('/me')` blocked first paint | **Critical** |
| 2 | Lists | Inline `renderItem` + non-memoized `FeedCard` → every row re-rendered | **High** |
| 3 | Images | Full-resolution remote images in list rows | **High** |
| 4 | Startup | Analytics + full preload ran before UI shown | **High** |
| 5 | Lists | Index-based `keyExtractor` on a paginated list | Medium |
| 6 | Bundle | All screens eagerly imported in `RootNavigator` | Medium |
| 7 | Rendering | Theme object recreated each render, re-rendering subtree | Low |

## Files Changed
| File | Why |
|------|-----|
| `App.tsx` | Deferred analytics/preload after first paint; removed blocking profile fetch and blocking flag fetch |
| `src/screens/Feed/FeedScreen.tsx` | Stable `renderItem`/`keyExtractor`/`getItemLayout`; tuned list windowing |
| `src/components/FeedCard.tsx` | Wrapped in `React.memo`; switched to thumbnail image source |
| `src/screens/Profile/ProfileScreen.tsx` | Moved `/me` fetch to the screen that needs it (RTK Query) |
| `src/navigation/RootNavigator.tsx` | Lazy-loaded Settings + other non-first screens |

## Fixes Applied
- **Startup:** moved `analytics.init()` and `preloadEverything()` into `runAfterInteractions`; profile data now loads in the Profile screen; feature flags load non-blocking with safe defaults.
- **Lists:** memoized `FeedCard`, stabilized `renderItem`/`keyExtractor`, added `getItemLayout` (fixed card height), tuned `initialNumToRender`/`maxToRenderPerBatch`/`windowSize`.
- **Images:** rows now request `thumbnailUrl` sized for the card instead of the original.
- **Bundle:** lazy-loaded heavy non-first screens.

## Validation
| Check | Result |
|-------|--------|
| `yarn tsc --noEmit` | ✅ pass |
| `yarn lint` | ✅ pass |
| `yarn test` | ✅ pass |
| `./gradlew assembleRelease` | ✅ built |
| Cold start (release, A14) | ~4.6s → ~1.9s *(am start -W)* |
| Feed scroll (release, A14) | dropped frames on fling: many → few *(DevTools Profiler)* |
| iOS `pod install` + Release run | ✅ built; scroll smooth on iPhone 12 |

## Manual Testing Steps
1. Cold-start the **release** app on a low-end Android device; confirm the first screen paints quickly and the splash doesn't hang.
2. Open Feed; fling top→bottom several times; confirm smooth scrolling.
3. Like several posts while scrolling; confirm likes toggle and only the tapped card updates.
4. Pull-to-refresh; confirm list reloads correctly.
5. Navigate to Settings (lazy-loaded); confirm it opens normally.
6. Cold-start in airplane mode; confirm UI shows (no stuck splash).

## Remaining Risks
- Cold-start and scroll numbers were measured on two devices; verify on the lowest-end device in your support matrix.
- Feature-flag default-then-refresh means the very first frame uses defaults — confirm that's acceptable for any flag that changes UI.
- `getItemLayout` assumes a fixed card height; if cards become variable-height later, remove it.

## Next Steps
1. Add a lightweight cold-start + scroll metric to CI or production monitoring (e.g. Sentry performance) to catch regressions.
2. Consider an image-caching library only if remote thumbnails still re-decode on scroll (measure first).
3. Re-audit after the next batch of feature work touching Feed or startup.
