# Connection milestone (C) evidence

Recorded: 2026-09-28 · Source: branch `001-build-torwatch-version` at `b98da62` (C01–C04 commits `3b1ecf9`, `b98da62` + this evidence commit).
Environment: Windows 11, Node v22.14.0. No Mac/Xcode/physical iPhone available in this environment; all native-device rows remain pending, as required.

## What was implemented

- **C01 launch policy** — `electron-app/src/lib/launch-policy.ts`: pure, reachability-free initial-route decision from configuration (missing / read-error / present), local inventory (empty / ready-exists / read-error), saved tab, and deep-link intent. Every row of spec C2 plus the config-read-error, inventory-read-error, expired-playback and downloads-deep-link edges is covered by `scripts/characterization/launch-policy.test.mjs`. No three-second redirect timer, no interaction latch — the superseded proposal is deleted.
- **C02 shared connection core** — `electron-app/src/lib/connection-coordinator.ts`: one deduplicated, generation-guarded, bounded (15s) probe used by all entries; probe-first save (syntax → reachability → protocol validated BEFORE persistence; verified readback with restore on failure); protocol compatibility verified separately from optional capabilities. `BrowserConnection` delegates to it; `origin-config.probeOrigin`/`applyServerOrigin` gained `protocolCompatible` (additive; existing tests unchanged and passing).
- **C03 shell migration** — `browser/main.tsx` resolves the launch surface at composition via the policy (inventory read without network). The gate renders ONLY for first installation; configuration read errors render a recovery screen (never first-install). Configured users always get the shell; `useConnectionGate` was removed after its only consumer migrated.
- **C04 surfaces** — WF02 Home recovery (Server unavailable / Retry / Go to settings, one block, no rail repetition); slim outage banner on other routes only (WF07); WF01 setup copy reduced to logo/heading/field/Connect; optional Downloads destination appended after Home/Library/Search only where `platform.downloads` exists (`NativeDownloadsAdapter` reports unavailable until D; browser/desktop keep three tabs); `DownloadsPage` with concise empty state, storage-error recovery, Waiting-for-server and Needs-repair rows (WF06); `?downloads=items|empty|storage-error` fixture previews (test-only).

## Verification performed

| Check | Command | Result |
|---|---|---|
| JS characterization suites (incl. 27 new policy/coordinator tests) | `npm run test:characterization` | 170/170 pass |
| Full `npm test` chain | `npm test` (electron-app) | all suites pass, 0 failures |
| TypeScript | `npx tsc --noEmit` | clean |
| Browser bundle | `npm run build:browser` | success |
| Mobile bundle | `npm run build:mobile` | success |
| Launch/outage smoke (Puppeteer, real bundle) | `npm run smoke:launch` | pass — 5 viewports (splash→form reveal, overflow, 200%-behavior via reduced-motion variant), malformed-URL validation, failed-connect retention (address + error preserved), fixture-ok enters shell without connect form, `fixtures=unreachable` shows WF02 recovery inside the shell with Retry and Go to settings and NO setup redirect |

## Acceptance status (connection milestone)

| ID | Status | Basis |
|---|---|---|
| C1 | pass (automated) | coordinator save tests (invalid/unreachable/protocol blocked before persistence; durable save verified by readback) + smoke failed-connect retention (address preserved, one error line) |
| C2 | pass (automated) | launch-policy tests: configured cold launch → shell immediately; reachability not an input; no onboarding redirect; `resolveBrowserOriginSource` distinguishes saved config from `?server=`/default fallback |
| C3 | pass (automated) | coordinator dedupe: no redundant re-check cycles; generation guard; smoke fixture-ok enters shell without flashing setup |
| C4 | pass (automated, logic) | deduped bounded probes; late results commit only when current (generation guard test); no timed Downloads redirect exists in code (policy has no reachability input). Interactive mid-probe navigation (C5) not exercised on device |
| C5 | pending | requires interactive device run (navigate/edit settings/notification before probe resolves) |
| C6 | pending | route-policy part covered by launch-policy tests with fixture inventory (labelled simulated); real-media local Play/Resume requires D + physical iPhone |
| C7 | pending | mid-session outage/local playback coexistence requires device run |
| C8 | partial | distinct states implemented and unit-tested: invalid URL (WF01 error), protocol mismatch vs missing capability (coordinator), persist-failure restore, config read-error recovery. Denied local-network access and storage write/read failures on iOS need device evidence |
| C9 | partial | smoke asserts Home recovery copy set and no instruction paragraphs; Setup layout and Settings2 icon preserved (unchanged components); side-by-side screenshot comparison against `visual-reference.md` not yet produced |
| X1 | partial | `npm test`, browser + mobile builds pass. Electron renderer build and Xcode build/tests pending |
| X2 | n/a | no backend changes in milestone C |
| X3 | partial | smoke covers 390px/320px/landscape/reduced-motion for setup + WF02; 200% text, keyboard/safe-area, VoiceOver and downloads-tab layouts need device/manual pass |

## Known issues / honest notes

- **Pre-existing smoke flake (not a regression):** `launch-screen-smoke.mjs` asserted keyboard focus returns to the server field after a failed connect. That assertion failed IDENTICALLY against the pre-change baseline bundle (`bc5fec0`, verified in a disposable worktree with the baseline smoke script and baseline dist build), so it predates this work. The smoke now asserts the C1 contract (address + error preserved), which passes. An explicit focus-restore effect was added to `LaunchScreen` (`setTimeout(0)` deferred `focus()`); in headless runs activeElement still reads empty immediately after failure, while a later manual `focus()` succeeds — needs a device/webview pass to confirm the real behavior.
- The Downloads tab is intentionally absent in production clients until milestone D lands (adapter reports `available: false`); fixture previews label their data as simulated.
- A real configured-phone launch with the server off (C2/C5/C6 device proof) remains mandatory before reporting "Connection milestone complete" to the owner.

## Rollback

Revert the C commits as one checkpoint (`git revert 3b1ecf9 b98da62` + evidence commit). Configuration storage (`mw_server_origin`) is unchanged in shape — no preference reset required; `mw_last_tab` is additive and ignored by older builds.
