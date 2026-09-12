# Mobile web playback + private tailnet staging — session evidence (2026-09-12)

All results below are from actual runs on the Windows staging machine. Nothing here claims iPhone playback; the physical-device matrix remains open (see the last section).

## Implemented in this phase (working tree, uncommitted)

1. **BrowserPlayer (native HTML5)** — `electron-app/src/platform/browser.ts` + `browser-player-core.ts`: plays the selected torrent through `GET {backendOrigin}/stream?cat=…&magnet=…&fileIndex=…` in a `<video controls playsInline>` overlay with safe-area padding, autoplay fallback ("tap Play"), truthful codec error copy (MKV/unsupported → actionable message, no fake transcode), close/pause/ended controls, heartbeat progress every 10s and bounded resume lookup via `/v1/resume` + `/v1/session/heartbeat` (contract fields verified against `session.go`).
   Session-safety repairs made during review: stream URL attaches BEFORE the bounded resume lookup (no artificial playback delay); a monotonically increasing session token + `finishedSession` guard make stop/ended callbacks exactly-once and immune to route loops; in-flight progress POSTs are bound to the session and aborted on teardown; the compact footer Play path is unchanged.
2. **TorrentPanel** — browser source rows now render a real Play control (Electron keeps the split button). Invalid nested interactive control FIXED: the Play button was inside the row-selection `<button>` (invalid HTML/a11y); the row is now selection-button + sibling Play control. Magnet redaction: console logs that printed torrent rows/route params (which contain the magnet URI) were removed or reduced to titles.
3. **Browser entry** — PlayerPage routed in `browser/main.tsx` with `RouterProvider` (params survive the hash round trip), Continue Watching routes through source selection, mobile PWA metadata in `browser.html` (`media-src` carries the exact baked backend origin), `vite.config.browser.mts` emits `manifest.webmanifest` + icon.
4. **PWA truthfulness** — the original artwork is 1672×941 but the manifest claimed 512×512. A true 512×512 icon is now generated (`src/assets/torwatch-app-icon-512.png`), emitted, and the manifest says `sizes: "512x512", purpose: "any"` (maskable not claimed). Verified in the served `dist-browser`. No service worker / no offline claim — this is an online-only private app.
5. **Staging harness** (`staging.ps1`) — `-TailnetHttp` switch (plain-HTTP tailnet Serve fallback with matching `http://` origins and an HTTP backend origin baked into CSP); Serve mappings attempted BEFORE any process spawns; the CLI hang observed with Serve-not-enabled (1.102.4 hangs on `serve --bg` instead of erroring) is bounded to 25s and treated as "Serve pending" with the enablement URL CONSTRUCTED from `tailscale status --json` Self.ID (verified to match the URL the operator was given); Start then continues LOCAL-ONLY and prints exactly one ACTION REQUIRED line; `Status` repeats it; `StopLeftovers` recovers interrupted startups by stopping only processes whose command lines prove harness ownership; unrelated port holders abort Start with a clear message (never killed).
6. **Mobile browser smoke** — `electron-app/scripts/mobile-browser-smoke.mjs` (see below).

## Automated checks (focused, this session)

- `node --test --experimental-strip-types scripts/characterization/browser-player.test.mjs` → **3/3 PASS**.
- `electron-app\node_modules\.bin\tsc.cmd --noEmit` → **PASS**.
- `node node_modules\vite\bin\vite.js build --config vite.config.browser.mts` → **PASS** (also exercised via `staging.ps1 Start`, which builds with the exact backend origin).
- PowerShell parser check of `staging.ps1` → **OK**.
- `node scripts/mobile-browser-smoke.mjs` (iPhone-sized headless Chromium against the live local staging) → **10/10 PASS**: app loads; manifest link present; title opens; source row renders + selectable; compact footer Play clickable; navigation to PlayerPage; BrowserPlayer native video UI (`controls`, `playsInline`); video src = current backend origin `/stream` with `cat=movie` + `fileIndex` params; Close tears down and returns; no unexpected renderer errors. The torrent-search response is page-intercepted with ONE synthetic row (labelled "Synthetic UI fixture (smoke)") so the click-through runs without a real seeded torrent — a UI-mechanics fixture, NOT provider or playback evidence.

## Live Prowlarr evidence (real, bounded)

`staging.ps1 Start -ValidationStub -WithProwlarr` → backend `/readyz`: `{"postgres":"ok","prowlarr":"ok"}`. `staging.ps1 VerifySource`:
- PASS source search: 5 results, 1 seeded public-domain candidate ("Big Buck Bunny (2008) 720p Bluray nHD x264-NhaNc3", seeders=1) — REAL indexer data via Prowlarr.
- PASS source resolution: playable magnet returned (redacted in output).
- FAIL peer data within 30s — the selected result has a single seeder; the bounded 64 KiB stream probe got no peer data. **Truthful external peer-availability result, not a harness failure.** Real playback remains unproven until a well-seeded source (or this result changes) is available.

## Tailnet status (pending ONE user action)

Tailscale 1.102.4 is installed, running, logged in; the iPhone node is in the tailnet. Serve is NOT yet enabled for the tailnet, and the CLI hangs instead of erroring, so the harness detected the condition, constructed the enablement URL from the node ID, and started LOCAL-ONLY:
`https://login.tailscale.com/f/serve?node=<your-node-id>` (stored in gitignored state.json; printed by Start/Status).
After enabling: `staging.ps1 Stop` → `staging.ps1 Start -ValidationStub -WithProwlarr` → the same Start prints `Tailnet UI` / `Tailnet API` URLs whose scheme always matches the actual Serve listener (HTTPS default; `-TailnetHttp` for plain HTTP). Funnel is never used; nothing is exposed publicly; no firewall changes.

## Evidence labels

- Automated checks above: real local staging backend/frontend.
- Catalog content: DETERMINISTIC-STUB-BACKED (no TMDb key on this machine).
- Torrent search/resolve: REAL (live Prowlarr through saved config).
- Peer streaming: NOT verified (1-seeder timeout; external availability).
- iPhone playback/codec matrix, interruption, safe-area on device: NOT verified — requires the physical iPhone (open M1.3 gate); the browser/PWA path needs no paid Apple Developer account, and native iOS packaging remains the later Mac/Xcode milestone.
