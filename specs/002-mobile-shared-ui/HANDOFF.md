# HANDOFF — torWatch feature 002 (shared mobile UI + household library)

Fresh-session context handoff. Written 2026-09-11 from a verified repository inspection on the continued working tree; updated the same day after the M0.2 smoke, sync repairs, and staging hardening. Read this top-to-bottom before touching code.

---

## 1. Product objective and current architecture

torWatch is a private-homeserver media app (discover → save → stream movies/series/anime) with an Electron desktop client and a shared React browser/mobile UI. Feature 002 adds:

- One shared React presentation layer used by Electron desktop AND a browser/phone entry (`src/browser/main.tsx`) — no duplicated screen tree.
- A Go BFF (`torrent-streamer`) owning catalog merge, source selection, progress, the household Library (Watch Later / Favourites), and bounded recommendations. Provider credentials stay server-side.
- Household Library persistence: migration `007_library_household.sql` (single household row + unique memberships with independent booleans), served via `/v2/library/*` and gated by the `library.household.v1` capability.
- Bounded deterministic recommendations (`/v2/recommendations`, `recommendations.basic.v1`): favourites are seeds, candidates come from TMDb trending (via `CandidateProvider`), scored by distinct-seed genre overlap, cached ≤15 min keyed by household revision + candidate version.
- Cross-client sync: a bounded 15-second poll (`library-sync.ts`) while the tab is visible, plus a server-backed per-title memberships reconciliation probe (`GET /v2/library/memberships?ids=…`) that makes removals by other clients visible even in non-empty collections.

Identity rule (M3.1.1, load-bearing everywhere): TMDb canonical ids are media-qualified — `tmdb:movie:N` / `tmdb:tv:N`. The unqualified `tmdb:N` is a read-only legacy alias resolved movie-first; it is never a library key and is never emitted by producers.

## 2. Authoritative documents (reading order)

1. `HANDOFF.md` (this file)
2. `specs/002-mobile-shared-ui/spec.md` — user stories + requirements
3. `specs/002-mobile-shared-ui/plan.md` — architecture, contracts, phases
4. `specs/002-mobile-shared-ui/tasks.md` — task ledger with completion ticks
5. `specs/002-mobile-shared-ui/data-model.md` — Library persistence design
6. `specs/002-mobile-shared-ui/contracts/library-api.md` — Library HTTP contract (incl. memberships endpoint + singular `/favourite` path)
7. `specs/002-mobile-shared-ui/contracts/recommendations-api.md` — recommendations contract
8. `specs/002-mobile-shared-ui/evidence/repair-pass-review.md` — seven review findings and fixes
9. `docs/mobile-ui/architecture.md` and `docs/mobile-ui/change-map.md`
10. Milestone evidence files (§4 below)

## 3. Baseline commit, branch, dirty-worktree warning

- Branch: `001-build-torwatch-version`
- Baseline commit: `5e9c6489b6817bb71e4091da21a6a16c68d24680`
- Baseline before this feature checkpoint was `5e9c6489b6817bb71e4091da21a6a16c68d24680`. The operator explicitly authorized a local checkpoint commit on 2026-09-12; inspect `git log -1` and `git status` before continuing. Do not reset or clean unrelated later work.

## 4. Completed milestones (evidence links)

| Milestone | Evidence |
|---|---|
| M0.1 baseline | `evidence/baseline.md` |
| M1.1 adapter map | `evidence/m1-adapter-map.md` |
| M1.2 browser entry | `evidence/m1.2-browser-entry.md` |
| M2.1–M2.5 shared UI | `evidence/m2.1-m2.2-shared-ui.md`, `m2.3-title-sources.md`, `m2.4-motion-performance.md`, `m2.5-visual-qa-report.md` |
| M3.1 identity contracts | `evidence/m3.1-identity-contracts.md` |
| M3.1.1 qualified ids | `evidence/m3.1.1-qualified-identity.md` |
| M3.2 Library storage + API | `evidence/m3.2-library-storage-api.md` |
| M3.3 desktop Library consumer | `evidence/m3.3-desktop-library-consumer.md` |
| M3.4 phone sync | `evidence/m3.4-phone-library-sync.md` |
| M4.1 server recommendations | `evidence/m4.1-server-recommendations.md` |
| M4.2 shared recommendations UI | `evidence/m4.2-shared-recommendations-ui.md` |
| M0.2 desktop smoke (PARTIAL) | `evidence/m0.2-desktop-smoke.md` + `evidence/captures/m02-*.png` |
| M1.3.2–M1.3.8 playback service foundation | `evidence/m1.3-playback-service.md` (server/container evidence; parent physical-device gate remains open) |
| M1.3/M1.4 feasibility packet | `evidence/m1.3-m1.4-feasibility-packet.md` (native-client portion not executed) |
| Tailscale operator checklist | `evidence/tailscale-operator-checklist.md` (Serve enablement remains pending) |
| Repair pass (7 findings) | `evidence/repair-pass-review.md` |
| Desktop staging | `evidence/` — see §7; staging-specific evidence is the live stack itself + `verify-staging.mjs` output |

