# Implementation tasks

All boxes are initially unchecked. Check one only when its outcome and evidence exist. Record the actual baseline SHA and environment, not this document's earlier SHA. Use existing project skills and engineering conventions when implementing.

## B: baseline and coordination

- [x] B01 Read the packet, constitution and active feature 001/002 contracts. Record git status, current owners, baseline `npm test`, Go tests/vet, mobile/browser build, and existing failures in `evidence/baseline.md`. Checkpoint the homeserver work before any overlapping backend change. Never overwrite unrelated edits.
- [x] B02 Capture current mobile launch, Settings, navigation and native player behavior; map every caller of the gate/player interfaces. Identify the Mac/Xcode/device path for native validation. Missing hardware does not block C/contract work but does block final native completion.

Rollback: baseline work is documentation only. Exit: known failures and pending hardware are explicit; current consumers identified.

## C: first setup and connection recovery (independent release)

- [x] C01 Implement the pure configuration/tab/deep-link launch policy, independent of reachability. Establish tests for every table row in spec C2 before migrating the shell. Include missing config versus read error, late probes that never navigate, Downloads deep links, and failed local inventory reads. No three-second redirect timer.
- [x] C02 Centralize config/probe/save semantics. Migrate existing saved URL, preserve failed setup draft, verify compatible protocol separately from optional capabilities, deduplicate checks, preserve active URL on failed edits. Keep origin-generation cancellation and stale-response protections.
- [x] C03 Migrate mobile/browser shell consumers to contextual availability. First installation shows WF01; configured users always get shell/Settings access. Use explicit fixture inventory only in preview. Preserve desktop Electron setup behavior.
- [x] C04 Implement WF02/WF03/WF07 states by extending the existing shell and connection/settings components referenced in visual-reference.md. Home failure contains only Server unavailable, Retry and Go to settings. Append Downloads after the existing Home/Library/Search tabs. Remove the obsolete mobile blocking gate only after all its consumers and tests have migrated. Do not rewrite old test expectations without explaining the specified behavior change.
- [ ] C05 Verify acceptance C1–C9 and X1–X3, mobile/browser builds, `npm test`, and a real configured-phone launch with server off. Record screenshots and no-redirect behavior. This can be reported as Connection milestone complete, not Offline downloads complete.

Rollback: revert the C integration as one checkpoint while retaining configuration; do not reset preferences. Exit: configured users cannot be locked out by a probe, first-run setup works, navigation and other clients pass regression checks.

## D: iPhone files and playback

- [ ] D00 Run a bounded native feasibility experiment with controlled media. Prove large-file background transfer/finalization, local VLC/sidecars, OS termination recovery, force-quit recovery on reopen, and ActivityKit stale-state behavior. Record supported SDK/device and observed limitations. Keep experiment paths isolated from production until proven.
- [ ] D01 Finalize versioned download/progress/server-identity schemas from plan.md, including safe errors, retention, headers, idempotency, races and migration. Write `contracts.md`, contract tests, and a data ownership/migration note before server consumers. Preserve existing streaming APIs.
- [ ] D02 Implement durable Go prep jobs, bounded admission, retained complete assets, sidecars and restart/expiry/cancel behavior. Verify D1/D2/D5/D6/D10 server cases, and stream while preparation is active. Advertise capability only when functional.
- [ ] D03 Implement native manifest/store, staging/atomic finalize, OS task reconciliation, file integrity and path validation, free-space checks, storage errors and pause/resume/retry/cancel/remove. Test interrupted finalization and device relaunch before UI integration.
- [ ] D04 Extend the native player with local-download identity and durable local progress. Keep remote session flow intact; assert local start issues zero server/provider requests. Verify selected subtitles, seeking, resume, and deletion during playback.
- [ ] D05 Connect the real adapter to WF04/WF05/WF06/WF08, expose four-tab navigation on supported native clients, gate Download by server capability, and implement empty/error/partial states. Support notification/deep links before launch policy redirects.
- [ ] D06 Implement conditional offline progress import, original-server scoping, duplicate suppression and explicit conflicts. Cover simultaneous local playback while sync completes and another client modifying the server record during conflict resolution.
- [ ] D07 Run D1–D12 and C6 with actual downloaded assets, not just fixture inventory. Record storage/transfer numbers, restart/recovery evidence and the complete offline player journey.

Rollback: disable new enqueue capability but retain ready local playback/data where possible; revert only compatible backend additions. Never delete downloaded files as rollback. Exit: D accepts verified local content, continues independently of server, and never overwrites conflicting progress blindly.

## N: notifications and Live Activities

- [ ] N01 Add contextual notification permission and native completion/failure notifications, grouped/deduplicated. Deep links open the intended download without auto-playing. Test denied permission and cold-start tap.
- [ ] N02 Add WidgetKit extension and ActivityKit queue presentation: compact, minimal, expanded, Lock Screen, waiting, unknown size, stale, completed and cancelled. Gate by OS/authorization; no fake timers. End/reconcile old activity instances.
- [ ] N03 Verify N1–N5 on physical hardware, including Lock Screen without Dynamic Island where available, denied permissions and suspended app. Record unsupported hardware checks as pending, never passed.

Rollback: disable activities/notifications independently; downloads and local playback continue. Exit: system surfaces reflect durable state and do not promise continuous updates.

## R: release proof

- [ ] R01 Run the full airplane-mode travel test, reconnection conflicts, existing online viewing, migrations and X1–X3. Complete `evidence/acceptance-report.md` with one row per acceptance ID and links to evidence.
- [ ] R02 Document operator/client recovery, retention limits, disk usage, server upgrade requirements, and the reopen-after-preparation limitation. Reconcile spec/plan/tasks with implementation; expose no unexpected scope expansion.
- [ ] R03 Review final diff and report Connection milestone complete / iPhone feature ready / blocked, accurately scoped. Do not merge, push, publish or sign off the unrelated Version 2 release without the owner's instruction.

Release rollback: recorded client/server compatible versions, feature flags, storage schema behavior and tested recovery. The full feature is done only when every mandatory acceptance row passes; keep device-dependent pending rows visible.
