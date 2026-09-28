# Baseline evidence (B01)

Recorded: 2026-09-28
Baseline commit: `401c713` (`docs: remove superseded agent handoffs and stale trace binary`)
Branch: `001-build-torwatch-version` (9+ commits ahead of origin)
Environment: Windows 11, Node v22.14.0, Go 1.24.2 windows/amd64.

## Git status at start

- Working tree clean before this packet's implementation work (offline-downloads packet committed in `401c713`).
- No overlapping homeserver checkout was in progress in this working tree; unrelated changes: none.

## Baseline test results

| Suite | Command | Result |
|---|---|---|
| Go vet | `go vet ./...` (torrent-streamer) | pass (no findings) |
| Go tests | `go test ./...` (torrent-streamer) | pass — all packages with tests ok (httpapi contract tests, watch, playback, migrations, cmd/vod) |
| JS suites | `npm test` (electron-app) | pass — skip-segments, diagnostics, player-contracts, network-routing, characterization, mobile-navigation, search all green |

## Current capability inventory (what works today)

- **Launch/gate**: `src/platform/PlatformProvider.tsx` `useConnectionGate` keeps `everReady` in a ref only — a fresh launch while the server is unreachable blocks the shared shell behind `LaunchScreen` even for a previously configured server. Later outages show a slim reconnecting banner (`src/browser/main.tsx`).
- **First setup**: `src/mobile/origin-config.ts` (`normalizeOrigin`, `probeOrigin`, `applyServerOrigin`) + `src/mobile/ServerSettings.tsx`; browser entry uses `LaunchScreen` (`src/components/shared/LaunchScreen.tsx`). Probes `GET /readyz` then `GET /v1/version` (15s timeout).
- **Desktop setup**: `src/platform/electron.ts` `createElectronConnection().saveOrigin` accepts only the fixed build-time origin; `probeBackendOrigin` (single `/v1/version`) is the second, separate probe path.
- **Navigation**: `src/components/shared/AppShell.tsx` destinations = Home/Library + Search + Settings (no Downloads). Settings opens via `torwatch:open-settings` custom event + `src/mobile/settings-overlay-controller.ts`.
- **Storage**: server origin in `localStorage` key `mw_server_origin` through the `DeviceStorage` port (`BrowserStorage`). No Capacitor Preferences.
- **Playback**: remote sessions via `src/platform/playback-session-client.ts` + native VLC plugin (`ios/App/App/TorWatchNativePlugin.swift`, MobileVLCKit). No local-file playback path in the player route.
- **Capabilities**: server advertises strings on `/v1/version` (`catalog.bff.v2`, `leases.shared`, `progress.serverOrdered`, `library.household.v1`, `recommendations.basic.v1`, `playback.compat.v1` conditional on ffprobe/ffmpeg). No `downloads.*` capability, no server instance identity.
- **Backend**: single Go module `torrent-streamer`; PostgreSQL migrations `001`–`008`; no downloads package, no `/v1/downloads` surface.

## Known baseline failures / pending hardware

- No automated failures. Windows cannot exercise Xcode/device work; native validation (D00, N03, physical-iPhone travel test) is pending and requires a signed physical iPhone.
- `npm run build` (vite production) not run at baseline; build verification happens per milestone.

## Caller map summary (B02 companion)

- Gate consumers: `src/browser/main.tsx` (`showGate`/`reconnecting`), mobile entry composes the same `BrowserApp` via `sharedAppElement`.
- Probe callers to centralize: `useConnectionStatus` → `connection.check()`; `origin-config.probeOrigin` (mobile setup); `electron.ts probeBackendOrigin`; per-hook callers listed in plan.md.
- Origin-change runtime: `src/lib/connection-service.ts` (`setBackendOrigin`, generation guards, cache resets).
- Library capability consumer pattern to mirror for downloads: `src/lib/library-store.ts` `refreshCapability` + `serverHasLibraryCapability`.
