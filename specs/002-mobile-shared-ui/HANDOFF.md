# HANDOFF — torWatch feature 002 (shared mobile UI + household library)

Fresh-session context handoff. Updated 2026-09-14 after the M1.4 native-mobile foundation and the first real-device playback attempt. Read top-to-bottom before touching code.

## 1. Architecture (current)

One shared React UI (electron-app/src/) used by Electron desktop AND mobile via Capacitor. Go BFF (torrent-streamer) owns catalog, library, recommendations, playback sessions, torrent search/resolution, subtitles. Native plugins: Swift AVPlayer (ios/), Kotlin Media3 (android/). Playback compat service (`internal/playback`) manages sessions, ffprobe inspection, HLS/fMP4 remux/transcode, and the loopback token media source.

## 2. Authoritative documents

1. HANDOFF.md (this file)
2. specs/002-mobile-shared-ui/spec.md · plan.md · tasks.md
3. contracts/playback-api.md · contracts/library-api.md
4. evidence/m1.3-playback-service.md · evidence/m1.4-native-mobile-foundation.md
5. docs/mobile-ui/mobile-build-run.md · deploy/desktop-staging/README.md

## 3. Current state

- Branch: multiple commits since 5e9c648; HEAD = `fb0e37d` + uncommitted working tree changes
- Staging: running with `-ValidationStub -WithProwlarr -WithCapacitorOrigins -LanMode`
- PostgreSQL: healthy, 18+ hours of data (Library has test entries — user wants Reset for clean start)
- Prowlarr: live, healthy, but FlareSolverr proxy was `http://localhost:8191/` (wrong — auto-fix added to staging.ps1, needs container restart to take effect)
- TMDB_API_KEY: NOT configured (catalog is stub-backed; user needs to add real key to `.env`)
- playback.compat.v1: **ACTIVE** (FFmpeg configured, capability advertised)

## 4. 🔴 CRITICAL BLOCKER — torrent data not saving to disk

**The video player does not work because the torrent client downloads data from peers but CANNOT write it to the filesystem.**

Backend logs show:
```
error flushing piece storage: FlushFileBuffers: The handle is invalid
error promoting part file: rename ...: Access is denied
```

Every piece fails. The `\\?\` long-path prefix on the torrent data directory (`deploy/desktop-staging/data/torrents/movie/...`) causes Windows file handle issues with the anacrolix/torrent client.

**Root cause**: anacrolix/torrent uses `\\?\D:\...` extended-length paths for the torrent storage. On this Windows setup, `FlushFileBuffers` fails on those handles. The data arrives from the network (peers are connected, pieces received) but never persists.

**Next steps to fix**:
1. Try a SHORTER torrent data path (e.g. `C:\tw-data\` instead of the deep `D:\Projects\movie-watcher\deploy\desktop-staging\data\torrents\` path) — set `TORRENT_DATA_ROOT=C:\tw-data` in `.env`
2. Or disable the `\\?\` long-path prefix in the anacrolix/torrent client config
3. Or run the backend inside Docker (Linux containers don't have this issue)
4. Check if the directory has proper write permissions: `icacls "D:\Projects\movie-watcher\deploy\desktop-staging\data\torrents"`

## 5. What works on the phone

- ✅ App installs and launches (Capacitor 8.5.2 shell)
- ✅ Connects to staging backend via LAN (`http://192.168.1.2:4001`)
- ✅ Connection chip (green dot) shows status
- ✅ Catalog loads (stub titles — needs TMDB_API_KEY for real data)
- ✅ Library sync works (real PostgreSQL)
- ✅ Search page works (new page, not modal)
- ✅ Settings overlay works (dot-only ConnectionChip)
- ❌ **Video playback**: fails because torrent data can't be written to disk (see §4)
- ❌ Episode stills: client calls external APIs (Cinemeta/AniList) directly — needs backend proxying for mobile

## 6. Recently completed

- **Library UX + pull-to-refresh pass (2026-09-14)**: Library tab/sort switches now REPLACE the history entry (`Navigate` gained `{replace}` through router-adapter → navigateHash) — the device back gesture leaves the page instead of replaying tabs (fixes the favourites→watch-later flash + store re-probe ghost loader). "Synced with your TorWatch server" lines removed (stale/offline note kept, only when actually stale); mojibake fixed (`”`→`—`, literal `\u2713`/`\u2039` escapes → real strings, `Title A”Z`→`Title A–Z`). APPLICATION-WIDE PULL-TO-REFRESH (`src/lib/pull-to-refresh.tsx`): touch-only, engages at scroll top, rubber-band spinner; wired into Home (catalog shelves + continue rail cache-bust), See-All (page 1 refetch), Title detail (full reload token), Library overview + category grid. TMDb ISP failures now have a manual recovery path on every page (auto-retry is server-side Gluetun territory, unchanged).
- **Torrent search health ranking (2026-09-14)**: server sorts results by swarm health FIRST (`torrentHealthScore`: log-scaled seeders + seeder/peer ratio) with language as a bounded bonus — a tagged 2-seeder no longer beats a healthy untagged release; dead swarms (seeders 0) dropped when ≥5 alive results exist; dedupe keeps the healthiest duplicate. `TORRENT_LISTEN_PORT` env added (tests use random port — fixes the fixed-port 42069 collision with a running staging backend).

