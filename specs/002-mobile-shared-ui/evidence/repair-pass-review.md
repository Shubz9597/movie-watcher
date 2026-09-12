# Repair-pass evidence — M3.1.1–M4.2 review and fixes

Executed: 2026-09-10 (branch `001-build-torwatch-version` @ `5e9c648` + the full preserved M3.1.1–M4.2 diff). Scope: review and repair of the uncommitted implementation across seven findings, with regression tests. Nothing committed.

## Fix 1 — TMDb candidate deduplication by qualified identity

`internal/catalog/tmdb.go` `PopularCandidates` deduplicated trending results by NUMERIC id — a movie and a TV show sharing the same number would collapse. Fixed: the dedup key is the qualified media identity (`mediaType:id`). Regression test `TestTMDbPopularCandidatesKeepSameNumberMovieAndTV` proves both `tmdb:movie:123` and `tmdb:tv:123` survive as distinct candidates with correct kinds. PASS.

## Fix 2 — truthful cross-client removal reconciliation

Problem: per-title flags could only be reconciled from a full-scope EMPTY collection; a removal inside a NON-empty collection was invisible to other clients' bounded reads. Fix (server-backed, no inference):
- Server: new `library.Store.MembershipsFor` + additive endpoint `GET /v2/library/memberships?ids=a,b,…` (documented in contracts/library-api.md): returns the confirmed flags of requested server-known ids at the current revision; unknown ids are OMITTED (omission at revision R proves absence for clients older than R); malformed ids skipped; ≤100 ids per batch (400 beyond); missing ids parameter → 400.
- Client: `LibraryStore.reconcileMemberships()` runs with every bounded poll (`refreshAll`) over locally-known titles, applying per-title revision rules (newer server revision reconciles flags; omissions clear stale flags).
Tests: DB-gated `TestLibraryMembershipsEndpoint` (confirmed flags, omitted unknown id, post-removal CONFIRMED false at revision 3, 400s); client `library-repair.test.mjs` "removal of one title in a NON-empty collection reconciles per-title within one poll" (removed title reconciled to false, remaining title retained, both at revision 4). All PASS against disposable PostgreSQL.

## Fix 3 — cursor revision change discards the mixed snapshot

`loadMore` previously appended a cursor page whenever its revision was not older. Now: if the cursor page's revision DIFFERS from the loaded page's revision, the fetched page is discarded and the grid refetches from page one (one consistent snapshot). Regression test: cursor page at revision 6 while the loaded page is revision 5 → no mixed items; page one refetched exactly once; grid = revision 6. PASS.

## Fix 4 — origin-change protection for recommendations and remaining library paths

- `useRecommendations` (RecommendationRow/AllPage) now subscribes to origin changes: loaded recommendations are CLEARED and the section refetches against the new origin; the subscription is detached on unmount.
- `LibraryStore.refreshCapability` captures the generation at probe start; a delayed old-origin capability response can no longer set the new origin's availability (the switch's own re-probe yields the truthful verdict).
- `performWrite` failure path now also discards when the generation changed (an old-origin FAILURE no longer publishes an error on the new origin; pending was already cleared by the switch).
- Regression tests (delayed old-origin responses): capability probe discarded (`unreachable` truthfully reflects the dead new origin, never the leaked `available`); write failure dropped with no error and no stuck pending. PASS.

## Fix 5 — mojibake repair + regression guard

PowerShell `Get-Content/Set-Content` round-trips had double- and single-encoded UTF-8 punctuation across `browser/main.tsx`, `pages/LibraryPage.tsx`, `lib/library-store.ts` and `components/shared/RecommendationRow.tsx` (em-dashes, ellipses, curly quotes, ✕/✓, 🎬, middle dots). All repaired via byte-exact Node replacements (no further PowerShell text round-trips). Regression guard added: `library-repair.test.mjs` "no mojibake remains in the touched sources" scans the touched sources for the corruption fingerprints. PASS. (A pre-existing mojibake fingerprint in a characterization comment was also replaced during the M3.1.1 rewrite.)

## Fix 6 — anime-preserving navigation

