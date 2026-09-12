# torWatch Windows desktop staging (temporary Radxa/homeserver substitute)

A private, repeatable Windows staging environment: real production browser build + real Go backend from the working tree + an isolated staging PostgreSQL, optionally reachable from your phone via **Tailscale Serve** (private tailnet only — **Funnel is never used**).

> This is a desktop simulation. It is **not** Radxa/ARM64 evidence and does not complete any native playback, iPhone, Android, or release gate.

## Prerequisites

- Docker Desktop running (staging PostgreSQL; optional existing Prowlarr/FlareSolverr for live source checks).
- Go (same version as `torrent-streamer/go.mod`) to build the backend from the working tree.
- Node.js 20+ with `electron-app/node_modules` installed (`npm ci` once — the harness never runs npm install).
- Optional: Tailscale installed, running, and logged in (`tailscale status` works), with MagicDNS enabled.
- Optional: a TMDb API key for live catalog. Without it, run `-ValidationStub` for deterministic provider evidence.

## One-time setup

```powershell
cd deploy\desktop-staging
Copy-Item .env.example .env
# Edit .env: set STAGING_PG_PASSWORD (throwaway), optionally TMDB_API_KEY.
```

## Start / status / stop / reset

```powershell
powershell -ExecutionPolicy Bypass -File staging.ps1 Start            # local-only staging
powershell -ExecutionPolicy Bypass -File staging.ps1 Start -ValidationStub   # + deterministic provider stub (validation only)
powershell -ExecutionPolicy Bypass -File staging.ps1 Start -ValidationStub -WithProwlarr # stub catalog + live torrent sources
powershell -ExecutionPolicy Bypass -File staging.ps1 Status
powershell -ExecutionPolicy Bypass -File staging.ps1 Verify
powershell -ExecutionPolicy Bypass -File staging.ps1 VerifyAfterRestart
powershell -ExecutionPolicy Bypass -File staging.ps1 VerifySource       # focused live source + 64 KiB stream check
powershell -ExecutionPolicy Bypass -File staging.ps1 Stop             # preserves staging data
powershell -ExecutionPolicy Bypass -File staging.ps1 Reset            # WIPES staging data (explicit only; -Force skips prompt)
```

With Tailscale (installed + logged in): omit `-NoTailscale`. The harness verifies the installed `tailscale serve` syntax, creates two **private** Serve mappings (frontend + backend), and rebuilds the browser bundle with the exact tailnet backend origin so phone and desktop both work. `-NoTailscale` runs purely local.

## Open the UI

- Local: the Start output prints `Local UI` (default `http://127.0.0.1:4174/browser.html`). This is the **production browser build** (CSP carries the exact backend origin) — not fixture mode.
- Fixture mode never runs here. If you need fixtures for design work use `run-mobile-preview.ps1` (development entry), not staging.

## Open from an iPhone / another tailnet device

1. Join the device to the same tailnet.
2. After `Start` (without `-NoTailscale`), the output prints `Tailnet UI` (placeholder: `https://<your-node>.<tailnet>.ts.net/browser.html`).
3. Open that URL on the phone. The backend is reached through the second private Serve mapping (placeholder: `https://<your-node>.<tailnet>.ts.net:8443`).
4. The phone never needs localhost; the backend stays bound to 127.0.0.1 and is proxied by Tailscale Serve.

## Verify readiness and version

```powershell
# Backend (local)
curl http://127.0.0.1:4001/readyz
curl http://127.0.0.1:4001/v1/version
# Expect capabilities to include library.household.v1 and recommendations.basic.v1
```

## Fixture vs production mode

- Production staging: the URL has **no** `fixtures=` parameter. The Library writes to the server; Health/ready endpoints respond.
- Fixture mode: any URL with `fixtures=` in the query is the dev-only preview (labelled "Preview data" in-app). It never runs in staging.

## Automated validation

