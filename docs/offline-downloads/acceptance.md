# Definition of done

Status: required checks, none executed by this design task. Each implementation report must record ID, actual command/device action, expected/actual result, pass/fail/pending, source SHA and evidence path. A skipped or unavailable mandatory test is pending, not passed.

## Connection milestone

| ID | Given / action | Required result |
|---|---|---|
| C1 | Fresh install; enter malformed URL, unreachable valid URL, then compatible URL | WF01 preserves input/errors; only verified compatible URL activates; successful durable save opens app |
| C2 | Existing valid `mw_server_origin`; cold launch with server off and zero downloads | Shell and gear usable without network completion; WF02 recovery; address retained; no onboarding redirect |
| C3 | Saved server answers normally | Home or last safe destination; no persistent warning; repeated checks do not flash setup |
| C4 | Probe hangs past its timeout and later returns; repeat with/without ready files | Home/last tab stays usable; no timed Downloads redirect; tapping Downloads works immediately; late result changes status/data only |
| C5 | Navigate, scroll, edit Settings or tap download notification before probe resolves | User/deep-link intent wins; no automatic route replacement, lost draft, focus or scroll |
| C6 | Actual ready files, then server unreachable or incompatible at cold launch | Home/last tab restored; Downloads always one tap away; no outage-triggered redirect; local Play/Resume works |
| C7 | Connection drops mid-browse or returns during local playback | Current screen/playback remains; persistent Downloads tab works; no full-screen gate or redundant banner on local media |
| C8 | Failed URL replacement, denied local-network access, storage write/read failure, old/missing optional capability | Distinct actionable states; original URL retained; no false first-install state; local data preserved |
| C9 | Compare implemented states to evidence screenshots and revised wireframes | Existing logo/header, Settings2 control, setup layout and tab order preserved; Downloads appended. Home error is Server unavailable + Retry + Go to settings; no file-retention/instruction paragraphs, repeated rail errors or redundant offline banners |

For C-only completion, the route policy part of C6 uses explicit fixture inventory and is labelled simulated. Its real-media requirement remains mandatory for the full feature.

## Downloads and data

| ID | Given / action | Required result |
|---|---|---|
| D1 | Select movie/episode, source and subtitles, enqueue twice with same command ID | Correct canonical episode/file and one job; no silent source change; safe unknown-size state |
| D2 | Server prep finishes while phone app is suspended | Durable server job; honest reopen-to-start behavior; no fabricated transfer/completion notification |
| D3 | Hand complete large file to native transfer, lock/suspend app | Supported background transfer/finalization observed on physical phone; measured progress only |
| D4 | Pause/resume; network changes; OS termination; user force-quit then reopen | Native/store reconciliation; safe resume or explicit restart; no duplicate bytes or false ready state; report force-quit limitation |
| D5 | HEAD/ranges, interrupted request, stale If-Range, expired job, server restart | Correct lengths/status/ETag; stable content; no mixed revisions; explicit renewal/reprepare behavior |
| D6 | Disk full on server/phone, concurrent prep and viewing | Bounded admission and actionable errors; existing healthy streaming is not evicted or starved by downloads |
| D7 | Missing video bytes, bad digest, missing selected subtitle, crash during finalize | No ready/notification before verification; retry or explicit subtitle omission; atomic recovery without losing unrelated media |
| D8 | Play downloaded file with network interception failing all remote calls | Local metadata/subtitles/seek/resume work; zero required server/provider calls |
| D9 | Local progress then reconnect; concurrent server change; duplicate request; deliberate rewind | Conditional idempotent commit or explicit two-position conflict; no furthest-position/time-based overwrite |
| D10 | Change URL to same server, different server, or reinstalled server at same URL | Instance identity governs sync; no cross-server queued writes; local files remain usable |
| D11 | Remove queued/ready/playing download; permissions or file IO fail | Confirm ready removal, stop affected playback, delete only owned files, truthful retry; library membership unchanged |
| D12 | Deny cellular; shift Wi-Fi→cellular; no internet but LAN server reachable | Wi-Fi policy enforced by native transfer; LAN reachability evaluated separately from general internet |

## iOS presentation

| ID | Given / action | Required result |
|---|---|---|
| N1 | First download, accept/deny notification prompt | Contextual request; transfers work either way; no repeated permission nag |
| N2 | Complete verified package / only finish server prep | Local completion notification only in first case; correct item and no duplicate alerts |
| N3 | Active queue on compatible Dynamic Island iPhone; compact/minimal/expanded and locked | Correct title/progress/count; unknown totals indeterminate; tap opens Downloads |
| N4 | Suspend until activity stale, complete/cancel/relaunch | Stale copy instead of fake progress; final/ended activity; no orphan duplicate activities |
| N5 | Live Activities disabled, notification denied, OS/device without relevant surface | In-app queue/playback unaffected; supported fallback; no unconditional unavailable API calls |

## Shared regressions and visual checks

| ID | Required proof |
|---|---|
| X1 | `npm test`, browser/mobile/renderer builds and affected native Xcode build/tests; baseline failures explicitly compared, not hidden |
| X2 | For changed backend: `go test ./...`, `go vet ./...`, affected race checks, DB migration/conditional-write/integration tests against disposable DB; existing streaming/subtitle/progress contracts pass |
| X3 | WF01–WF11 at 390px and narrow 320px equivalent, 200% text, keyboard/safe areas, landscape, VoiceOver, reduced motion; accessible 48px web/44pt native targets; no clipping/unreachable controls; online desktop/Android/browser still work without fake offline support |

## Final travel test (mandatory physical iPhone)

1. Connect to the Fedora server. Download one movie and two episodes using controlled authorized media, including a selected subtitle. Verify local Ready status.
2. Close torWatch completely. Enable airplane mode and disable Wi-Fi. Reopen it. Downloads must be reachable without waiting for a successful server probe.
3. Inspect title/episode data and artwork or local placeholders. Play, seek, select subtitles, pause and resume. Close/reopen and verify position.
4. Reboot the phone, unlock, reopen and resume offline. Record device/OS and behavior.
5. Reconnect and prove progress imports once. Repeat with newer server progress from a second client and resolve WF08 without losing either record.
6. Repeat cold launch with no ready downloads and with only a partial download. Neither is falsely playable, and recovery never becomes repeated first-time setup.

## Completion statement

**Connection milestone complete** requires C1–C5/C7–C9, simulated C6 policy coverage, X1/X3 relevant to connection, and configured-phone outage proof.

**iPhone feature ready** requires all C/D/N/X rows and the full travel test, plus reviewed migrations/contracts and documented operational limits. A preview, unit tests, signed build alone, or server-side file completion cannot establish this status.

Evidence must identify which observations used fixtures and which used a real iPhone/server. Sanitize credentials, server tokens, private addresses and personal viewing data before sharing captures/logs.
