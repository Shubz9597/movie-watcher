# Operator checklist: T020 and T042 interactive verification

For the torWatch owner/operator on a machine with a display, the Electron app, and (for T042) a disposable PostgreSQL. Both checklists cover BOTH effective catalog modes (`renderer` = current default, `bff` = flag-on). Record results in `specs/001-build-torwatch-version/evidence/p2-transport-refactor.md` (T020) and `evidence/p5-flag-verification.md` (T042); tick the task boxes only after the runs pass.

## Preparation (both)

1. From `torrent-streamer`: `go build -o bin/torWatcher.exe ./cmd/vod`.
2. Disposable database (never production data):
   ```powershell
   docker run -d --name torwatch-pg-verify -e POSTGRES_USER=torwatch -e POSTGRES_PASSWORD=verify-only -e POSTGRES_DB=torwatch -p 127.0.0.1:54329:5432 postgres:16-alpine
   ```
3. Backend with your real provider credentials in the environment (do not commit them):
   ```powershell
   $env:PG_DSN = 'postgres://torwatch:verify-only@127.0.0.1:54329/torwatch?sslmode=disable'
   $env:LISTEN = 'localhost:4001'
   $env:TMDB_API_KEY = '<your key>'          # required for bff-mode catalog data
   # $env:PROWLARR_URL / $env:PROWLARR_API_KEY as configured for torrent search
   .\bin\torWatcher.exe
   ```
   Smoke: `GET http://localhost:4001/healthz` → `{"status":"ok"}`; `GET /v1/version` → 200.
   Note: this session verified that TMDb data requires `TMDB_API_KEY`; without it every catalog section degrades (this is the designed behavior, not a bug).
4. Start Electron from `electron-app`: `npm run dev`.

## Mode selection

- Default (renderer): start Electron normally. Confirm `Settings`/config shows `CATALOG_SOURCE=renderer` (or leave unset).
- BFF: set the flag before launch with `$env:TORWATCH_CATALOG_SOURCE='bff'`, or flip `CATALOG_SOURCE` to `bff` in the app config, or (instant, per-session) set `localStorage['mw_catalog_source']='bff'` in the renderer devtools and reload. Rollback = set it back to `renderer`.

## T020 — Phase 3 exit (transport refactor; run in renderer/default mode)

- [ ] `rg "localhost:4001" electron-app/src electron-app/electron --glob '!**/api-client.ts'` returns zero product-code hits.
- [ ] `npm test` (electron-app) green; `go test ./...` green.
- [ ] Launch → window opens with the V1 titlebar/behavior.
- [ ] Search for a movie → results appear (renderer provider path).
- [ ] Open a title → play a source in MPV → audio/video plays.
- [ ] Stop playback; reopen the app → resume position restored (continue watching row/title page).
- [ ] Record date, build, and any deviation in p2-transport-refactor.md; tick T020.

## T042 — Phase 6 exit (dual-flag full journey; run BOTH modes)

Run this exact journey in each mode and record per-mode results:

- [ ] **Search** a movie, a series, and an anime (bf mode exercises `/v2/catalog/search`).
- [ ] **Detail**: title, year, overview, runtime/genres render; for series, the **season list** renders (new `seasons` contract field) and switching seasons loads episodes (multi-season check — verify at least one show with 2+ seasons and one anime).
- [ ] **Continue watching enrichment**: a previously watched item shows title/artwork (bff mode resolves via detail contract).
- [ ] **Source selection**: torrent rows appear; select a source (selection does NOT start playback); Play starts it.
- [ ] **Playback**: MPV starts; seek; subtitles list and load; stop.
- [ ] **Resume**: position persists; second app start resumes; (bff mode) progress heartbeats visible on the backend.
- [ ] Genre/See-All rails: open a genre collection from Search → page scrolls past page 1 (bff `genre`+`page` params).
- [ ] Anime episodes render for a series with 10+ episodes (episode metadata/artwork hydration).
- [ ] Record both modes' results + any regression in p5-flag-verification.md. T042 passes only if BOTH modes complete the journey with zero P1 regressions; then and only then consider T043 (default flip), which additionally needs recorded owner approval of parity divergences V1–V5.

## Teardown

```powershell
Get-Process torWatcher -ErrorAction SilentlyContinue | Stop-Process
docker rm -f torwatch-pg-verify
```

## Known environment facts from the 2026-09-06 sessions (context, not gates)

- Docker-based disposable-DB checks and live `/v2/catalog/*` curl checks were executed successfully on 2026-09-06 (see `evidence/p3-live-curl.md`, `evidence/p7-rollback-drill.md`); what remains open for T034/T062 boxes is operator review of the anime-provider network gap (AniList/Jikan egress was blocked from that host) and the compose-stack-level drill, respectively.
- AniList/Jikan/AniZip/Cinemeta egress was blocked from that host session; anime-detail live data must be spot-checked in the T042 run.
