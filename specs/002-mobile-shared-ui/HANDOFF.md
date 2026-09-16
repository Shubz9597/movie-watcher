# HANDOFF — torWatch v2 (full-stack media server)

Fresh-session context handoff. Updated 2026-09-16 (end of session 5). Branch `001-torwatch` is COMMITTED with all code. The **PRODUCTION Docker stack is RUNNING on this machine** (not staging). Read top-to-bottom before touching code.

## 1. Architecture (current)

One shared React UI (electron-app/src/) used by Electron desktop AND mobile via Capacitor 8.5.2. Go BFF (torrent-streamer) owns catalog, library, recommendations, playback sessions, torrent search/resolution, subtitles, skip-segments, taste engine. Native playback: **MobileVLCKit 3.7.3 (iOS) / LibVLC 3.6.2 (Android)** rendering BEHIND the Capacitor WebView; the whole control surface is shared React (`src/mobile/NativePlayerControls.tsx`). `ios-vlc`/`android-vlc` profiles direct-play the ORIGINAL file; `PLAYBACK_TRANSCODE_MODE=off` refuses auto-transcode while keeping ffprobe + remux fallback.

**Production stack** (deploy/torwatch-server/compose.yaml): Gluetun VPN (Mullvad WireGuard, Switzerland) → Prowlarr + FlareSolverr route through it via `network_mode: service:gluetun`; PostgreSQL + vod backend on the internal network; Caddy gateway on :8080. Container names are the default service names (`postgres`, `prowlarr`, `gluetun`, `flaresolverr`, `caddy`, `torwatch-vod`).

## 2. Authoritative documents

1. HANDOFF.md (this file)
2. specs/002-mobile-shared-ui/spec.md · plan.md · tasks.md
3. contracts/playback-api.md · contracts/library-api.md
4. docs/mobile-ui/vlc-playback-verification.md (device matrix + CPU/RAM script)
5. deploy/torwatch-server/.env.example (all config slots documented)

## 3. Current state (2026-09-16)

- **Branch `001-torwatch`**: all code committed, working tree clean.
- **PRODUCTION stack RUNNING** (Docker Compose from `deploy/torwatch-server/`): all 6 containers up — gluetun (VPN tunnel to Mullvad Switzerland), postgres (healthy), prowlarr (5 indexers active), flaresolverr, torwatch-vod (backend), caddy (gateway on :8080).
- **iPhone: VLC playback device-tested.** Working: landscape entry, logo buffering loader, seek/±10s double-tap, telemetry panel, Fit/Fill, subtitle sheet, pinch-resizable web overlay for loaded tracks, splash → connect flow with TV icon.
- **Known iPhone issues (OPEN):**
  1. **Skip-intro** — chip/timestamps need device testing; anime episodes now work server-side so this is testable.
  2. **Subtitle switching mid-playback** — re-verify with latest build (web overlay replaced VLC slaves for sheet-loaded tracks, which may have fixed it).
  3. **Subtitle font size for embedded tracks** — fixed at `sub-text-scale=75`; not pinch-resizable (VLC limitation). Web overlay IS pinch-resizable.
- **Android APK builds but NOT installed/verified on device.**
- **Tailscale Serve: NOT tested.**
- **Radxa deployment: NOT started** (next session).

## 4. Player architecture notes (load-bearing)

- Native VLC surface at index 0 BEHIND the transparent WebView; every control is React (`html.native-playback` transparency rules).
- Orientation: PlayerPage locks landscape on mount via `setPlaybackOrientation`, unlocks on unmount/failure/retry.
- Fit/Fill: Android `SURFACE_BEST_FIT/SURFACE_FILL`; iOS `videoCropGeometry` = drawable's reduced "W:H" via a strdup bridge (raw `char *` property — never assign a Swift String), recomputed on orientation change.
- **Subtitles**: sheet-loaded tracks (OpenSubtitles/sidecars/imports) render as a **web overlay** (`src/lib/subtitle-parser.ts` parses VTT/SRT/ASS, pinning to `subscribeTime` for cue sync) — pinch-resizable, size persisted per device. Embedded tracks stay VLC-rendered at `sub-text-scale=75`. Choosing one type always clears the other. Initial session sidecars are NOT auto-attached as VLC slaves (removed to prevent double-render).
- **Engine recreation**: `setSubtitleScale` / `setVideoScale` recreate the native engine at the current position (~1s hiccup) — used for embedded sub size changes. Both private-library player and shared-library logger paths exist; the shared-library diagnostic logging is retired.
- Telemetry: `GET /buffer/info?magnet=&cat=&fileIndex=` (4s poll, only while stats sheet open); speed from downloadedBytes deltas.
- Torrent search: per-indexer scoped queries with UNSCOPED fallback (successful-but-empty fallback = truthful `200, total 0`); health-first ranking (`torrentHealthScore`: log-scaled seeders + ratio + language bonus + source reputation bonus for YTS/Nyaa/SubsPlease etc.); `maxSearches=10` (all indexers concurrent), `searchBudget=90s`, `indexerBudget=30s` (VPN latency headroom). Aliases from TMDb `alternative_titles` (Latin-script filtered) and AniList romaji/synonyms.

