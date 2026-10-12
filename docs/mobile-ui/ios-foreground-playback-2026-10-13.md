# iPhone video recovery after returning from Home

Reported symptom: leave a playing episode for the iPhone Home Screen, reopen
TorWatch, and hear audio over the frame left on screen for about 5–6 seconds.

## Findings and repair

The native plugin paused on `didEnterBackground`, but its activation observer
only restored orientation. It did not refresh the unchanged drawable. The manual
resume path also sought while still paused, before calling Play.

The pinned MobileVLCKit archive identifies VLC revision `79128878`. Its
[iOS output implementation](https://github.com/videolan/vlc/blob/79128878/modules/video_output/ios.m)
disables rendering on resign-active, releases the EAGL context in background,
and enables it on the foreground/active notifications. It resets renderbuffers
in `layoutSubviews` and `didMoveToWindow`. Returning with unchanged bounds does
not necessarily cause either callback. This, combined with a resume frame
decoded before rendering is available, is a plausible explanation for the
reported freeze; actual decoder/GPU behavior must still be confirmed on device.

The repair keeps the same VLC player, media, drawable, tracks, delays, subtitles,
and player UI. On a real background transition, it pauses at the current
position. Recovery runs on the next main-queue turn
after activation notification delivery so VLC can enable its context first.
It explicitly lays out the drawable subtree and leaves playback paused,
whether the viewer left while playing or already paused. Only an explicit Play
tap unpauses, then precisely seeks to the original position, flushing old
queued pictures without rewinding.
Explicit pending seeks take precedence, and inactive seeks stay deferred.

Control Center/Siri do not trigger the real-background pause. Duplicate
background notifications keep the original pause anchor. Generation and
engine-identity checks invalidate queued
work after rapid app switching, closing playback, or player replacement.

## Verification

- `npm run test:ios-foreground` compiles and executes the **production Swift
  method bodies** against fake UIKit/VLC boundaries. Covers refresh → Play →
  exact seek ordering, unchanged viewport bounds, retained track/delay values,
  both Home scenarios staying paused, explicit Play, rejected inactive Play,
  inactive scrubbing, rapid switching, terminal
  playback/replacement, and delayed seekability. Linux runner:
  `docker pull swift:6.0.3-bookworm`, then
  `TORWATCH_SWIFT_DOCKER=1 npm run test:ios-foreground`.
- 53 existing native lifecycle/player, video sizing, and preferences checks
  passed, together with TypeScript and the mobile production build. The entire
  changed Swift file also passed a Swift 6 syntax parse.

The Swift harness verifies ordering and state management. It does not compile
the entire iOS target or exercise MobileVLCKit's real EAGL/VideoToolbox output.
This Linux workspace has no Xcode or iPhone runtime.

On an iPhone build, verify streamed and downloaded episodes: play → Home for
5 seconds → reopen, repeat after 30 seconds, rapid repeated switching, and
paused → Home → reopen. Both scenarios must return paused without audio or
automatic playback. After tapping Play, the first moving picture should resume
with audio at the saved position. Check subtitle/audio
selection and delay, all sizing modes, and Control Center brightness changes.
