# HANDOFF — torWatch feature 002 (shared mobile UI + household library)

Fresh-session context handoff. Updated 2026-09-15 (end of session 4). The working tree is COMMITTED on branch `001-torwatch` with the latest code. Read top-to-bottom before touching code.

## 1. Architecture (current)

One shared React UI (electron-app/src/) used by Electron desktop AND mobile via Capacitor 8.5.2. Go BFF (torrent-streamer) owns catalog, library, recommendations, playback sessions, torrent search/resolution, subtitles, skip-segments. Native playback: **MobileVLCKit 3.7.3 (iOS) / LibVLC 3.6.2 (Android)** rendering BEHIND the Capacitor WebView; the whole control surface is shared React (`src/mobile/NativePlayerControls.tsx`). `ios-vlc`/`android-vlc` profiles direct-play the ORIGINAL file (embedded tracks preserved); `PLAYBACK_TRANSCODE_MODE=off` refuses auto-transcode while keeping ffprobe + remux fallback.

## 2. Authoritative documents

1. HANDOFF.md (this file)
2. specs/002-mobile-shared-ui/spec.md · plan.md · tasks.md
3. contracts/playback-api.md · contracts/library-api.md
4. docs/mobile-ui/vlc-playback-verification.md (device matrix + CPU/RAM script)
5. docs/mobile-ui/mobile-build-run.md · deploy/desktop-staging/README.md

## 3. Current state (2026-09-15, end of session 4)

- **Branch `001-torwatch` is COMMITTED with the latest code** (VLC migration, splash, icons, anime fixes all in).
- Staging: running `-WithProwlarr -WithCapacitorOrigins -LanMode`; postgres + prowlarr healthy; `TMDB_API_KEY` configured (live catalog); `OPENSUB_API_KEY` supported via .env; `TORRENT_DATA_ROOT=Z:/Torrent/vod_files`.
- **iPhone: VLC playback INSTALLED and device-tested by the user.** Working: landscape entry before prep, logo buffering loader, seek/±10s double-tap, telemetry panel, Fit/Fill, subtitle sheet (OpenSubtitles + import + embedded + timing), splash → connect flow with the TV icon.
- **Known iPhone issues (OPEN, priority):**
  1. **Skip-intro does not work reliably** — the chip/timestamps need investigation on device (server /skip-segments + chip wiring).
  2. **Subtitle switching mid-playback is inconsistent** — switching tracks/slaves live needs a device-side debug (VLC slave attach + spuTrack selection).
- Android APK builds but is NOT yet installed/verified on a device.
- Radxa deployment + Tailscale Serve: NOT started (next session).

## 4. Player architecture notes (load-bearing)

- The native VLC surface sits at index 0 BEHIND the (transparent) WebView; every control is React. Never paint opaque backgrounds on ancestors during playback (`html.native-playback` rules).
- Orientation is page-level: PlayerPage locks landscape on mount via `setPlaybackOrientation`, unlocks on unmount/failure/retry. `play()` re-locks idempotently.
- Fit/Fill: Android `SURFACE_BEST_FIT/SURFACE_FILL`; iOS `videoCropGeometry` = drawable's reduced "W:H" via a strdup bridge (raw `char *` property — never assign a Swift String), recomputed on orientation change.
- Subtitles: runtime VLC slaves (downloaded to temp files first, failure-reported, cleanup on teardown); embedded tracks via native track ids; delays are MICROSECONDS on both platforms.
- Telemetry: `GET /buffer/info?magnet=&cat=&fileIndex=` (4s poll, only while the stats sheet is open); download speed derived from downloadedBytes deltas.
- Torrent search: per-indexer scoped queries with an UNSCOPED fallback when all fail (a successful-but-empty fallback is a truthful `200, total 0`); health-first ranking (`torrentHealthScore`: log-scaled seeders + ratio, language bonus, and a bounded SOURCE-REPUTATION bonus for renowned indexers — YTS/Nyaa/SubsPlease +12, EZTV/TPB/1337x +8, etc.; see `indexerTrust` in service.go) with `searchBudget` 35s / `indexerBudget` 14s so slow renowned indexers complete — latency is acceptable, completeness is not negotiable. Aliases from TMDb `alternative_titles` (Latin-script filtered) land inside the maxSearches=4 query budget.

## 5. Recently completed (sessions 2-4)

