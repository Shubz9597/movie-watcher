# OpenCode assignment: shared mobile alpha

Copy the following prompt into OpenCode, opened at the movie-watcher repository root. This is a coding assignment; the documentation pass that wrote it has not started implementation.

For the current workspace, begin with [OPENCODE-CONTINUE.md](OPENCODE-CONTINUE.md). It addresses the remaining feature 001 BFF prerequisites and then invokes this mobile assignment. See [PREREQUISITE-STATUS.md](PREREQUISITE-STATUS.md); phases 1–8 are not fully verified yet.

---

Implement torWatch feature `002-mobile-shared-ui` from the existing checked-out repository. Start by reading `docs/mobile-ui/README.md`, `docs/mobile-ui/architecture.md`, `docs/mobile-ui/change-map.md`, `specs/002-mobile-shared-ui/spec.md`, `plan.md`, `data-model.md`, and `tasks.md`. Read `.specify/memory/constitution.md` and the feature 001 catalog/protocol/lease/progress contracts before changing shared backend behavior.

The owner has accepted the revised five wireframe boards **for alpha**, but is not satisfied with their final visual quality. Use `docs/mobile-ui/design-system.md`, `wireframes.md`, and the actual PNGs in `docs/mobile-ui/wireframes/` as the alpha interaction reference. Implement the alpha without another approval round for its established layout. Fix defects found in the working app and keep concrete visual follow-ups for later refinement. Do not call these wireframes final or production-polished.

Reuse the Electron React screens/components for iPhone first, then Android. Use thin platform wrappers, with Capacitor/player choice verified in M1; do not rewrite the UI separately in native frameworks. Keep business rules and household truth in the Go BFF. UI changes propagate through shared source and each target's build; data changes sync through the BFF. Preserve the current desktop journey and MPV integration.

The accepted alpha interaction choices are:

- Bare icon Back/Settings/Close/save/source tools with accessible names, visible focus and full touch targets. Bottom destinations have icons and small labels.
- Continue Watching is a swipeable carousel with a next-card peek and progress on artwork. Artwork/play resumes; title opens detail; a swipe must not trigger playback. No extra full-width Resume bar.
- Home media categories use an open icon rail. Search filters use a selection sheet.
- Library uses underlined Watch Later/Favourites tabs, then separate Movies/Series/Anime shelves with full counts and links to scoped grids. Independent save flags persist server-side and sync across clients.
- Torrents use readable release/quality/size/seeders/compatibility rows, expandable full details, and separate selection and Play actions. Unknown technical metadata stays unknown.
- Recommendations are the bounded, deterministic, server-side favourite-genre rules in plan.md, with truthful cold-start/failure fallback. No ML infrastructure.

Work through the existing 22 task IDs in dependency order, not a new disconnected plan. The first deliverable is M0 baseline evidence; the next is a browser-safe shared Home→Title slice with explicit adapters. Proceed from baseline into implementation in this assignment, rather than ending after a planning summary. Split a task into child tasks if needed while preserving its parent ID, acceptance and rollback. Do not regenerate/overwrite the accepted spec/plan/tasks with generic templates.

Before the first source change, record current revision, branch and all pre-existing dirty/untracked work. Preserve that work; do not reset, clean, force-checkout, or commit it wholesale. Characterize current behavior before refactoring. Use separate changes for structural extraction and new functionality. Keep incomplete features isolated from the default production path. New API/DB contracts precede their clients, and migrations must remain compatible with rollback. The identity investigation in architecture.md is a gate before library persistence; do not silently change existing title or progress IDs.

Implement one shared token/component/API-client source, injected platform services and BFF-only phone mode. Audit direct `window.electronAPI` access and import-time server origins. A global fake Electron bridge, direct mobile provider calls or a duplicated mobile screen tree is not an acceptable implementation. Ensure server switches cancel old work and clear origin-scoped capability/library caches. New capability names must be truthful and versioned in the existing version response.

Run focused checks per task, and full affected suites at phase exits. Existing commands: from `torrent-streamer`, `go test ./...` and `go vet ./...`; from `electron-app`, `npm test` and `npm run build:renderer`, plus relevant existing desktop smoke checks. Record command, working directory, result and pre-existing failures. Add actual native build commands only after toolchain selection. Never equate renderer compilation with native playback verification.

Use `docs/mobile-ui/visual-qa.md`: render real application components with deterministic fixtures, capture phone and desktop states, **open and inspect the images**, document concrete defects, fix in one batch, and recapture to check the fixes. Test taps, Back, keyboard, font scaling, screen-reader labels, save failures and cross-client refresh. Measure animation/scroll/input behavior against plan.md; screenshots do not demonstrate smoothness. Do not use the wireframe PNGs as implementation evidence. Save compact phase reports under `specs/002-mobile-shared-ui/evidence/` and name actual capture/trace paths. Keep secrets and private viewing data out of artifacts.

You are running in OpenCode. Use your available shell, file editing, browser, image inspection, and native-device tools. Do not assume Codex tool namespaces, sidebar features, plugin paths, or skill names are callable here. Repository `.opencode/commands/speckit.*.md` files exist; use them if supported after explicitly selecting feature 002. If Impeccable/Go skills are available in this OpenCode session, read the relevant guidance. Otherwise follow the self-contained architecture/design/test requirements in this handoff; missing optional Codex plugins are not a blocker. If image inspection or device capture is unavailable, report the precise verification gap and keep independent implementation work progressing.

M1's real iPhone playback and final Radxa/device gates may be hardware-blocked. After M1.2, continue independent M2–M4 work. Do not tick a blocked task or claim native support. Record a supported-format matrix and explicitly append any needed player/transport tasks; do not hide HLS/remux/transcoding scope in UI changes. Do not publish, submit to stores, or expose the server publicly.

At each stopping point update task evidence and return: implemented user outcomes, changed files, test/build results, screenshot review and numeric performance evidence, any failures/blocked hardware, rollback status, and next task. Keep later visual refinement open without using it to excuse a broken alpha interaction.

---

## Optional Spec Kit setup in OpenCode

The current repository resolver uses `SPECIFY_FEATURE_DIRECTORY` or `.specify/feature.json`; branch names alone do not select feature 002. Set the directory explicitly in the shell running the scripts. Environment values may not survive separate agent shell calls; set them again where needed.

Read-only path verification from the repository root in PowerShell:

```powershell
$env:SPECIFY_FEATURE_DIRECTORY = 'specs/002-mobile-shared-ui'
& ./.specify/scripts/powershell/check-prerequisites.ps1 -PathsOnly -Json
```

Confirm `FEATURE_DIR` resolves to this repository's `specs/002-mobile-shared-ui`, then use the existing analyze/implement commands if the OpenCode installation supports them. Non-PathsOnly prerequisite calls may persist the selected directory into `.specify/feature.json`; do not unexpectedly change another running task's selection in a shared checkout. Use a task-specific checkout or execute this handoff directly against explicit paths when shared feature-state mutation would conflict. Do not change `.opencode` command files or install plugins just to start this feature.

Root PRODUCT.md and DESIGN.md are gitignored here and may be absent elsewhere. The README/design-system/architecture in this package carry the required context. If using a fresh checkout, make sure the uncommitted `docs/mobile-ui/` and `specs/002-mobile-shared-ui/` directories, along with needed current feature 001 implementation work, have been transferred; a base branch alone may not contain them.