- **M1.4.7 VLC migration review pass (2026-09-14, session 2)**:
  - **Android native compile PASS**: full `assembleDebug` APK with libvlc-all 3.6.2 packaged, built against a real SDK 36 install; every LibVLC API verified via `javap` on the actual AAR (delays are MICROSECONDS; `addSlave(int,String,boolean)` boolean; `interfaces.IMedia$Slave(int,int,String)`; JSArray is org.json-based with its own generic `toList()`).
  - **iOS header-verified**: the pinned MobileVLCKit 3.7.3 archive was downloaded and its SHA256 matched the setup script; delegate methods (`mediaPlayerTimeChanged:`/`mediaPlayerStateChanged:` — notification-style) and `videoSubTitlesNames`/`videoSubTitlesIndexes` (with the "s") confirmed against real headers; misspelled properties fixed; VLCSupport shim retained via a call in MainViewController; actual `xcodebuild` PENDING (needs Mac).
  - **Authoritative control state**: `tracksUpdate` now carries `selectedAudioTrackId`/`selectedSubtitleTrackId` through bridge → controller (optimistic echo + authoritative overwrite, late subscribers get current state) → UI chips; `buffering` events carry the native progress estimate into the loading screen.
  - **UI**: seek bar scrubs locally and commits ONE seek on release (no per-tick seek storm); subtitle sheets keep language selector, retry/error states, upload size checks, timing reset buttons.
  - **Resource bounds**: imported-subtitle retention (7-day expiry + 64 MiB cap, oldest evicted, `TestSubtitleImportRetention`); media-source audit confirmed fresh-reader-per-request + deferred close releases abandoned range readers; sidecar reads stay 4 MiB-bounded; VLC direct sessions spawn no FFmpeg.
  - **Fixed pre-existing test breakage**: Prowlarr search stubs in `contract_torrents_test.go` never served `/api/v1/indexer` (the committed service scopes searches by it) — stubs updated, full httpapi suite green.

- **M1.4.7 VLC playback layer (2026-09-14, CODE COMPLETE — native builds UNVERIFIED)**: MobileVLCKit (iOS) / LibVLC 3.6.2 (Android) render BEHIND the Capacitor WebView; the whole control surface is shared React (`src/mobile/NativePlayerControls.tsx`): poster loading screen, tap controls, seek bar, ±10s, play/pause, subtitle sheet (embedded + torrent + OpenSubtitles + local import via POST /subtitles/import), audio sheet, independent audio/subtitle timing (±0.1s steps), skip-intro chip (server GET /skip-segments — Go port of the desktop TheIntroDB/AniSkip logic). Embedded track selection + runtime subtitle slaves = no playback restart. Server: new `ios-vlc`/`android-vlc` profiles direct-play the ORIGINAL file (embedded tracks preserved); `PLAYBACK_TRANSCODE_MODE=off` (Radxa) refuses auto-transcode (`transcode_disabled`) while keeping ffprobe + remux fallback. Device gates: see `docs/mobile-ui/vlc-playback-verification.md` (iOS XCFramework step, seek-on-incomplete-torrent, subtitle switch, server CPU/RAM sampling).

- M1.4 native-mobile foundation: Capacitor shell, session client, native AVPlayer (Swift) + Media3 (Kotlin) plugins, LAN mode, origin settings, connection chip, search page, flash fix
- M1.3.x playback service: ffprobe inspection, per-indexer Prowlarr search, HLS/fMP4, session lifecycle, pre-buffer fix (2MB before ffprobe)
- Launch screen: breathing logo + staggered reveal
- ConnectionChip: dot-only (green/red)
- Search: full page (not modal) with recent searches + recommendations
- Netflix-style rails: 2.5 posters visible on phone, readable titles
- Error mapper: `src/lib/source-error.ts` strips Prowlarr URLs from user-facing errors
- Native playback UX pass (2026-09-14, needs Xcode build to verify): iOS player + loading screen LANDSCAPE-locked (`supportedInterfaceOrientations` overrides); poster-backed buffering overlay covers the player until AVPlayer reports `.playing` and re-appears during stalls (`.waitingToPlayAtEligibleRate`); poster/title now resolve on mobile too (PlayerPage metadata gate no longer desktop-only); posterUrl crosses the bridge via prepare/play (`native-playback-controller.ts`, `native-player.ts`).

