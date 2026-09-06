# Server phases and mobile continuation readiness

Checked: 2026-09-06 against the current working tree. HEAD is `bd11a90a6f3c207392bdadd0c89377dcf240752f`, but substantial feature 001 source, tests, deployment files and documentation are modified/untracked. HEAD alone does not identify the implemented working tree. No task checkboxes were changed by this audit.

## Answer

Phases 1–8 are **not fully complete according to their own task/evidence files**. Much of the implementation exists; several mandatory verification and migration steps remain open. Phase 9 is required to close the server release milestone, but deleting legacy code is conditional, and a completed Phase 9 release is not required just to begin isolated feature 002 development.

Continue by verifying/fixing the existing BFF prerequisites, keep fallback code, and then build the mobile alpha in its own feature. Hardware-only release gates can stay honestly pending while independent UI work progresses. Do not use missing hardware as a reason to skip software failures or unverified database correctness.

## Recorded task state

The tasks file uses Phase 1–9; plan/evidence files use P0–P8. Thus Phase 8 is `p7-report.md`, and Phase 9 is plan P8. There are 52 checked tasks out of 64 in phases 1–8; 12 remain unchecked. Checked implementation tasks can still contain skipped integration checks.

| Task phase | Checked | Remaining work |
|---|---|---|
| 1 | 9/9 | Recorded complete; preserve baseline evidence |
| 2 | 7/7 | Recorded complete |
| 3 | 3/4 | T020: interactive Electron launch/search/stream/resume smoke |
| 4 | 13/14 | T034: live disposable-stack catalog endpoint checks |
| 5 | 4/4 | Recorded parity pass; V1–V5 variance review remains noted in evidence |
| 6 | 3/6 | T042: both-mode full journey; T043: verified default flip; T044: exit gate |
| 7 | 5/6 | T050: real dual-client journey, leases/progress/capacity observation |
| 8 | 8/14 | T059 scripts smoke, T060 multi-arch image build, T061 gateway range/SSE, T062 DB rollback drill, T063 Radxa measurements, T064 exit/race/live acceptance |
| 9 | 0/5 | T065–T069 removal decisions, gated cleanup, release and final acceptance |

Sources: [tasks](../../specs/001-build-torwatch-version/tasks.md), [flag verification](../../specs/001-build-torwatch-version/evidence/p5-flag-verification.md), [dual-client evidence](../../specs/001-build-torwatch-version/evidence/p6-dual-client.md), [phase 8 report](../../specs/001-build-torwatch-version/evidence/p7-report.md), [Radxa gate](../../specs/001-build-torwatch-version/evidence/p7-radxa.md), [rollback drill](../../specs/001-build-torwatch-version/evidence/p7-rollback-drill.md).

## Code findings that affect the next step

1. Electron's default is still `renderer` in `electron-app/electron/config/app-config-store.js` and `src/lib/catalog-source.ts`. T043 has not been implemented; do not describe the running default as BFF-only.
2. The BFF migration is partial, not merely awaiting screenshots. `TitlePage.tsx`, `SeeAllPage.tsx`, and `lib/services/continue-service.ts` still import legacy provider services. Phase 6 evidence explicitly lists detail enrichment, genre rails, multi-season anime verification and section fan-out as gaps. Trace actual requests in BFF mode, complete the applicable server contracts/client mappings, then perform T042. An import alone does not prove a request occurred, but it contradicts assuming those dependencies are already removed.
3. `/subtitles/configure` still has a live caller at `electron-app/electron/ipc/setup-ipc.js:166`, and the V1 compatibility contract says retain it. T067's candidate list includes it despite the earlier correction. Fix that decision record before any cleanup; never delete it just because it appears in the candidate list. `/watch/*` and `/stats` also remain live.
4. Migration/progress integration tests explicitly skip without `TORWATCH_TEST_PG_DSN`. Green non-DB unit tests do not prove the migration or ordered database writes. Test the current migration set, including 006, in the disposable drill; the older report discusses mainly 005.
5. `p5-flag-verification.md` records variance approval as not yet recorded; `p7-report.md` records a progress interpretation for review. Preserve these open decisions and resolve them against existing user/spec authority with concrete examples. The owner's acceptance of mobile alpha visuals is not evidence that an unrelated server removal/release gate passed.

## What to do with Phase 9

- **Now:** inspect and document which paths remain live, record retention reasons, fix stale removal lists, prepare the release checklist, and continue prerequisite verification. These actions are safe without deleting anything.
- **Defer T065/T066 deletion:** renderer-provider removal requires T042/T043, a full BFF release cycle, parity evidence and the existing approval gate. Those conditions are not established here. Keeping compatibility code is expressly allowed by the phase's purpose when recorded; do not tick removal tasks as executed if they were only deferred.
- **T067:** make a per-route retain/remove decision using current consumers and contract evidence. Retain live routes; no blanket cleanup.
- **T068/T069 release closure:** pending prior live deployment, rollback, race, dual-client and Radxa gates. Do not invent an immutable release, image digest, soak result or release-cycle evidence.

A full cleanup pass before mobile would remove the fallback precisely while the new path still needs verification. The next useful work is prerequisite closure plus isolated mobile alpha, not forced deletion.

## Direct prompt versus Spec Kit

You can give OpenCode a direct prompt. You do **not** need to rerun `/speckit.specify`, regenerate the spec, or recreate the phases. Keep the existing `specs/001-build-torwatch-version/`, `specs/002-mobile-shared-ui/`, `docs/mobile-ui/`, referenced server docs and constitution available in its workspace. Those are the contracts and acceptance criteria the prompt points to.

The Spec Kit slash commands/scripts are optional for direct execution. If used, select `SPECIFY_FEATURE_DIRECTORY=specs/001-build-torwatch-version` while closing server work and switch explicitly to `specs/002-mobile-shared-ui` for mobile. Do not rely on whatever feature is saved in `.specify/feature.json`. Preserve separate task ledgers.

Use [OPENCODE-CONTINUE.md](OPENCODE-CONTINUE.md) for the combined prerequisite-first assignment. The previous [mobile-only prompt](OPENCODE-PROMPT.md) remains the detailed feature 002 implementation instruction.

## Current audit checks

- `npm test` from `electron-app`: PASS, exit 0.
- `npm run build:renderer` from `electron-app`: PASS, exit 0. Build reports existing static/dynamic import overlap for TMDb/AniList and an outdated Browserslist dataset; no source changes made to silence them.
- `docker info`: unavailable in this session; Docker config access warning and missing engine pipe. No live Compose, image, gateway or DB checks are claimed.
- `go test ./...` from `torrent-streamer`: PASS, exit 0, after retrying with `GOCACHE` set to `torwatch-phase-audit-go-cache` under the system temp directory. The first attempt failed before tests due to access denied to the default build cache; no product code was changed for the retry.
- `go vet ./...` with the same writable cache: PASS, exit 0.
- `TORWATCH_TEST_PG_DSN` is not set, so DB-gated tests were skipped, not verified. `CGO_ENABLED=0`; the race suite was not run or passed in this audit. Use a suitable C toolchain/host for that gate.
- No interactive Electron playback, real provider, phone, Radxa, full release-cycle or race evidence is established by this audit.
