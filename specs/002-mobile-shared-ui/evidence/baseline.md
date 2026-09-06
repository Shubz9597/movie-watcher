# M0.1 baseline — shared mobile alpha

Recorded: 2026-09-06 by the OpenCode session executing OPENCODE-CONTINUE.md. Working tree preserved: no reset, clean, force-checkout, or wholesale commit was performed.

## Revision and branch

- Branch: `001-build-torwatch-version`
- HEAD: `bd11a90a6f3c207392bdadd0c89377dcf240752f` ("fixed the missing file and installer issue")
- The working tree carries substantial uncommitted feature 001 work (modified Electron/Go sources plus untracked BFF implementation, contracts, specs, docs). HEAD alone does not describe the implemented state.

## Pre-existing dirty/untracked work (classification)

- **Feature 001 implementation (preserve, in progress):** modified `electron-app/src/**` (api-client, services, pages), `electron-app/electron/**`, `torrent-streamer/internal/**` (catalog, httpapi contract tests, watch ordered progress), untracked `torrent-streamer/internal/catalog/`, migrations 005/006, `deploy/`, `specs/`, `docs/mobile-ui/`, `.specify/`, `.opencode/`, `.agents/`.
- **This session's additions (feature 001 T042.x):** server seasons/genre/paged sections (`internal/catalog/types.go`, `tmdb.go`, `anilist.go`, `service.go`, `httpapi/catalog_handlers.go` + tests), client bff/gateway/adapter extensions, TitlePage/PlayerPage/continue-service/SeeAllPage flag migrations, evidence files (`p5-bff-gap-audit.md`, `p3-live-curl.md`, `p7-rollback-drill.md` update, `p8-removals.md`), child tasks in the feature 001 ledger.
- No secrets encountered in the audited files; the drill DSN password is a throwaway local value recorded only in disposable evidence.

## Baseline verification results (this session, with this session's T042.x changes included)

| Check | Directory | Command | Result |
|---|---|---|---|
| Backend suite | `torrent-streamer` | `go test -p 1 ./...` | PASS (exit 0); DB-gated migration/progress suites PASS against a disposable PostgreSQL (`TORWATCH_TEST_PG_DSN`, `-p 1 -count=1 -v ./migrations/ ./internal/watch/` all green incl. 005+006) |
| Backend vet | `torrent-streamer` | `go vet ./...` | PASS (exit 0) |
| Renderer tests | `electron-app` | `npm test` | PASS, 70/70 (8+4+9+6+43) |
| Renderer build | `electron-app` | `npm run build:renderer` | PASS (exit 0); the pre-existing `INEFFECTIVE_DYNAMIC_IMPORT` warnings for tmdb/anilist services are GONE after the T042.x lazy-import migration |
| Renderer build (pre-change baseline) | `electron-app` | `npm run build:renderer` | PASS with the two warnings (recorded in p5-bff-gap-audit.md) |

## Feature 001 contract/release evidence state (consumed, not rerun)

- `evidence/p0-baseline.md` through `p7-report.md` exist; T020, T034, T042, T043, T044, T050, T059–T064, T065–T069 remain open per the ledger.
- This session added live-stack evidence: `p3-live-curl.md` (T034 live portion; anime-provider egress blocked on this host), `p7-rollback-drill.md` (T062 drill incl. migration 006, pre-005 binary, backup/restore).
- Default `catalogSource` remains `renderer` (`electron-app/electron/config/app-config-store.js`, `src/lib/catalog-source.ts`) — T043 not implemented; do not describe the default as BFF.

## Known pre-existing failures / limits

- No test failures observed. Renderer build previously warned about static/dynamic import overlap (fixed this session) and Browserslist data age (untouched, cosmetic).
- `go test -race ./...` not run (no C toolchain in this session, CGO_ENABLED=0) — recorded as blocked, not passed.
- Interactive Electron smoke (launch→search→stream→resume) not runnable in this headless session — T020 manual portion pending operator.
- AniList/Jikan/AniZip/Cinemeta network egress blocked from this host (TMDb reachable) — affects live provider checks only; contract suites cover fixtures.

## Desktop characterization (M0.2 prerequisite note)

M0.2's interactive smoke and DB fixture backup require the operator's desktop environment and real viewing data; not executed here. The disposable PostgreSQL drill (`p7-rollback-drill.md`) demonstrates the recoverable-snapshot procedure on disposable data.