## 5. Taste engine (v2 recommendations)

- `internal/taste/taste.go`: household-wide signals from (1) library favourites +5, (2) Watch Later +3, (3) watched ≥50% +4 / started +2, (4) opened titles +1 (from `taste_events` table, migration 008). Completed ≥90% → exclusion set. Subject is dedup only, never a profile key.
- Scoring: candidates score against the WEIGHTED genre map (sum of profile weights per genre), replacing binary seed points. Reasons per contributing signal ("Because you favourited/watched/opened X").
- Candidate pool: per-seed TMDb recommendations for `tmdb:` seeds + AniList `Media.recommendations` for `anilist:` seeds, ranked ahead of the global weekly trending pool. `CandidatePoolVersion=2`.
- Fresh deployment: empty signals → popular fallback → hydrates automatically from usage.

## 6. Gaps before v2 release

1. **Skip-intro on device** — testable now (anime episodes work server-side).
2. **Subtitle switching on device** — may be fixed by the web overlay change; re-test.
3. **Android on-device pass** — debug APK builds, never installed.
4. **Radxa deployment** — compose is ready; just move to the Radxa, `docker compose up -d`, verify env + CPU/RAM.
5. **Tailscale Serve HTTPS** — never exercised.
6. **Release engineering** — Android release build + signing, versionCode/Name, installer with new icons, PWA manifest.
7. **Prowlarr EZTV** — API bootstrap failed (missing required field); add manually via Prowlarr UI if needed.

## 7. Production environment (deploy/torwatch-server/.env)

`TORWATCH_IMAGE=torwatch-server:1.0.0` · `TORWATCH_VERSION=1.0.0` · `POSTGRES_USER/PASSWORD/DB` · `PROWLARR_API_KEY` (synced from Prowlarr's generated key — see below) · `VPN_SERVICE_PROVIDER=mullvad` · `VPN_TYPE=wireguard` · `WIREGUARD_PRIVATE_KEY` · `WIREGUARD_ADDRESSES` · `VPN_SERVER_COUNTRIES=Switzerland` · `TMDB_API_KEY` · `OPENSUB_API_KEY` · `GATEWAY_PORT=8080`

**Prowlarr API key sync**: Prowlarr generates its own key on first boot. Read it via `docker exec prowlarr cat /config/config.xml`, then update `.env` with that key and `docker compose up -d vod` to restart the backend with the correct key.

## 8. Commands

```powershell
# Production stack (Docker)
cd deploy\torwatch-server
docker compose up -d
docker compose ps / logs / down

# Rebuild the vod image after Go code changes
cd D:\Projects\movie-watcher
docker build -f deploy/torwatch-server/Dockerfile -t torwatch-server:1.0.0 --build-arg TORWATCH_VERSION=1.0.0 .
cd deploy\torwatch-server
docker compose up -d vod

# Mobile (ALWAYS mobile:build before an Xcode/Studio build — it runs cap sync)
cd electron-app
npm run mobile:build
npm run cap:open:ios     # Mac; run `npm run setup:ios-vlc` there first
npm run cap:open:android

# Staging (separate — uses staging.ps1, NOT the prod compose)
cd deploy\desktop-staging
staging.ps1 Stop / Start / Status / Verify / RestartBackend
```

## 9. Verification results (2026-09-16, production stack)

- ✅ All 6 containers up (gluetun VPN tunnel confirmed, Mullvad Switzerland exit IP)
- ✅ readyz: postgres ok, prowlarr ok
- ✅ Episodes: 38 for Frieren S1, all with stills (server-side TMDb)
- ✅ Torrents: 50 results for Frieren (Nyaa.si 167-seeder first, health-ranked)
- ✅ Library favourite write: 200 (tmdb:tv:209867)
- ✅ Taste visited ping: ok:true
- ⚠️ Recommendations: 0 items (fresh DB — hydrates as you use the app)
- ⚠️ Catalog search: transient TMDb flakiness (bounded retry added; pull-to-refresh as manual recovery)