`lib/canonical-route.ts` `titleRouteParams(canonicalId, type?)`: the server's canonical classification drives the route kind — a TMDb anime navigates as `kind=anime, provider=tmdb, mediaKind=tv|movie` while keeping the QUALIFIED tmdb identity (previously it navigated as a plain series/movie, losing the anime classification). `LibraryPage.LibraryCardButton` and the recommendation cards pass the row's type. Tests: five navigation assertions (TMDb anime series/movie, non-anime, AniList). PASS.

## Fix 7 — lifecycle, semantics, configuration hygiene

- **Origin-subscription cleanup**: `LibraryStore` remembers its `subscribeOrigin` unsubscribe; `dispose()` detaches it and clears listeners. Regression test: a disposed store does not reset on origin switches and leaks no state.
- **No-op writes vs revision semantics**: documented in `store.go` — a no-op/retried write commits without touching the revision, mutation_revision, added timestamps, or the metadata snapshot (nothing the revision semantics depend on). Behavior was already correct; the invariant is now explicit and covered by the existing tests.
- **Hard-coded candidate-cache version**: replaced with the reviewed constant `recommendations.CandidatePoolVersion` (documented: bump in the release that changes candidate-pool inputs; cache churn is a deliberate release decision). `cmd/vod/main.go` uses it.

## Checks run

| Check | Result |
|---|---|
| `gofmt -l` on all touched Go files | clean |
| `go vet ./...` | PASS |
| `go test -race -p 1 -count=1 ./internal/library/ ./internal/recommendations/ ./internal/catalog/` (disposable DSN) | PASS, no data races |
| `go test -p 1 -count=1 ./...` (disposable DSN, pristine DB) | PASS — all packages, zero skips |
| `npm test` (all suites incl. new `library-repair.test.mjs`, 6 tests) | PASS, exit 0 |
| `npx tsc --noEmit` | PASS |
| `npm run build:renderer` / `npm run build:browser` | PASS |
| `git diff --check` | clean (EOF whitespace trimmed) |
| Secrets/generated-artifact scan over the changed files | clean |
| Production browser bundle scan | no `node:*` built-ins, no electron imports (pre-existing guarded `window.electronAPI` probes only) |
| Browser smoke: `capture-library-m33.mjs` + `capture-recommendations-m42.mjs` re-run after repairs | all 17 captures rendered and inspected; no regressions |

## Infrastructure

Task-owned disposable container `torwatch-repair-postgres` (postgres:16-alpine, loopback-only 54345, throwaway credentials, healthcheck, no volumes) for the DB-backed and live runs; **removed after checks**. Pre-existing Compose containers untouched.

## Evidence classification

- **Fixture evidence**: recommendation-ui, library-toggle, library-store/sync/repair unit tests (deterministic stubs).
- **Stub-provider evidence**: live HTTP runs (memberships endpoint, two-client sync, recommendations) used deterministic local TMDb stubs — no live provider credentials exist on this machine.
- **Interactive smoke**: browser-entry smoke re-ran via both capture harnesses after the repairs (all states rendered). Desktop Electron interactive smoke was NOT run on this PC (no packaged run) — that remains part of the standing M0.2/interactive gate.
- **Not claimed**: native mobile readiness, browser playback, live-provider verification.

## Remaining risks

1. The memberships reconciliation covers locally-KNOWN titles; a client that never displayed a title learns it from lists/pages — acceptable for the alpha household scale, revisited if collections grow very large.
2. `window.electronAPI` guarded probes remain in the shared bundle (pre-existing, inert in browsers).
3. Windows test-runner job-object quirk can make spawned Go children exit immediately on rare occasions; live scripts now use taskkill and are verified green.
4. `Title A–Z`'s en-dash and similar characters depend on editors preserving UTF-8 — the regression test now guards this.

## Verdict

All seven findings fixed with regression tests; full Go (incl. race), client, build, DB-backed and smoke checks pass with zero skips. The M3.1.1–M4.2 implementation is consistent with the contracts and evidence. Next milestones unchanged: M0.2 interactive desktop smoke and M1.3/M1.4 device playback (hardware), then M5.