## 7. Key files

- Playback service: `torrent-streamer/internal/playback/` (probe.go, planner.go, source.go, manager.go, torrentsource.go)
- Playback handlers: `torrent-streamer/internal/httpapi/playback_handlers.go`
- Mobile client: `electron-app/src/platform/playback-session-client.ts`, `native-playback-controller.ts`, `native-player.ts`
- iOS plugin: `electron-app/ios/App/App/TorWatchNativePlugin.swift`
- Android plugin: `electron-app/android/app/src/main/java/com/torwatch/mobile/`
- Settings: `electron-app/src/mobile/ServerSettings.tsx`, `settings-overlay-controller.ts`
- Launch screen: `electron-app/src/components/shared/LaunchScreen.tsx`
- Connection chip: `electron-app/src/components/shared/ConnectionChip.tsx`
- Search page: `electron-app/src/pages/SearchPage.tsx`
- Error mapper: `electron-app/src/lib/source-error.ts`
- Staging: `deploy/desktop-staging/staging.ps1` (LanMode, WithCapacitorOrigins, Make-PlaybackFixtures, VerifyPlayback)

## 8. M1.4 child task status

- [x] M1.4.1 FFmpeg staging (SKIP path proven, fixture generator implemented)
- [x] M1.4.2 Capacitor shell (builds, syncs, runs on phone)
- [x] M1.4.3 Shared session client (134/134 tests)
- [ ] M1.4.4 iOS AVPlayer — implementation complete, NEVER compiled (BLOCKED ON MAC/XCODE for actual build; user HAS run it on device via Xcode but the player fails due to §4)
- [ ] M1.4.5 Android Media3 — implementation complete, NEVER compiled (BLOCKED: no Android SDK)
- [x] M1.4.6 Runtime config + security (origin settings, exact Capacitor origins)
- [ ] M1.4.7 Subtitles/progress/lifecycle — iOS native sidecar-VTT subtitle renderer IMPLEMENTED (TorWatchNativePlugin.swift: WebVTT parser + CC picker overlay synced on a 0.25s time observer; works for direct AND HLS sessions; NOT yet compiled/verified on device). Android Media3 sidecar subs still open. Progress+resume works; external OpenSubtitles not wired into native sessions.
- [x] M1.4.8 Builds/checks/docs/evidence

**M1.4 parent: OPEN** — blocked by §4 torrent storage issue + M1.4.4/M1.4.5 compile gates.

## 9. Environment variables (staging .env)

```
STAGING_PG_PASSWORD=...        # required
TMDB_API_KEY=                  # NOT SET — catalog is stub-backed
FFMPEG_PATH=C:\...\ffmpeg.exe  # CONFIGURED — playback.compat.v1 active
FFPROBE_PATH=C:\...\ffprobe.exe
PROWLARR_URL=http://127.0.0.1:9696
PROWLARR_API_KEY=(from data\prowlarr\config.xml)
TORRENT_DATA_ROOT=D:\Projects\movie-watcher\deploy\desktop-staging\data\torrents
TORWATCH_PLAYBACK_FIXTURE_ROOT=  # NOT SET
```

## 10. Exact next steps (priority order)

1. **iOS: `npm run setup:ios-vlc` on the Mac → `cap:open:ios` → xcodebuild** — the only unverified native compile gate; then the device lifecycle matrix in `docs/mobile-ui/vlc-playback-verification.md` (startup/buffering/resume/pause/background/close-during-startup/retry/replacement/rotation)
2. **Android: install APK on device** (`electron-app/android/app/build/outputs/apk/debug/`) and run the same matrix + subtitle end-to-end (OpenSubtitles → download → attach live; local import; rapid switching; close during download)
3. **Verify Radxa env**: `docker exec <container> env | grep PLAYBACK` shows `PLAYBACK_TRANSCODE_MODE=off`; measure server CPU/RAM during direct playback (script in the verification doc); confirm no ffmpeg process spawns
4. **Then Radxa deploy**: same Docker containers, Tailscale Serve HTTPS

## 11. Commands

```powershell
# Staging
cd deploy\desktop-staging
staging.ps1 Stop / Start -ValidationStub -WithProwlarr -WithCapacitorOrigins -LanMode
staging.ps1 Status / Verify / VerifySource / VerifyPlayback / Make-PlaybackFixtures

# Mobile
cd electron-app
npm run mobile:build    # web bundle + cap sync
npm run cap:open:ios    # Xcode (Mac only)
npm run cap:open:android # Android Studio
```