## 5. Files changed/added by component

**Go backend** (`torrent-streamer/`): `internal/library/` (store, seeds, read path, tests) — NEW package; `internal/recommendations/` (scoring, cache, tests) — NEW; `internal/httpapi/library_handlers.go` + `recommendation_handlers.go` + tests + `cors.go` (PUT preflight) + preflight test; `internal/catalog/tmdb.go` (qualified ids, CandidateProvider) + tests; `migrations/007_library_household.sql` + migrate_test; `cmd/vod/main.go` (wiring + capability advertisement); `tools/` live-verify scripts.

**Shared client** (`electron-app/src/`): `lib/library-store.ts`, `lib/library-sync.ts`, `lib/library-react.tsx`, `lib/canonical-route.ts`, `lib/services/library-service.ts` (extended), `lib/services/recommendation-service.ts`, `components/shared/LibraryToggle.tsx`, `components/shared/RecommendationRow.tsx`, `pages/LibraryPage.tsx` (rewritten), `pages/RecommendationsAllPage.tsx`, `pages/TitlePage.tsx` (toggles), `pages/HomePage.tsx` (row mount), `App.tsx` + `browser/main.tsx` (composition roots), `platform/library-fixtures.ts` + `recommendation-fixtures.ts`, `lib/services/catalog-bff.ts` + `catalog-gateway.ts` (qualified ids), `lib/adapters/media.ts`.

**Staging** (`deploy/desktop-staging/`): `staging.ps1` (Start/Status/Stop/Verify/VerifyAfterRestart/RestartBackend/Reset), `compose.yaml` (project `torwatch-staging`), `serve-browser.mjs` (+ `serve-browser.test.mjs` regression suite), `provider-stub.mjs` (incl. deterministic `/3/discover/*`), `verify-staging.mjs` (18 full / 13 post-restart checks), `m02-smoke.ps1` + Electron smoke `electron-app/scripts/m02-desktop-smoke.cjs` (+ `m02-smoke-preload.cjs` shim), `.env.example`, `README.md`, `.gitignore`.

**Tests/player harness**: `scripts/characterization/` contains the Library/recommendation regressions; `scripts/player-state-contracts.test.mjs` now checks that native bindings expose the complete child-window API; `scripts/embedded-playback-smoke.cjs` fails early on stale bindings and accepts an already-hidden Electron menu without weakening visible-menu removal checks.

**Docs/specs**: `contracts/library-api.md` (amended), `contracts/recommendations-api.md` (new), all evidence files above, `visual-followups.md`, `plan.md` status, `tasks.md` ticks, `.gitignore` (staging env.example whitelist), root/electron README (staging pointer), `run-mobile-preview.ps1` + `scripts/mobile-preview.mjs` (reviewed; npm install → npm ci).

## 6. Load-bearing invariants

