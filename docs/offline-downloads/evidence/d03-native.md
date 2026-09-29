# D03/D04(native) evidence — iOS download coordinator, manifest store, local playback

Recorded: 2026-09-29 · Source: branch `001-build-torwatch-version` (D03-native commit).
Status: **code complete, awaiting the owner's Xcode build/device pass** (this
environment is Windows — no Swift compilation was possible here; the JS side
is typechecked and built).

## What was built

### Swift (new `ios/App/App/Downloads/`)

- **`DownloadStore.swift`** — SQLite (iOS system library) durable manifest:
  - downloads table: server scope (`instanceId` + `origin` — never URL-only,
    contracts §1), canonical title identity, state (`queued|downloading|
    paused|ready|failed`), safe reason, received bytes; assets table with
    per-asset URL path/disk name/size/SHA-256/done flag; URLSession task
    mapping for OS reconciliation; `download_progress` for durable local
    playback progress (D04).
  - All writes transactional (BEGIN IMMEDIATE/COMMIT with guaranteed
    ROLLBACK), one serial queue, relative disk paths only, ids sanitized
    through `safeId` (hostile ids cannot traverse the downloads root),
    schema-versioned via a `meta` table.
- **`DownloadCoordinator.swift`** — ONE background URLSession
  (`app.torwatch.downloads`; discretionary off, launch events on, waits for
  connectivity):
  - `enqueue` records the manifest BEFORE any task resumes; every task is
    mapped to (downloadId, urlPath) first (relaunch reconciliation depends
    on it).
  - Delegate: throttled (0.5s) durable progress writes; HTTP-status
    validation BEFORE trusting a completed file; per-asset size check;
    SHA-256 verification of EVERY asset streamed in 4 MiB chunks (multi-GB
    videos never load into memory — acceptance D7: nothing is ready before
    verification); same-volume atomic finalize (rename staging → ready).
  - Reconciliation on relaunch/background-events: live OS tasks vs stored
    mappings — orphaned mappings reset to queued and re-created (disclosed
    restart-from-zero, contracts §3/D6); redelivered finished tasks flow
    through the delegate normally.
  - pause/resume (live tasks suspend/resume; re-created after process
    death), cancel (abandons staged work), remove (stops playback first,
    cancels, deletes only its own directories), storage reporting
    (free/used).
- **`TorWatchDownloadsPlugin.swift`** — Capacitor bridge
  (`TorWatchDownloads`, same conventions as the VLC plugin): list/enqueue/
  pause/resume/cancel/remove/storage + `saveProgress`/`loadProgress`/
  `localPlayablePath` (resolves ONLY verified ready downloads — JS can never
  name an arbitrary filesystem path). A failed inventory read surfaces a
  storage error, never "zero downloads" (spec C2). `downloadsChanged` events
  fire on durable changes.

### D04 — local playback in `TorWatchNativePlugin.swift`

- `playLocal(downloadId, playId, seekTo?, subtitleLang?)`: plays the verified
  local file through the SAME MobileVLCKit surface behind the shared React
  UI — zero server/provider requests, no session creation, no heartbeat.
  Durable local progress resumes automatically; the download's own subtitle
  sidecars attach as playback slaves (selected language preferred).
- Progress persists on pause/ended/error/teardown and at ~10s checkpoints;
  track selection maps back to the sidecar language.
- Remote `play()` explicitly clears the local identity — remote sessions keep
  their existing behavior byte-for-byte.
- Removal-while-playing: the downloads plugin posts a stop notification; the
  player persists progress and tears down BEFORE files are deleted.

### Integration

- `AppDelegate` forwards `handleEventsForBackgroundURLSession` to the
  coordinator (completion handler always invoked; released after the system
  redelivers events).
- `Info.plist` gains `UIBackgroundModes: [fetch, processing]` for suspended
  transfer continuation.
- JS: `src/platform/native-downloads.ts` (typed plugin surface) +
  `src/mobile/downloads-adapter.ts` (real inventory/commands).

## PRODUCTION GATE — honest status

`src/mobile/downloads-adapter.ts` reports `available: false`
(`DOWNLOADS_UI_ENABLED = false`, one constant, documented): the Downloads
tab stays hidden and the enqueue sheet (WF04, D05) is not built yet, so no
empty scaffolding ships. The native pipeline is fully reachable for a device
test by flipping that constant. This matches the packet's isolation rule.

## REQUIRED Xcode steps (owner, on the Mac)

1. Open `ios/App/App.xcodeproj` (after `npm run mobile:build` on Windows or
   `npm run mobile:build` ported — the repo's mobile:build chain runs
   `vite build` + `mobile-postbuild` + `setup-ios-vlc` + `capacitor sync`).
2. **Add the new files to the target**: right-click the `App` group →
   *Add Files to "App"*… → select `ios/App/App/Downloads/` (folder) →
   check target `App`. (project.pbxproj uses explicit file references, so
   the folder is not auto-discovered.)
3. Build to a signed device (background downloads do not run on simulators'
   suspended state; simulator still exercises UI paths).
4. Verify the plugin appears in the Capacitor bridge (`TorWatchDownloads`).

## Device test checklist (D03 gates — record results in this file)

- [ ] Unit pass: enqueue against the homeserver with controlled media →
      state transitions queued → downloading (bytes advancing) → ready.
- [ ] Interrupted finalization: kill the app right after the last asset
      lands; relaunch must reconcile (redelivered task or reset+re-enqueue)
      and finalize with verification.
- [ ] Device relaunch mid-transfer: force-kill during download; relaunch
      re-creates tasks (restart-from-zero disclosed) and completes.
- [ ] SHA mismatch: point one asset at wrong bytes → `failed/verification_failed`, never ready.
- [ ] Airplane mode → `failed/network_failed`; retry re-downloads.
- [ ] Pause/resume across lock screen; resume after process death restarts
      (documented limitation).
- [ ] Local playback: play ready content with ALL radios off — zero server
      requests (verify via server logs); seek, subtitles, resume position
      after relaunch; delete-during-playback stops playback first.
