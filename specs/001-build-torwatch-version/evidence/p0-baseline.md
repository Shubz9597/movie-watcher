# P0 Baseline Evidence — TorWatch V2 Characterization

**Phase**: P0 (plan.md "Baseline and characterization") | **Date**: 2026-09-04 | **Baseline commit**: `bd11a90a6f3c207392bdadd0c89377dcf240752f`

## 1. Baseline suite results (before any behavior change)

| Check | Command | Result |
|---|---|---|
| Go tests | `go test ./...` (torrent-streamer) | PASS — exit 0; `ok` for buffer, config, httpapi, imdb, logx, search, subtitles, torrentx; no test files: cmd/imdb-import, cmd/vod, internal/janitor, internal/middleware, internal/scoring, internal/watch, migrations, pkg/types |
| Go vet | `go vet ./...` | PASS — exit 0, no output |
| Electron tests | `npm test` (electron-app) | PASS — exit 0; 27/27 tests (skip-segments 8, diagnostics 4, player-contracts 9, network-routing 6) |
| Compose config | `docker compose config` (repo root) | PASS — exit 0, renders `movie-watcher` stack |

Notes:

- `electron-app` had no `node_modules` in the working tree; dependencies were installed with `npm ci` (433 packages, lockfile-respected) to run the baseline suite. No tracked files changed.
- Unrelated working-tree state preserved untouched: modified `README.md`; untracked `.agents/`, `.opencode/`, `.specify/`, `docs/v2-server-package/`, `specs/`.
- No pre-existing test failures found; nothing hidden.

## 2. Route inventory (grep evidence, `git grep` over `electron-app/src` + `electron-app/electron`)

### Live routes (in-repo consumers found)

| Route | Consumer evidence |
|---|---|
| `/healthz` | Electron launch contract waits on it (`v1-compat.md` §Client launch contract) |
| `/stream`, `/files` | playback/resolve flows (`src/lib/services/resolve-service.ts`, player code) |
| `/subtitles/list`, `/subtitles/torrent`, `/subtitles/external` | `src/player-controls/bridge.ts`, subtitle services |
| `/subtitles/configure` | **`electron/ipc/setup-ipc.js:166`** — see §4 discrepancy D-1 |
| `/v1/torrents/search`, `/v1/torrents/resolve` | `src/lib/services/resolve-service.ts` |
| `/v1/imdb/ratings/{ttID}` | rating display flow |
| `/v1/session/heartbeat`, `/v1/resume`, `/v1/resume/source`, `/v1/continue`, `/v1/continue/dismiss` | `src/lib/services/continue-service.ts`, `HomePage.tsx:133`, player progress flow |
| `/buffer/state`, `/buffer/info` | buffer telemetry polling (1 s JSON) |

### Dormant routes (zero in-repo consumers found — grep patterns `/add`, `/prefetch`, `/stats`, `/watch/`, `session/start`, `session/ended`, `resume/source/probe`, `resume.m3u` returned no hits in product code)

`/add`, `/prefetch`, `/stats`, `/v1/session/start`, `/v1/session/ended`, `/v1/resume/source/probe`, `/v1/resume.m3u`, `/watch/open`, `/watch/ping`, `/watch/close`

Per plan P0 these are preserved unchanged until each gets an explicit removal gate.

### Hardcoded backend origin call sites (P2 refactor scope, for the record)

- `electron-app/electron/playback/constants.js:1` (`VOD_BASE`)
- `electron-app/src/lib/api-client.ts:3` (`VOD_BASE`)
- `electron-app/src/lib/services/continue-service.ts:6`, `resolve-service.ts:4`
- `electron-app/src/components/EpisodePanelWrapper.tsx:105`, `src/pages/HomePage.tsx:133`
- `electron-app/src/player-controls/bridge.ts:46-48` (sample track URLs)
- CSP meta tags: `src/index.html`, `src/player-controls.html`, `src/setup.html`, `src/startup.html` (4 files)

## 3. Characterization tests added (Phase 1, no behavior change)

