# Per-video playback settings

The existing player layout is unchanged. Explicit subtitle selections (external,
embedded, or Off), subtitle delay, audio track, and audio delay save immediately
on this device. Reopening the same video restores them after the native player
is ready, without opening a settings sheet.

Stream settings are scoped to the backend, torrent hash, file, season, and
episode. Download settings are scoped to the download ID. Tracker/title changes
in a magnet preserve the settings; different videos keep separate settings.
Embedded restoration waits for track enumeration and matches track descriptions
when native IDs change. External subtitles reload directly from their saved URL;
an unavailable subtitle keeps the saved choice and offers a retry in the sheet.
Late downloads cannot override a newer track selection or a replacement player.

The OpenSubtitles/web overlay previously ignored the timing adjustment. Its cue
lookup now applies the saved delay: -4 seconds brings subtitles forward by four
seconds, and +4 seconds displays them four seconds later.

## Verification

- `npm run test:video-preferences`: storage round trips, corrupt/unavailable
  storage, video isolation, changed/ambiguous track IDs, and actual cue timing.
- `npm run smoke:video-preferences`: real React controls with a deterministic
  native bridge; choose an external subtitle, adjust it to -4 seconds, close and
  reload the WebView, then verify automatic subtitle/audio restoration. Also
  covers Off, delayed embedded enumeration, episode isolation, and a subtitle
  download completing after player replacement.
- Existing native-controls layout smoke, 48 native/player contract checks,
  TypeScript check, and the mobile production build passed.

Native device playback remains to be checked on a phone; this Linux environment
has no Xcode/iOS runtime or Android SDK. Preferences are device-local and do not
sync between phones or survive clearing app storage.