- VLC migration end-to-end (search ranking, alt titles, unscoped fallback, AniList stills fallback, telemetry panel, Fit/Fill, landscape-at-entry, compact sheets, splash + TV brand icons, OPENSUB_API_KEY passthrough, Anime search/stills fixes). Full details in git history of `001-torwatch`.
- Provider egress resilience: ONE bounded retry (400ms backoff) for transient provider failures in `internal/catalog/http.go` (TMDb `providers_unavailable` transients). 404/429 stay authoritative.

## 6. Gaps before v2 release (priority order)

1. **Skip-intro on device** — chip/timestamps do not behave reliably; debug `/skip-segments` data for real episodes + chip wiring on both platforms.
2. **Subtitle switching on device** — live track switching (slaves + spuTrack) is inconsistent; needs device logs (enable `VLCLibrary loggers` temporarily) around the switch moment.
3. **Android on-device pass** — install debug APK, run the matrix in `docs/mobile-ui/vlc-playback-verification.md` (same as iOS).
4. **Radxa deployment (NEXT SESSION FOCUS)**: rebuild Docker image with the new Go code, deploy with `PLAYBACK_TRANSCODE_MODE=off`, verify env inside the container, measure CPU/RAM during direct playback (script in the verification doc), confirm no ffmpeg spawns.
5. **Tailscale Serve HTTPS**: written but never exercised end-to-end; first real use may surface ACL/CLI issues.
6. **Egress routing (Gluetun)**: catalog calls now have a bounded retry; full VPN routing of ALL egress (Prowlarr/TMDb/indexers) through Gluetun is a Radxa-session infra task — decide which endpoints route through it vs direct.
7. **Torrentio-style aggregation (evaluation)**: see §7 — decide whether to add a fast aggregator indexer vs tuning Prowlarr.
8. **Release engineering**: Android release build + signing, versionCode/Name bump, installer with the new icons (untested), PWA manifest icon check, library Reset for a clean household start.

## 7. Torrentio / debrid / FlareSolverr — what they are

- **FlareSolverr** (already deployed, port 8191): a headless-browser proxy that solves Cloudflare challenges for indexers that block plain HTTP clients. Some Prowlarr indexers are configured to use it. If an indexer shows "unavailable", its FlareSolverr path is the usual suspect. It adds latency — that is why scoped searches feel slow before results appear.
- **Torrentio**: a Stremio add-on that aggregates MANY indexers at once and caches/ranks results — very fast because the heavy lifting happens on THEIR servers. We cannot use Torrentio itself inside Prowlarr (it is an add-on, not a Torznab indexer), but the same speed is achievable locally by (a) the existing 3-minute search cache, (b) keeping healthy indexers only, and (c) optionally adding a Torznab-compatible fast aggregator if one is self-hostable.
- **Debrid (Real-Debrid/Premiumize etc.)**: PAID services that instantly serve cached torrents from their own seedboxes. It would bypass our own torrent client entirely — different architecture, ongoing cost, and it defeats the self-hosted Radxa design. Not recommended for v2; our anacrolix client + buffer controller already streams while downloading.

## 8. Environment variables (staging .env)

`STAGING_PG_PASSWORD` (required) · `TMDB_API_KEY` (set) · `OPENSUB_API_KEY` (empty → OpenSubtitles off) · `FFMPEG_PATH`/`FFPROBE_PATH` (set) · `PROWLARR_URL`/`PROWLARR_API_KEY` (from data\prowlarr\config.xml) · `TORRENT_DATA_ROOT=Z:/Torrent/vod_files` · `PLAYBACK_TRANSCODE_MODE` (auto here; compose defaults off for Radxa) · `TAILNET_*` optional

## 9. Commands

```powershell
# Staging
cd deploy\desktop-staging
staging.ps1 Stop / Start -WithProwlarr -WithCapacitorOrigins -LanMode
staging.ps1 Status / Verify / RestartBackend   # RestartBackend does NOT rebuild: build the exe first (go build -o ..\deploy\desktop-staging\build\torwatch-staging.exe ./cmd/vod from torrent-streamer)

# Mobile (ALWAYS mobile:build before an Xcode/Studio build — it runs cap sync)
cd electron-app
npm run mobile:build
npm run cap:open:ios     # Mac; run `npm run setup:ios-vlc` there first
npm run cap:open:android
```
