# Resume feature 002 on another PC

Checkpoint: 2026-09-06, after reported M3.1 completion. This file is a handoff, not independent certification of the reported tests or a release. The identity design is decided; the running catalog remains ambiguous until M3.1.1 is implemented and verified. M3.2 persistence is blocked on that task.

## Transfer the checkpoint

Commit and push the intended source, tests, lockfile, deployment templates, docs and specs on the working branch. A tracked-files-only commit omits much of this implementation: at handoff creation, `specs/`, `docs/mobile-ui/`, platform/browser components and much of the BFF were untracked. Review the staged file list and diff before committing. Record the resulting commit and branch; confirm the push succeeded before leaving this PC.

The ignore rules exclude generated `electron-app/dist-browser/` and allow the reviewed placeholder-only `deploy/torwatch-server/.env.example`. Actual `.env` files remain ignored. Do not transfer dependencies, compiled native binaries, caches, database volumes or private operator settings through Git. Reinstall/rebuild dependencies on the destination; transfer required secrets and any wanted database backup separately. A clone does not restore watch history or local application settings.

Root `DESIGN.md` and `PRODUCT.md` are ignored. Portable design/product context is in this directory and `specs/002-mobile-shared-ui/`; their absence on the destination must not trigger a redesign. `.specify/feature.json` is also local: select feature 002 explicitly if using Spec Kit. Keep portable `.opencode/commands` and relevant repository skills with the checkpoint; global plugins are not assumed available.

## Destination baseline

Fetch/checkout the recorded branch and verify the checkpoint commit is present. Inspect Git status before editing; preserve any destination work. Use the Go version required by `torrent-streamer/go.mod` and a Node version compatible with the checked-in dependencies and their type-stripping test scripts.

From `electron-app`, run `npm ci`, `npm test`, `npx tsc --noEmit`, `npm run build:renderer`, and `npm run build:browser`. From `torrent-streamer`, run `go test ./...` and `go vet ./...`. Report baseline failures, unavailable native dependencies and skipped PostgreSQL tests explicitly. A disposable PostgreSQL instance is required for M3.2 database evidence. Interactive Electron/MPV additionally needs the platform's native dependencies; renderer compilation is not a playback test.

## Prompt for OpenCode

Continue feature 002 with M3.1.1 ONLY, then stop with evidence and a M3.2 handoff.

Read `specs/002-mobile-shared-ui/{spec,plan,tasks,data-model}.md`, `contracts/library-api.md` and `evidence/m3.1-identity-contracts.md` within that feature directory, plus `docs/mobile-ui/architecture.md` and the existing feature 001 catalog contract. Establish the destination baseline above. Do not regenerate the specification or restart completed phases.

Implement media-qualified catalog IDs `tmdb:movie:N` and `tmdb:tv:N` across producers and affected consumers. Qualified detail requests must address only the requested media type, including failure cases: never fall back from a qualified TV ID to a movie. Preserve the existing movie-first behavior of unqualified `tmdb:N` strictly as a legacy read compatibility rule; it cannot establish the intended identity for a Library write. New producers and consumers must retain qualified IDs end to end.

Cover TitlePage, PlayerPage metadata, continue-service, `catalogIdForSeriesId`, episode IDs/parsing, caches, routes and direct/reloaded links. Routes without an opaque catalog ID must retain an explicit trustworthy media namespace rather than rebuilding ambiguous IDs. Anime is a classification, not an alternative to the provider's structural movie/TV identity. Preserve progress keys and ordering; no progress migration or silent rekeying.

Extend deterministic same-number movie/TV tests to prove independent lookup, episode association and consumer behavior. Preserve legacy read alias and parity coverage. Check old-client/new-server and new-client/old-server behavior against the established rollout gates; document limitations instead of claiming that server alias support alone proves both directions compatible.

Run `go test ./internal/catalog/ ./internal/httpapi/ ./tools/reference-client/`, relevant broader Go checks, `npm test`, type checking and both builds. Record evidence in `specs/002-mobile-shared-ui/evidence/m3.1.1-qualified-identity.md`, reconcile contracts/tasks, and state whether the implementation gate for M3.2 now passes. Do not add Library storage, migrations, write endpoints or capability advertisements in this assignment.

## Gates carried forward

Shared-browser M2 passed the reported alpha fixture review; aesthetic follow-ups remain in `evidence/visual-followups.md`. Headless frame timing and tiny cached placeholder artwork are development diagnostics, not native presentation or representative decoding evidence.

Keep `catalogSource=renderer` as the default, retain fallback routes, and keep Library preview-only until its implementation gates pass. T020/T042/M0.2 interactive verification, live Electron MPV regression, native M1.3+/M5/M6 and Radxa checks remain open. Use `OPERATOR-CHECKLIST-T020-T042.md` for the desktop operator journey. Phase 9 removals remain gated. Origin:null remains a documented compatibility exception, not an Electron identity boundary.

After M3.1.1 passes, M3.2 implements the finalized storage/API contracts with the disposable-PostgreSQL test list, additive migration and old-binary compatibility evidence. M3.3/M3.4 enable shared Library consumers; M4 handles recommendations.
