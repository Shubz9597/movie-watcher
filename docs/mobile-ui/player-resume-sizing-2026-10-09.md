# Native player resume and sizing repair

## Recording evidence

The first supplied iPhone recording shows a paused picture at 4:10. After
Play, the clock advances while the same picture remains on screen for several
seconds. The second recording cycles Fill, Fit and Stretch; the picture stays
inside a narrow box, and verbose mode messages appear over the scene.

## Research and changes

- [VLC 3.x iOS output](https://github.com/videolan/vlc/blob/3.0.x/modules/video_output/ios.m)
  routes source crop/aspect updates through `updateVoutCfg`, which returns early
  when the display configuration compares equal. This is a plausible cause of
  ineffective runtime sizing. The repair uses a clipped UIKit viewport and a
  natural-aspect drawable. Fit uses no transform, Fill uses a uniform cover
  transform, and Stretch scales each axis independently. Mode changes never
  seek or change the drawable bounds, including while paused. Actual viewport
  dimensions and video pixel aspect are used instead of assuming landscape.
- [VLCKit playback/time implementation](https://github.com/videolan/vlckit/blob/3.0/Sources/VLCMediaPlayer.m)
  uses VLC's time setter for seeking and separate pause/play calls. The app's
  previous resume path only unpaused a player configured with a four-second
  network cache. The repair records the pause timestamp and precisely seeks
  there once before resuming, flushing queued audio/video without subtracting
  a rewind offset. A paused scrub replaces the resume anchor. The iOS network
  cache is reduced to one second. This is a targeted mitigation for the
  observed queue/clock symptom; its on-device effectiveness remains unverified.
- The pinned Android LibVLC 3.6.2 `VideoHelper` distinguishes
  `SURFACE_BEST_FIT` (Fit), `SURFACE_FIT_SCREEN` (uniform cover/crop), and
  `SURFACE_FILL` (stretch). The app previously mapped Fill to the stretch mode
  and rejected Stretch. All three now map correctly and the native preference
  is restored on a new engine. Source inspected from the
  [published sources archive](https://repo.maven.apache.org/maven2/org/videolan/android/libvlc-all/3.6.2/libvlc-all-3.6.2-sources.jar).
- Shared controls now show only **Fit**, **Fill**, or **Stretch** in a short
  pill immediately below the left-aligned title. Sizing requests remain
  guarded by the current playback identifier on both native platforms.

## Verification

- `npm run test:native-video-layout`: compiles and exercises the production C
  geometry helper for 4:3, cinema, matching aspect, anamorphic, portrait,
  iPad/split-view, and invalid dimensions. Verifies coverage, preserved aspect,
  independent stretching, and constant drawable bounds between modes.
- `node scripts/native-loader-smoke.mjs`: uses the real React controls with a
  deterministic native bridge. Verifies one call per mode, no seek or playback
  toggle during sizing, short labels, pill placement, and responsive layouts.
- TypeScript check, mobile production build, and 51 player/lifecycle/episode
  regression checks passed.

This Linux workspace has no iOS runtime/Xcode or Android SDK. These checks do
not constitute native app compilation or actual decoder playback validation.
Before shipping, verify on an iPhone: pause for both short and long intervals,
resume without repeated audio or a stationary picture, scrub while paused,
change all modes while paused/playing, rotate, and reopen playback with the
saved mode. Check the three sizing modes on Android as well. The smaller iOS
cache should also be checked on a slower torrent source for excess rebuffering.