| Task | File | Captures |
|---|---|---|
| T002 | `torrent-streamer/internal/httpapi/contract_torrents_test.go` | `/v1/torrents/search` (POST-only, `kind`+`title` body contract, DisallowUnknownFields, `query` echo + `total` + `results[]` with opaque `sourceId`, seeder-descending order), `/v1/torrents/resolve` (magnet/infoHash direct resolve, unknown `sourceId` → 502), `/v1/imdb/ratings/{id}` (200 `{imdbId,rating,votes}`, 404, 400 invalid id, 405) |
| T003 | `torrent-streamer/internal/httpapi/contract_stream_test.go` | `/stream` + `/files` error shapes (400 missing/invalid src, 504 metadata timeout with tiny `WAIT_METADATA_MS`), full byte-range parser behavior (`parseByteRange`: open-ended, suffix, clamp, multi-range reject, invalid → the 416 path), probe-range rule |
| T004 | `torrent-streamer/internal/httpapi/contract_subtitles_test.go` | `/subtitles/configure` (POST shape, 400 invalid key, 405), `/subtitles/external` (400 unsupported source, 400 missing id, 503 key not configured), `/subtitles/torrent` (400 src/fileIndex, 504 metadata timeout), `/subtitles/list` degraded shape (`source:"none"`, `providerConfigured:false`, message) |
| T005 | `torrent-streamer/internal/httpapi/contract_session_test.go` | Heartbeat/resume/continue validation + method contracts (405 + `Allow` headers, `bad json`, required-field 400s, `nextSeason`/`nextEpisode` pairing rules), M3U 400 path, session start/ended `bad json` |
| T006 | `torrent-streamer/internal/httpapi/contract_buffer_test.go` | `/buffer/state` (400 state enum, magnet-parse 400s, stop → `{"ok":true,"state":"stopped"}`), `/buffer/info` JSON fallback `{"targetBytes":0,"contiguousAhead":0}` and SSE form (`retry: 2000` + one `data:` tick), `wantsSSE` |
| T007 | `torrent-streamer/internal/httpapi/contract_dormant_test.go`, `torrent-streamer/cmd/vod/healthz_characterization_test.go` | `/watch/open|ping|close` via `watch.NewManager` (32-hex `leaseId`, shared multiple leases per key, 404/400/204 semantics, `ensure failed` → 502, body-fileIndex quirk), dormant `/add`, `/prefetch`, `/stats` shape keys, `/v1/resume.m3u`, `/v1/resume/source/probe`, `/v1/session/start|ended`; `/healthz` byte-exact `{"status":"ok"}` body literal |
| T008 | `electron-app/scripts/characterization/catalog-merge.test.mjs`, `anime-matching.test.mjs` (+ package.json `test:characterization`) | Renderer aggregation logic on fixed provider fixtures: `isTmdbAnime`, `normalizeAnimeTitle`, `selectAniListCatalog` (dedupe/limit/order), `adapters/media.ts` card/detail transforms, `matchesEpisode`, `detectSeasonPack`, `seasonPackContainsEpisode`, `pickFileIndexForEpisode`, `pad` |

## 4. Findings / limitations recorded at baseline

- **D-1 (RESOLVED 2026-09-04, Phase 2 pre-implementation reconciliation)**: plan.md P0 and research R2 initially classified `/subtitles/configure` as dormant ("no in-repo consumers"). Grep found a live consumer: `electron-app/electron/ipc/setup-ipc.js:166` posts to it. Per constitution principle IV this was recorded explicitly; the discrepancy is now corrected in plan.md, research.md, contracts/v1-compat.md, and tasks.md (T007): `/subtitles/configure` is **live** and is characterized with the other subtitle routes (T004). No code changed for this correction.
- DB-backed happy paths (`SaveProgressUpdate`, `GetResume`, `ListContinue`, `EnsurePick`, `/healthz` success/503 branch) require PostgreSQL; they are captured at the validation/shape level here and via live verification in later phase gates (P1 manual `/healthz` byte-compare, P7 migration tests). The `/healthz` handler is an inline closure in `cmd/vod/main.go:96-109`; its 200 body is locked by a source-literal test (`healthz_characterization_test.go`) because extracting it would be a (behavior-preserving) code change outside P0's no-change scope.
- Real 206/416 stream responses require torrent metadata (live peers); the range semantics that drive them are locked unit-level via `parseByteRange`/`isProbeRange`, and the 504-no-peers route path is locked. Full-range route capture is deferred to disposable-stack integration checks.
- OpenSubtitles 429/`Retry-After` handling (`subtitle_handlers.go:343-357`) requires a reachable OpenSubtitles endpoint (base URL not injectable); captured by code reference here, to be exercised in integration checks.
- Tests run with `TORRENT_DATA_ROOT` pointed at a temp dir and `WAIT_METADATA_MS=150` (TestMain in `contract_main_test.go`) so no test writes into the repo or waits 25 s for peers; production defaults are unchanged (env is only set inside `go test`).

## 5. Phase exit gate (T009)

See §6 appended after the exit run.

## 6. Exit-gate results (appended by T009)

Phase exit run on 2026-09-04, after adding the characterization tests (no application-code changes):

| Check | Command | Result |
|---|---|---|
| Go tests | `go test ./...` (torrent-streamer) | PASS — exit 0; all previously-passing packages still `ok`; new suites green: `internal/httpapi` (contract tests incl. characterization), `cmd/vod` (healthz body lock) |
| Go vet | `go vet ./...` | PASS — exit 0 |
| Electron tests | `npm test` (electron-app) | PASS — exit 0; 46/46 tests (27 pre-existing + 19 new characterization) |
| Compose config | `docker compose config` (repo root) | PASS — exit 0 |

Phase 1 exit gate: **PASS** — characterization tests green, baseline behavior locked, zero behavior changes, no pre-existing failures hidden. Rollback for the whole phase: delete the added test/evidence files and revert the `electron-app/package.json` test-script change.