- **Identity**: producers emit `tmdb:movie:N` / `tmdb:tv:N` end-to-end. `tmdb:N` = read-only alias (movie→tv probe). Anime is a classification over the structural id (`type: anime` keeps `tmdb:tv:N`), and navigation passes `row.type` so the route renders anime while retaining qualified identity. Library/membership writes reject `tmdb:N` (400).
- **Revisions**: lossless decimal strings, compared per-resource with BigInt. A response with an older revision for the same resource is discarded. Never `Number()` a revision.
- **Synchronization**: 15s bounded poll, visible-only, no overlap; removals reconcile via the memberships probe; a no-op write never advances the revision; a revision change between cursor pages discards the mixed snapshot and refetches page one.
- **Origin switches**: bump a generation counter; in-flight responses are aborted and discarded; the library store clears all origin-scoped state and re-probes capability; recommendation hooks clear and refetch. Write failures from an old origin are dropped silently (never surfaced on the new origin).
- **Capabilities**: `library.household.v1` / `recommendations.basic.v1` advertised ONLY when their storage/service is actually wired. Missing capability → explicit "library unavailable" / no recommendation section.
- **CORS**: explicit origin allowlist; wildcard rejected; PUT preflight allowed for the library surface (was a caught bug).
- **CSP**: the browser bundle bakes ONE exact backend origin at build time (`VITE_TORWATCH_BACKEND_URL`); never relax connect-src.

## 7. Windows desktop staging

Location: `deploy/desktop-staging/`. Architecture: Compose project `torwatch-staging` runs PostgreSQL (127.0.0.1:5433, named volume `torwatch-staging_pgdata`, persists across stop/start); the Go backend builds from the working tree and listens on 127.0.0.1:4001; the production browser bundle (`dist-browser`, built with `VITE_TORWATCH_BACKEND_URL` + `VITE_CATALOG_SOURCE=bff`) is served by `serve-browser.mjs` on 127.0.0.1:4174. Optional Tailscale Serve exposes both privately; the URL scheme always matches the listener (`--https` default, `-TailnetHttp` for plain HTTP); Funnel is never used; mappings are attempted BEFORE any local process spawns and a not-enabled/hanging CLI degrades to LOCAL-ONLY with exactly one printed user action.

Commands (from `deploy/desktop-staging/`, PowerShell):

| Command | Effect |
|---|---|
| `staging.ps1 Start [-NoTailscale] [-ValidationStub] [-WithProwlarr] [-TailnetHttp]` | start stack; -ValidationStub adds the deterministic provider stub when no TMDB_API_KEY exists; -WithProwlarr enables LIVE torrent search (key read privately from data\prowlarr\config.xml) |
| `staging.ps1 Status` | PIDs, container health, /readyz, /v1/version, Serve mappings or pending-enablement action |
| `staging.ps1 Verify` | 18-check full validation (incl. two-browser-context cross-client sync) |
| `staging.ps1 VerifyAfterRestart` | restart backend, then 13-check persistence re-verification |
| `staging.ps1 VerifySource` | bounded live source check: search → resolve → 30s 64KiB peer probe (timeout = truthful peer availability) |
| `staging.ps1 Stop` | stop harness PIDs + Serve mappings + container; data preserved |
| `staging.ps1 StopLeftovers` | recover an interrupted Start (stops only processes provably owned by the harness) |
| `staging.ps1 Reset [-Force]` | WIPE staging data (explicit; prompts without -Force) |

Mobile-web playback smoke: `node scripts/mobile-browser-smoke.mjs` (electron-app) drives an iPhone-sized headless Chromium through app-load → title → source select → PlayerPage → BrowserPlayer video UI → Close (10 checks; synthetic search fixture for UI mechanics only).

Prerequisites: Docker Desktop running; Go; `electron-app/node_modules` present (`npm ci` once); optional Tailscale logged in with Serve ENABLED for the tailnet; optional TMDB_API_KEY in `.env`. Secrets load from `deploy/desktop-staging/.env` (gitignored; template `.env.example`). See `deploy/desktop-staging/README.md` for full operator docs incl. the iPhone steps.

## 8. Latest verified results (2026-09-12, this machine)

