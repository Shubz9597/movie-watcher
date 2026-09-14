# VLC playback layer — verification state (M1.4.7)

MobileVLCKit (iOS) / LibVLC 3.6.2 (Android) playback behind the shared
Capacitor player interface. This document separates what is VERIFIED from
what remains PENDING on devices. Never claim device validation from web or Go
tests alone.

## Verified (this machine)

- **Android native compile: PASS.** `gradlew :app:assembleDebug` builds the
  full APK with `org.videolan.android:libvlc-all:3.6.2` packaged
  (`libvlc.so`, `libvlcjni.so` in the APK) against Android SDK 36 / AGP 8.13
  / Kotlin 2.2.10. Every LibVLC API the plugin uses was verified against the
  real AAR (`javap` on `classes.jar`): `interfaces.IMedia$Slave(int,int,String)`,
  `Media.addSlave(IMedia$Slave)`, `MediaPlayer.addSlave(int,String,boolean)`
  (boolean), `setSpuTrack/setAudioTrack(int)`, `setSpuDelay/setAudioDelay`
  (MICROSECONDS, boolean), `getAudioTracks/getSpuTracks`
  (`TrackDescription{id,name}`), `attachViews(VLCVideoLayout,…)`,
  `Event.Buffering` (`getBuffering(): float`), `isSeekable`, `setTime(long)`.
- **iOS API surface: verified against the REAL 3.7.3 headers.** The pinned
  archive (`scripts/setup-ios-vlc.mjs`, sha256
  `0d04059906962ddc9a7bd1ebaa12e1f9ae85eb2466116a97a2f46886dd27a0a9`) was
  downloaded and its headers inspected: `VLCMediaPlayerDelegate` methods are
  `mediaPlayerTimeChanged:`/`mediaPlayerStateChanged:` (NOTIFICATION-style,
  object = the player); subtitle inventory is `videoSubTitlesNames` /
  `videoSubTitlesIndexes` (note the "s"); `currentVideoSubTitleIndex` is
  `int`, delays are `NSInteger` MICROSECONDS; `addPlaybackSlave:type:enforce:`
  returns `int` (0 = success, matching the libvlc C convention);
  `initWithOptions:` / `drawable` / `isSeekable` confirmed. An actual
  `xcodebuild` still requires macOS/Xcode — PENDING.
- **Web layer: PASS.** `tsc --noEmit`, full `npm test` suite (character-
  ization incl. `mobile-native-repair.test.mjs`), `build:mobile` and
  `build:browser` all green. Interactive bridge methods are playId-guarded;
  `tracksUpdate` carries authoritative `selectedAudioTrackId` /
  `selectedSubtitleTrackId`; `buffering` carries the native progress estimate.
- **Go layer: PASS.** `go build ./...`, `go test ./internal/...` for playback,
  skipsegments, config, subtitle HTTP tests. VLC profiles direct-play the
  ORIGINAL file (MKV/HEVC/DTS/AVI); transcode-disabled policy refuses with
  `transcode_disabled` while direct + remux stay available; styled ASS/SSA
  sidecars are served byte-identical for `-vlc` sessions WITHOUT spawning
  FFmpeg (`vlc_review_test.go`); imported-subtitle retention enforces a 7-day
  expiry and a 64 MiB total cap (oldest evicted first,
  `TestSubtitleImportRetention`).

## Setup (one command, Mac only)

`npm run setup:ios-vlc` (also wired into `mobile:build`) downloads the
checksum-verified official MobileVLCKit 3.7.3 XCFramework into
`ios/App/VLCDependency/` — a LOCAL SPM package outside Capacitor's generated
`CapApp-SPM`, so `capacitor sync` never rewrites it. The empty
`torwatch_vlc_link_support()` call in `MainViewController` retains the shim
target whose linker settings pull the system libraries the VLC binary needs
(xml2, z, bz2, iconv, c++, VideoToolbox, …). Then `npm run cap:open:ios` and
build in Xcode.

Android needs no extra step: `npm run mobile:build` then
`npm run cap:open:android` (Gradle resolves the pinned AAR).

## PENDING — device verification (cannot be claimed from tests)

1. **iOS build + playback on device** (Xcode required): compile, then the
   lifecycle matrix below.
2. **Player lifecycle on BOTH devices**: startup → initial buffering (poster
   loading screen) → resume → pause → background/foreground (iOS pauses on
   resign-active; Android pauses in `handleOnPause`) → close during startup →
   retry after error → source replacement → rotation. No invisible playback,
   no retained sessions, no stuck loading screen; screen-awake flag restored
   on close; audio focus/interruption handled by VLC + session category.
3. **Subtitles end-to-end**: OpenSubtitles search (language selector reaches
   `/subtitles/list` `langs=`) → choose → download to a temporary device
   file → attach WITHOUT restart; local SRT/VTT/ASS/SSA import; embedded
   tracks; Off; rapid switching (operations are generation-guarded — the
   last selection wins, stale downloads are cancelled and their temp files
   removed); close/change-source during download (rejected, file deleted).
4. **Skip-intro with real identifiers**: TV episode with TheIntroDB data /
   anime with AniSkip; chip appears during the intro, tap seeks past it.
5. **Seeking on INCOMPLETE torrents**: long-range forward seek into
   un-downloaded regions stalls into the buffering state and recovers; no
   deadlock after two consecutive long-range seeks.
6. **Radxa**: measure CPU/RAM during direct playback:

```powershell
# On the SERVER host, while a device plays (60 s sample):
$p = Get-Process torwatch-staging   # or the containerized process
1..60 | ForEach-Object {
  $cpu1 = $p.TotalProcessorTime.TotalMilliseconds
  Start-Sleep -Seconds 1
  $p.Refresh()
  "{0:s} cpu={1,5:0.0}% ws={2,6:0} MB" -f (Get-Date),
    (($p.TotalProcessorTime.TotalMilliseconds - $cpu1) / 10),
    ($p.WorkingSet64 / 1MB)
} | Tee-Object playback-load.csv
```

   Pass criteria: no ffmpeg process is ever spawned for a direct session;
   `PLAYBACK_TRANSCODE_MODE=off` is present in `deploy/torwatch-server/
   compose.yaml` (default `${PLAYBACK_TRANSCODE_MODE:-off}`) and reaches the
   container (verify inside: `docker exec <container> env | grep PLAYBACK`).

## Resource-bound audit conclusions

- **Imported subtitle cache**: bounded (7-day expiry + 64 MiB cap, oldest
  evicted, swept inline per import — the directory is tiny, no janitor
  needed).
- **Sidecar reads**: `readBounded` caps every sidecar/container-stream read
  at 4 MiB via `LimitReader`.
- **Media source ranges**: the loopback media source issues a FRESH
  `ReadSeekCloser` per request and closes it via `defer` when
  `http.ServeContent` returns — an abandoned seek/download (client closes the
  connection) releases its reader as soon as the next write fails. No
  reader retention across requests.
- **FFmpeg**: VLC direct sessions never launch FFmpeg (planner returns
  direct for the `-vlc` profiles; `PLAYBACK_TRANSCODE_MODE=off` additionally
  refuses transcode decisions; remux stays opt-in via config). ffprobe and
  the FFmpeg fallback are KEPT (Docker image ships both).
