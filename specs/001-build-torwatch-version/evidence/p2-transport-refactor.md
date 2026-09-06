# P2 Evidence — Client-Neutral Transport Groundwork in Electron (pure refactor)

**Phase**: P2 (plan.md "Client-neutral transport groundwork") | **Date**: 2026-09-04 | **Baseline**: Phase 2 exit (evidence/p1-server-foundation.md)

## Migration map (constitution principle IV)

| Field | Value |
|---|---|
| Old owner | Hardcoded `http://localhost:4001` literals: `src/lib/api-client.ts:3`, `src/lib/services/continue-service.ts:6`, `src/lib/services/resolve-service.ts:4`, `src/components/EpisodePanelWrapper.tsx:105`, `src/pages/HomePage.tsx:133`, `src/player-controls/bridge.ts:46-48` (preview sample URLs), `electron/playback/constants.js:1` (main process), CSP meta in 4 HTML files |
| New owner | `electron-app/backend-origin.mjs` (single default + `resolveBackendOrigin`), surfaced through `src/lib/api-client.ts` (renderer) and `electron/playback/constants.js` (main process, `BACKEND_URL` override) |
| Consumers | Every renderer backend caller; main-process IPC deps (`vodBase`) fed from `main.js` unchanged |
| Compatibility | Default origin byte-identical (`http://localhost:4001`); request paths, headers, bodies, and methods unchanged (diff shows only origin-source changes); `API_BASE` (dead Next.js `localhost:3000`) left untouched — its removal is the P8 gate (T066) |
| Verification | Below |
| Removal gate | Zero remaining hardcoded base URLs — the tasks.md grep gate passes clean (T020) |
| Rollback | `git revert` of the Phase 3 commits restores every literal; no data, no backend changes |

## Design notes

- **Single source of truth**: `backend-origin.mjs` holds the only default-origin definition and a `resolveBackendOrigin(env)` resolver (trims trailing slashes; `BACKEND_URL` beats `VITE_TORWATCH_BACKEND_URL`). It sits at the `electron-app/` root because the Electron main process (plain Node ESM) cannot import the renderer's TS `api-client.ts`; both worlds consume the same module (a `backend-origin.d.ts` covers the TS import).
- **Renderer**: `api-client.ts` resolves at module load from `VITE_TORWATCH_BACKEND_URL` (build-time) and exposes `getVodBase()` / `buildBackendUrl()`.
- **Main process**: `constants.js` resolves from `process.env.BACKEND_URL` — the launch contract (`LISTEN=127.0.0.1:4001` in `runtime-manager.js`) is untouched.
- **CSP (T019)**: the 4 HTML entries replace the `http://localhost:4001` literals with `__TORWATCH_BACKEND_ORIGIN__`; a Vite `transformIndexHtml` plugin injects the configured origin for dev server and build. With no override the built CSP is byte-identical to V1 (verified below). No wildcards introduced; all other restrictions preserved.

## Verification (commands + results)

| Check | Command | Result |
|---|---|---|
| Characterization tests (T017) | `node --test --experimental-strip-types scripts/characterization/api-client.test.mjs` | PASS 5/5 — default byte-identical, override precedence, trailing-slash trim, path joining, legacy `API_BASE` untouched |
| Default/override (main process) | `node -e "import('./electron/playback/constants.js')…"` with and without `BACKEND_URL` | PASS — default `http://localhost:4001`; override `http://host:9911/` → `http://host:9911` |
| Electron suites | `npm test` | PASS — 51/51 (incl. the pre-existing CSP contract test over all 4 raw HTML files) |
| Renderer build | `npx vite build` | PASS — all 4 HTML entries built; zero unreplaced `__TORWATCH_BACKEND_ORIGIN__` tokens; built CSP with defaults is byte-identical to V1 |
| CSP override | `BACKEND_URL=http://192.168.1.50:4001 npx vite build` | PASS — configured origin injected into all 4 built HTML files (then default build restored) |
| **Grep gate (T020)** | `git grep -n "localhost:4001" -- electron-app/src electron-app/electron ":(exclude)**/api-client.ts"` | **CLEAN** (exit 1 = no hits). Cross-checked with a full filesystem scan (`Get-ChildItem -Recurse \| Select-String`) over the same two trees excluding `api-client.ts` — also clean. Note: `rg` is not installed on this host; the two commands above are semantically equivalent to the tasks.md gate (`rg "localhost:4001" electron-app/src electron-app/electron --glob '!**/api-client.ts'`) |
| Full Go suite | `go test ./...`, `go vet ./...` (torrent-streamer) | PASS (exit 0) — backend untouched this phase |
| Encoding integrity | BOM/mojibake scan of all touched files | CLEAN — an intermediate PowerShell string-replace briefly added UTF-8 BOMs and mojibake to `EpisodePanelWrapper.tsx`; it was restored from git and redone with encoding-preserving edits; final diffs verified minimal |

## Unverified checks (recorded, not passed)

- **Manual smoke (launch → search → stream → resume)**: PENDING — interactive Electron + backend + PostgreSQL launch is not available in this session. Automated coverage: npm test (51/51, including the network-routing and player-contract suites that exercise backend call construction), the renderer build, and the default-vs-override origin checks. The smoke must be run by the operator before the Phase 4 exit review.

## Changed files

- New: `electron-app/backend-origin.mjs`, `electron-app/backend-origin.d.ts`, `electron-app/scripts/characterization/api-client.test.mjs`
- T017: `electron-app/src/lib/api-client.ts`
- T018: `src/lib/services/continue-service.ts`, `src/lib/services/resolve-service.ts`, `src/components/EpisodePanelWrapper.tsx`, `src/pages/HomePage.tsx`, `src/player-controls/bridge.ts`, `electron/playback/constants.js`
- T019: `src/index.html`, `src/player-controls.html`, `src/setup.html`, `src/startup.html`, `vite.config.js`
- `package.json` (test chain), `specs/001-build-torwatch-version/tasks.md` (checkboxes)

## Rollback

`git revert` the Phase 3 commits. Every literal is restored; the new modules/files are deleted with the revert; CSP reverts to the hardcoded literals. No backend or data involvement.