- **M1.4 final correctness repair (Codex)**: native dismiss/seek is now playId-scoped through TypeScript, Swift, and Kotlin; stale start resolution and rejection are proven unable to clear or dismiss their replacement; native listener registration gates playback and every successful handle is removed on disposal, including partial-registration failure; failed origin persistence restores the previous runtime origin; current source/milestone documents are guarded against mojibake and control-byte corruption. Focused native/session tests 29/29, all JavaScript test groups 155/155, tsc, renderer/browser/mobile builds, Capacitor Android+iOS sync, focused Go fixture/CORS tests, and gofmt check PASS. Full Go race rerun was interrupted after a Windows isolated-cache stall; the pre-repair broad Go race baseline remains green and this final pass changed no Go production code.
- **M1.4 REPAIR PASS (2026-09-12, correctness audit)**: Android plugin rewritten as idiomatic Kotlin (Java syntax + media3 AudioAttributes mismatch fixed; playId replacement tagging; activity static-leak + error-finish fixes); iOS plugin AVKit import + sanitized errors + playId; platform-explicit profiles (ios-avplayer/android-media3); ONE-React-root mobile shell with overlay settings (no hash-router competition) + composition disposal; probe-before-persist origin flow through canonical saveOrigin with durability verification; lifecycle races closed (unsupported DELETE, play-reject cleanup, superseded-start release, pause flush, playId event filtering); URL hardening (lookalike/cross-origin rejection, tested); FixtureResolver discovers SRT/VTT/ASS sidecars. Ledger corrected: M1.4.4/M1.4.5/M1.4.7 REOPENED (static-only/uncompiled/unwired claims no longer DONE). Post-repair: tsc PASS, npm 123/123, builds+sync PASS, Go -race suites PASS. See evidence/m1.4-native-mobile-foundation.md (repair section).
- **M1.4 native-mobile foundation COMPLETE (code-complete; hardware gates open)**: Capacitor 8.5.2 shell (dist-mobile + tracked ios/android projects, cap sync PASS), shared playback-session client + NativePlaybackController (9/9 focused tests; npm suite 107/107; tsc PASS; renderer/browser/mobile builds PASS), iOS AVPlayer Swift plugin (registered; xcodebuild BLOCKED ON MAC/XCODE), Android Media3 Kotlin plugin (gradle scripts parse; assembleDebug BLOCKED — no Android SDK), exact Capacitor origins pinned by Go regression tests, mobile settings/onboarding, cleartext-refused-by-default network security. Evidence: evidence/m1.4-native-mobile-foundation.md; guide: docs/mobile-ui/mobile-build-run.md. NO physical-device claims. FFmpeg still unconfigured on this host (M1.4.1 SKIP path proven).
## 8. Latest verified results (2026-09-12, this machine)

- **M1.3.x playback service (server foundation) COMPLETE**: `internal/playback` + `/v2/playback/*` per `contracts/playback-api.md`; capability gated on verified FFmpeg/ffprobe; direct/remux/bounded-transcode/unsupported modes; loopback token media source keeps magnets off tool command lines, playlists, URLs, logs, and errors; WebVTT subtitle normalization with a validity gate; TTL cleanup constrained to the data root. The checkpoint review additionally fixed session-limit/Stop races, direct-session directory leakage, expiry enforcement on file endpoints, conversion-slot release after FFmpeg exits, and incorrect transcoded HLS metadata. HDR rejected by a client profile remains truthfully unsupported until tone mapping is verified. See `evidence/m1.3-playback-service.md`. NO native shells yet (M1.4/Capacitor = next milestone). NO M1.3/M1.4/M5/M6 completion claims.

- **Mobile web playback layer implemented and mechanically verified**: BrowserPlayer (native HTML5 `<video>` → `/stream?cat&magnet&fileIndex` with current backend origin), PlayerPage routed in the browser entry with RouterProvider, TorrentPanel browser Play path, session-safe resume/heartbeat, truthful codec errors, nested-button a11y fix, magnet redaction. `browser-player.test.mjs` 3/3, `tsc --noEmit` clean, browser build PASS, **mobile browser smoke 10/10** (iPhone-sized Chromium; synthetic search fixture for UI mechanics only — see `evidence/mobile-web-playback-session.md`).
- **Live Prowlarr**: `-WithProwlarr` → `/readyz` reports prowlarr ok; `VerifySource` PASSED real search (Big Buck Bunny candidate, 5 results) + magnet resolution (redacted), then the 30s peer-data probe TIMED OUT (1 seeder) — truthful external availability result; playback unproven.
- **PWA**: manifest + true 512×512 icon served (`sizes` now truthful; previous icon was 1672×941 while claiming 512×512); online-only, no service worker.
- **Staging verification: 18/18 + 13/13 post-restart PASS** (2026-09-11 run; stack restarted since with -WithProwlarr — rerun `staging.ps1 Verify` if needed).
- **Tailscale Serve: PENDING ONE USER ACTION** — Serve not enabled for the tailnet and `serve --bg` HANGS (1.102.4) instead of erroring; the harness bounds it to 25s, constructs the enablement URL from Self.ID, and continues LOCAL-ONLY. URL is in state.json + printed by Start/Status. After enabling: `Stop` → `Start -ValidationStub -WithProwlarr` → tailnet URLs printed (scheme always matches the listener). Funnel never used.
- Catalog evidence remains DETERMINISTIC-STUB-BACKED (no TMDb key). Library/sync/persistence evidence is real (staging PostgreSQL).

