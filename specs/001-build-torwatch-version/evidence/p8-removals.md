# P8 dormant-route decision record (T067 — PREPARED, NOT EXECUTED)

Status: decision record prepared 2026-09-06. **No route was removed and no code deleted in this pass.** Phase 9 is gated retention/cleanup/release work: removals execute only when each route's gate passes, and the release tasks (T068/T069) stay open until their upstream gates pass.

## Correction to the task text (recorded per PREREQUISITE-STATUS.md)

T067's candidate list includes `/subtitles/configure`, but that route has a **live caller**: `electron-app/electron/ipc/setup-ipc.js:166` (subtitle configuration during setup), and the V1 compatibility contract (contracts/v1-compat.md) says to retain it. The earlier D-1 correction in T007 already reclassified it as live. `/subtitles/configure` is therefore **RETAINED** and must not be deleted because it appears in the candidate list.

## Per-route decisions (consumers re-grepped this session, electron-app + torrent-streamer)

| Route | Decision | Evidence |
|---|---|---|
| `/subtitles/configure` | **RETAIN** | Live caller `setup-ipc.js:166`; characterized live in `contract_subtitles_test.go`; V1 compat contract says retain. |
| `/watch/open`, `/watch/ping`, `/watch/close` | **RETAIN** | Live: lease admission wired in T057 (`503 capacity_exceeded` + `activeLeases` observability); server-internal playback lease path depends on them; contract tests in `contract_watch_test.go`. |
| `/stats` | **RETAIN** | Live since T057 (admission observability); closes its old dormant removal gate — keep as operational surface (Gate VI). |
| `/add` | RETAIN (candidate for gated removal later) | No in-repo consumer found this session (grep: zero product-code hits). Removal only with the T067 gate: no-remaining-consumer grep + contract-test disposition + rollback recorded. Not executed here. |
| `/prefetch` | RETAIN (candidate for gated removal later) | Same status/evidence as `/add`. |
| `/v1/session/start`, `/v1/session/ended` | RETAIN (candidate for gated removal later) | No runtime consumer found (only a README documentation mention). Same gate as above before any removal. |
| `/v1/resume/source/probe` | RETAIN (candidate for gated removal later) | No in-repo consumer found; dormant shape captured in `contract_dormant_test.go`. Same gate. |
| `/v1/resume.m3u` | RETAIN (candidate for gated removal later) | No in-repo consumer found; dormant shape captured. Same gate. |

Rationale for retaining even zero-consumer routes in this pass: FR-010/v1-compat change procedure requires per-route gate evidence and same-task contract-test updates at execution time; this pass establishes decisions, not deletions. Windows/local V1 launch flow remains supported until its own gate.

## What this pass did NOT do

- No removal of renderer-provider code (T065 gate open: requires T042/T043 evidence, a full BFF release cycle, parity green, owner approval).
- No dead-env cleanup (T066 depends on T065).
- No release cut, image digest, or soak/race/rollback claim (T063/T064/T068/T069 open; race suite not runnable in this session; no Radxa).
