# TorWatch patches to VLC (inside MobileVLCKit 3.7.3)

`0001-torwatch-subtitle-box-and-live-layout.patch` applies to VLC commit
`79128878` (the source of MobileVLCKit 3.7.3) **after** VLCKit's own 47
patches (`libvlc/patches` at VLCKit `319ed2c0`). Not yet wired into the app
build: the app still uses the stock MobileVLCKit.

What it does:

- **Dialogue ASS tracks in the subtitle box.** libass tracks whose title
  says plain dialogue ("English Dubtitles", "Full Subtitles", "SDH"; not
  "Signs", "Songs", "Stylized", "Karaoke", "Titles", "Typeset", "Forced")
  are drawn like plain-text subtitles: white text in the player font
  (`--freetype-font`), one 60% black box behind the whole subtitle (libass
  BorderStyle 4 via selective style override). Positioned signs keep their
  styling. Other tracks are untouched.
- **Live layout:** `libvlc_video_set_subtitle_layout(margin_permille,
  text_scale)` moves subtitles up by a share of the picture height (above
  on-screen controls) and changes the dialogue text size, while playing,
  for plain text and ASS alike. `-1, 0` restores the configured
  `sub-margin` / `sub-text-scale`.

Plain-text subtitles (SRT/VTT) need no patch for the box: VLC already fills
one box behind the whole block when `--freetype-background-opacity` is set
(153 = 60%) with `--freetype-outline-thickness=0`.

## Linux check

`test/` builds the same VLC on Debian (Dockerfile, build-linux.sh) and
plays videos in real time through VLC's video output (`play.c`), saving
frames at 5/15/25/35 s while lifting at 20 s and enlarging at 30 s. VLCKit
patch 0028 releases a missing audio output, so the test passes
`--aout=adummy` (an iPhone always has one).