## 9. Current running resources

Staging is RUNNING (2026-09-12, local-only + LIVE Prowlarr): PostgreSQL `torwatch-staging-postgres` (healthy), backend pid/frontend pid/stub pid in `state.json` (127.0.0.1:4001 / 4174 / 4499, stub mode, prowlarrEnabled=true), root-compose containers `torwatch-prowlarr` + `torwatch-flaresolverr` (operator-started, intentionally running). Tailscale Serve mappings: NONE (pending user enablement; URL in state.json, printed by Status). Stop: `staging.ps1 Stop`. Recreate: `staging.ps1 Start -ValidationStub -WithProwlarr`.

## 10. Environment variable NAMES (never commit values)

Loaded by `staging.ps1` from `deploy/desktop-staging/.env` (gitignored) or process env:
`STAGING_PG_PASSWORD` (required), `STAGING_PG_PORT`, `BACKEND_PORT`, `FRONTEND_PORT`, `TMDB_API_KEY` (optional; empty → stub mode), `TAILNET_FRONTEND_SERVE_PORT`, `TAILNET_BACKEND_SERVE_PORT`, `TAILNET_ORIGIN` (optional), `FFMPEG_PATH`, `FFPROBE_PATH`, `PLAYBACK_DATA_ROOT`, `PLAYBACK_MAX_TRANSCODES`, `PLAYBACK_SESSION_TTL`, `PLAYBACK_PROBE_TIMEOUT`, `PLAYBACK_MAX_TRANSCODE_HEIGHT`, `PLAYBACK_MAX_SESSIONS`, `TORWATCH_PLAYBACK_FIXTURE_ROOT` (validation only).

Build-time (Vite): `VITE_TORWATCH_BACKEND_URL` (exact backend origin baked into CSP), `VITE_CATALOG_SOURCE=bff` (staging sets both). Server-side: `PG_DSN`, `LISTEN`, `TORWATCH_ALLOWED_CLIENT_ORIGINS`, `TORWATCH_TMDB_BASE_URL`, `PROWLARR_URL`, `PROWLARR_API_KEY` (staging placeholder), `TORRENT_DATA_ROOT`, `SUB_CACHE_DIR`, `LOG_FILE`, `ERROR_LOG_FILE`, `TORWATCH_APP_VERSION`. Browser catalog-source fallback: `VITE_CATALOG_SOURCE` (pre-existing M1.2 mechanism in `catalog-source.ts`).

## 11. Known limitations and unresolved risks

- **Opaque-origin library writes (accepted boundary, M5 target)**: the default CORS allowlist contains `null` for the packaged file:// desktop renderer, which MUST keep library write access (M3.3). A sandboxed iframe on a public page shares `Origin: null`, so opaque-origin writes are not attributable; Chromium Private Network Access is the current mitigation. Documented in `internal/config/server_config.go` and `internal/httpapi/library_handlers.go`. Do NOT "harden" by dropping `null` from writes — that breaks the packaged desktop app; the durable fix is serving the renderer from a non-opaque origin (M5).
- The cross-client removal check (18-check suite) failed once at exactly 20s BEFORE the sync repairs (jitter drop + lost overlap refresh); after the fixes it passes at ~15.0s repeatedly. If it regresses, check `library-sync.ts` POLL_INTERVAL_MS/catch-up and the `refreshAll` queue in `library-store.ts`.
- Tailscale Serve paths are written but unexercised (no CLI on this machine) — first real use may surface syntax/ACL issues the runtime checks cannot predict; see `evidence/tailscale-operator-checklist.md`.
- The memberships reconciliation covers locally-known titles; a client that never displayed a title learns it from list/page loads. Fine at alpha household scale.
- `window.electronAPI` guarded probes remain in the shared bundle (pre-existing, inert in browsers).
- Provider stub evidence is synthetic; no live-provider verification has been done on this machine. The stub now also serves deterministic `/3/discover/*` (genre sections render under stub; content is fake).
- M0.2's smoke is a programmatic surrogate: the human-run OPERATOR-CHECKLIST-T020-T042.md boxes remain open. Native generated-video playback and a direct resume offset are proven, but backend streaming, real subtitle loading, and server-persisted resume are not.
- Native `.node` artifacts are intentionally gitignored. This workstation's stale Windows artifact was rebuilt from the checked-in Rust source; a fresh build/packaging machine must also run the native build before packaging.
- `run-mobile-preview.ps1` and `scripts/mobile-preview.mjs` are retained because package scripts/operator docs reference the preview harness. The local session transcript, scratch `stub-extract.mjs`, and playback runtime cache are intentionally excluded from version control.
- Windows test runner may trip a libuv teardown assertion when spawning Go children; live scripts use `taskkill /pid … /t /f` on exact recorded PIDs (verified green).

