# Video readiness before Play on iPhone

The supplied 19.9-second screen recording opens an existing downloaded episode
from Home. Play changes to Pause while the old picture remains visible; the
picture later changes and repeats part of the old scene. This reproduces the
problem with a local file, so a torrent/network cache explanation is insufficient.

## Readiness and playback changes

The app previously accepted native Playing/Paused and advancing clock events as
loading completion. Those events can describe audio/input activity without new
video output. The resume helper also sought on every Play tap, making a warm
local decoder flush and decode again from a keyframe.

iOS now emits an explicit `videoReady` flag. On startup and after backgrounding,
the native player prerolls silently behind the existing loader. It waits for:

- An active app, attached video surface, video output, and valid video dimensions.
- Any requested position seek to finish being submitted.
- At least two new decoded video frames and two additional pictures submitted
  to output, measured after preparation/the latest seek.
- A clock near the requested position. If cold decoding ran more than 1.5 seconds
  ahead, preparation seeks back once while still muted and requires fresh frames.

The APIs are verified against the pinned VLCKit revision: the
[media statistics header](https://github.com/videolan/vlckit/blob/319ed2c0/Headers/Public/VLCMedia.h)
exposes `decodedVideo` and `displayedPictures`, and the
[audio header](https://github.com/videolan/vlckit/blob/319ed2c0/Headers/Public/VLCAudio.h)
provides mute while decoding continues. VLC's
[output implementation](https://github.com/videolan/vlc/blob/79128878/src/video_output/video_output.c)
also counts redisplays of the old picture, which is why displayed count alone
is insufficient. These counters provide decoder/output evidence, not a GPU
readback or proof of pixels physically displayed on an iPhone.

Returning from Home remains paused in both requested scenarios. After the
silent preroll, the native player waits for its pause acknowledgement before
unmuting and revealing Play. Normal Play then unpauses without another seek.
Initial playback retains its existing autoplay behavior, but audio remains muted
until video readiness. Original mute, subtitle/audio selections, timing offsets,
and sizing are retained on the same player. Preroll clock/progress is not published
as watched progress. A 15-second timeout reports an error rather than revealing
Play without video evidence; Close remains available throughout.

The shared controller preserves explicit `videoReady:false` through Playing,
Paused, advancing audio clocks, and 100% buffering reports. Play is ignored
until readiness. The React controls use the existing loader and hide playback
controls while preparing. Existing native engines without this signal keep
their prior completion behavior. No player layout/styles changed.

## Validation

- `TORWATCH_SWIFT_DOCKER=1 npm run test:ios-foreground`: compiles the production
  Swift lifecycle/readiness methods against fake UIKit/VLC boundaries. Covers
  audio-only clock progress, old-picture redisplays, unattached/no-video output,
  startup, both paused Home-return outcomes, ignored premature Play, pause
  acknowledgement, normal Play without a seek, retained mute/settings,
  late seekability, hidden catch-up, rapid switching/replacement, and timeout.
- Native bridge/controller regressions include local playback with no server
  session and verify that audio state/clock/progress cannot clear readiness.
- `node scripts/native-loader-smoke.mjs`: exercises the real React controls.
  Verifies no Play/Pause during preparation even after a Playing event, Close
  availability, and restored paused Play only after explicit readiness; existing
  sizing, responsive layouts, rebuffering, and reduced-motion checks also pass.
- TypeScript, mobile production build, and complete changed-file Swift syntax
  parsing pass. The bridge/player/preferences/layout suite has 54 passing checks.

An Xcode build and actual iPhone playback remain unverified in this Linux
workspace. On the phone, reproduce the recording with the same downloaded file:
Home while playing → reopen → loader → paused Play → immediate moving video and
audio together after Play. Repeat after leaving while paused, with rapid Home
switching, and with ordinary pause/Play cycles without leaving the app. Also
check first open/resume of a download, streamed playback, and saved track/delay
settings. This update requires rebuilding the native iPhone app.