```powershell
powershell -ExecutionPolicy Bypass -File staging.ps1 Verify
# Restarts only the Go backend and then proves staged data survived:
powershell -ExecutionPolicy Bypass -File staging.ps1 VerifyAfterRestart
```

Run these as separate commands. Do not pipe them through `Select-Object -First`;
the browser checks intentionally run for roughly 15–35 seconds and print their
own bounded progress and final pass/fail summary.

Covers readiness/capabilities, catalog + title detail, Library write/read/remove/reconcile, recommendations, pagination, two-browser-context cross-client sync (≤20s), origin-switch clearing.

`VerifySource` is intentionally separate and fast-bounded. Start the repository's existing source services first with `docker compose up -d flaresolverr prowlarr`, then start staging with `-WithProwlarr`. The harness reads the saved API key from the gitignored `data/prowlarr/config.xml` without printing or copying it. It searches only for the redistributable Big Buck Bunny test film, resolves the source, and requests a 64 KiB byte range with a 30-second peer-data cap. A timeout means the external torrent peer was unavailable; it is not converted into a pass.

## Troubleshooting

- **CORS errors in the browser console**: the frontend origin must exactly match `TORWATCH_ALLOWED_CLIENT_ORIGINS` the backend was started with (the harness sets this from the same origin it built the bundle with). No wildcard is ever accepted.
- **CSP connect-src violations**: the browser bundle bakes ONE exact backend origin at build time. If you changed ports/tailnet origin, re-run `Start` (it rebuilds the bundle). Never relax the CSP.
- **Tailscale ACL errors**: the device must be allowed to reach itself over HTTPS (`tailscale serve` requires the node's own MagicDNS certificate). Check `tailscale status`, enable MagicDNS in the admin console, and confirm ACLs allow the device.
- **MagicDNS name empty**: enable MagicDNS or set `TAILNET_ORIGIN=https://<your-node>.<tailnet>.ts.net` in `.env`.
- **Catalog degraded / library write 404 title_not_found**: no provider credential. Re-run Start with `-ValidationStub` (stub-backed evidence) or set `TMDB_API_KEY` in `.env`.
- **Port already in use**: change `BACKEND_PORT`/`FRONTEND_PORT`/`STAGING_PG_PORT` in `.env` and re-run Start.

## Warnings

- **Browser playback is intentionally unavailable** pending M1.3/M1.4 (real-device transport/player validation). The UI will not start streams here.
- **This is not Radxa/ARM64 evidence.** It validates cross-client behavior, contracts, and persistence on x64 Windows only.
- The validation stub is for automated checks only; do not use it for "does real TMDb work" claims.

## Regression test for the staging frontend server

`powershell
node --test deploy/desktop-staging/serve-browser.test.mjs   # from the repository root
`

Covers path-traversal rejection, SPA-shell semantics, and truthful 404s for missing assets (added 2026-09-11 after the traversal-boundary repair).

## M0.2 desktop smoke (automated surrogate)

`powershell
powershell -ExecutionPolicy Bypass -File m02-smoke.ps1            # builds renderer + runs smoke
powershell -ExecutionPolicy Bypass -File m02-smoke.ps1 -SkipBuild # reuse existing dist
`

Starts a DEDICATED backend on 127.0.0.1:4002 + provider stub on 127.0.0.1:4498 sharing the staging PostgreSQL (persistent data preserved; nothing is wiped), then drives a REAL Electron window through Home/search/title/Library/restart checks. Stops only the processes it started. Catalog evidence is STUB-BACKED; playback is not exercised (M1.3/M1.4). Screenshots land in electron-app\release\m02\ (copies in specs/002-mobile-shared-ui/evidence/captures/m02-*).

## Live source discovery (-WithProwlarr)

`powershell
powershell -ExecutionPolicy Bypass -File staging.ps1 Start -ValidationStub -WithProwlarr
powershell -ExecutionPolicy Bypass -File staging.ps1 VerifySource
`

- Requires the repository Prowlarr stack: docker compose up -d flaresolverr prowlarr (root compose; containers 	orwatch-prowlarr, 	orwatch-flaresolverr).
- The Prowlarr API key is read privately from data\prowlarr\config.xml; it is never printed, logged, or written to state.json.
- Catalog metadata stays deterministic-stub (no TMDb key); torrent search/resolve is LIVE against your indexers.
- VerifySource is bounded: search -> resolve -> a 64 KiB peer-data probe with a 30s cap. A timeout there is a truthful external peer-availability result, NOT a harness failure.

## iPhone via private Tailscale Serve

The harness uses ONLY 	ailscale serve (never funnel) and never changes your account. If Serve is not yet enabled for the tailnet, Start prints one yellow ACTION REQUIRED line and continues LOCAL-ONLY; Status repeats it.

1. One-time: open the enablement URL printed by Start/Status (placeholder: https://login.tailscale.com/f/serve?node=<your-node-id>).
2. staging.ps1 Stop, then staging.ps1 Start -ValidationStub -WithProwlarr again (same terminal conventions).
3. On the iPhone (Tailscale app ON, same tailnet), open the printed Tailnet UI URL + /browser.html.
   - HTTPS mode (default): https://<node>.<tailnet>.ts.net/browser.html with the backend on :8443.
   - Plain-HTTP mode (-TailnetHttp): http://<node>.<tailnet>.ts.net:<port>/browser.html — the URL scheme ALWAYS matches the actual listener.
4. Add to Home Screen for standalone metadata (online-only; no offline/service-worker claims).

If startup is interrupted (Ctrl-C during builds/Serve setup): staging.ps1 StopLeftovers stops only processes provably owned by this harness, then Start again.

## Playback compatibility service (playback.compat.v1)

The backend advertises playback.compat.v1 ONLY when both FFmpeg tools verify. To enable on staging:

1. Place (or point to) ffmpeg/ffprobe and set in .env: FFMPEG_PATH=..., FFPROBE_PATH=....
2. Optional deterministic evidence without torrent peers: set TORWATCH_PLAYBACK_FIXTURE_ROOT to a directory containing generated media named <40-hex>.mp4/.mkv/.srt (e.g. 1111111111111111111111111111111111111111.mp4, 2222…2222.mkv + .srt, 3333…3333.mp4 with an incompatible codec).
3. staging.ps1 Stop then Start again; /v1/version gains playback.compat.v1.
4. powershell -ExecutionPolicy Bypass -File staging.ps1 VerifyPlayback runs the 9 deterministic checks (direct/remux/transcode plans, master playlist, segment MIME, VTT, DELETE/cleanup, secrets-absent). When the capability is absent the verifier reports a truthful SKIP — that is never recorded as a pass.

Bounds: one active conversion by default (PLAYBACK_MAX_TRANSCODES), transcode height capped (PLAYBACK_MAX_TRANSCODE_HEIGHT, default 1080), session TTL (PLAYBACK_SESSION_TTL, default 2h). Session data lives under PLAYBACK_DATA_ROOT (default <TORRENT_DATA_ROOT>/playback-sessions) and only the deleted session's own directory is ever removed.

## Playback fixtures (deterministic, no peers)

`powershell
powershell -ExecutionPolicy Bypass -File staging.ps1 Make-PlaybackFixtures
`

Generates tiny synthetic fixtures (direct MP4, MKV for remux, incompatible-codec MP4, SRT/WebVTT/ASS) under the ignored data\playback-fixtures\ using the CONFIGURED FFmpeg. With FFMPEG_PATH/FFPROBE_PATH + TORWATCH_PLAYBACK_FIXTURE_ROOT configured, VerifyPlayback upgrades from a truthful SKIP to 9 deterministic PASS checks.

## Mobile origins

Start -WithCapacitorOrigins adds the exact Capacitor web origins (capacitor://localhost, https://localhost) to the backend CORS allowlist so the native shell can talk to this staging backend. No wildcard is ever used. See docs/mobile-ui/mobile-build-run.md for the full mobile guide.