## 12. Hardware-only gates (must NOT be claimed complete)

- M0.2 remainder: end-to-end source selection → backend stream → actual subtitle → server-persisted resume plus the human-run OPERATOR-CHECKLIST-T020-T042 boxes. Native desktop MPV mechanics are now proven; the remaining flow needs a real Prowlarr/torrent source or an approved test-only fixture route.
- M1.3/M1.4: real iPhone playback, transport matrix, interruption/resume (see `evidence/m1.3-m1.4-feasibility-packet.md` for the prepared starting point; hard gate = Mac + Xcode + iPhone).
- M5: iOS packaging, VoiceOver, native insets (also the point where the renderer must leave the opaque file:// origin).
- M6: Android shell, TalkBack, Radxa ARM64 deployment, cross-client release matrix.
- Radxa equivalence: the Windows staging simulation does NOT validate ARM64, homeserver networking, or real-device performance.

## 13. Exact next recommended task

**Two parallel tracks**:

1. **Deterministic playback proof on staging** (Windows): install FFmpeg (operator choice of location), set FFMPEG_PATH/FFPROBE_PATH + TORWATCH_PLAYBACK_FIXTURE_ROOT in deploy/desktop-staging/.env, run staging.ps1 Make-PlaybackFixtures, Stop + Start -ValidationStub -WithProwlarr -WithCapacitorOrigins, then staging.ps1 VerifyPlayback (9 deterministic checks turn from SKIP to PASS).
2. **Device runs**: Mac+Xcode -> `npm run cap:open:ios` (sources pre-registered; sign with a free Apple ID, run on a cable-connected iPhone). Windows+Android SDK -> set `ANDROID_HOME`, then run `gradlew -p android assembleDebug`. Then execute the real-device codec/interruption matrix for M1.3/M1.4 acceptance.

## 14. Fresh-session startup checklist

1. Read sections 1-3. Confirm the branch is `001-build-torwatch-version` at `b618e00` and review the intentionally uncommitted M1.4 working tree.
2. Read `tasks.md` ledger — every [x] has evidence; do not re-tick without running the named verification.
3. Read `contracts/library-api.md` + `contracts/recommendations-api.md` before touching any HTTP surface.
4. Check staging state: `docker ps --filter name=torwatch-staging` and `Get-Process torwatch-staging`. If stopped, run Start (§7).
5. Run `staging.ps1 Verify` to confirm the stack is green before making changes.
6. Run `npm test` in `electron-app` and `go test ./...` in `torrent-streamer` to confirm the baseline.
7. Read §6 invariants — violating any of them is the most likely way to break the system.
8. Make changes; add/extend regression tests in the same style; run the checks in §8.
9. Update the relevant evidence file and THIS handoff (§15) when done.

## 15. UPDATE THIS HANDOFF

After EVERY milestone or significant fix, the completing agent MUST:

1. Update §4 (add milestone row + evidence link) and §8 (latest verified results with real numbers from an actual run — never aspirational).
2. Update §5 if new files were added/removed, grouped by component.
3. Update §6 if any invariant changed (identity, revisions, sync, origin, capabilities, CORS, CSP).
4. Update §7 if staging commands/architecture changed; update §9 with current running resources.
5. Update §11 (new risks) and §12 (gates still open) honestly.
6. Update §13 with the exact next recommended task.
7. Keep the file under 300 lines; use placeholders for private origins/DNS names; never include secrets, magnets, watch history, or raw logs.
