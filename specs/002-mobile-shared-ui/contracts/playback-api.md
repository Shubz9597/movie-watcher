# Playback compatibility API (v1) — contracts/playback-api.md

Versioned contract for the shared mobile playback compatibility service
(feature 002 M1.3.2–M1.3.8). Consumed by BOTH future native clients (iOS
AVPlayer adapter, Android Media3 adapter) through the shared TypeScript
PlayerPort. Older servers do not serve these routes and do not advertise the
capability; older clients keep using `/stream` + `/v1/*` unchanged.

Capability: `playback.compat.v1` — advertised ONLY when both ffprobe and
ffmpeg are configured, executable, and self-identifying, and the internal
media source started. Absent capability ⇒ the routes do not exist (404).

## Security invariants (normative)

1. The client receives ONLY opaque cryptographically random identifiers
   (256-bit hex session IDs). No magnet, info-hash-bearing URL, or filesystem
   path ever appears in session views, playlists, segment URLs, subtitle URLs,
   error responses, or logs.
2. FFmpeg/ffprobe never receive magnets on their command lines: sessions are
   served by a loopback-only internal media source whose per-session 256-bit
   token URL is the process input. Threat boundary: the listener binds
   127.0.0.1 on an ephemeral port; only same-user host processes could
   observe the token, which is strictly narrower than magnet-in-argv (any
   host process). Tokens expire with the session and are revoked on delete.
3. All process execution uses argument arrays (no shell strings), bounded
   timeouts, and per-session cancellation that terminates only that session's
   process tree.
4. Cleanup removes ONLY the deleted/expired session's directory under the
   configured `PLAYBACK_DATA_ROOT`. Playlist/segment/subtitle paths are
   traversal-checked.
5. Wildcard CORS origins are never accepted; allowlisted origins get an exact
   echo plus POST/DELETE preflight support.

## Session lifecycle

### POST /v2/playback/sessions

Request:

```json
{ "cat": "movie|tv|anime|misc", "sourceId": "<40-char hex info hash>",
  "fileIndex": 0, "profile": "ios-avplayer|android-media3" }
```

201 response (SessionView):

```json
{
  "sessionId": "<opaque>",
  "mode": "direct|remux|transcode|unsupported",
  "reasonCode": "compatible|container_incompatible|video_codec_incompatible|audio_codec_incompatible|resolution_exceeds_profile|bitrate_exceeds_profile|hdr_unsupported|ffmpeg_missing|media_inspection_failed|malformed_source|transcode_capacity_exhausted|session_limit_exceeded",
  "message": "<human-safe copy>",
  "playbackUrl": "/v2/playback/sessions/{id}/media  (direct) | /v2/playback/sessions/{id}/master.m3u8  (remux/transcode)",
  "media": { "container": "…", "durationSec": 0, "width": 0, "height": 0,
             "video": {"codec":"…","profile":"…","level":"…","bitDepth":8},
             "audio": {"codec":"…","channels":2}, "bitrateBps": 0,
             "hdr": "hdr10?", "subtitleTracks": [{"index":0,"format":"srt","language":"eng"}],
             "fileIndex": 0 },
  "subtitles": [ {"id":"t0","language":"en","label":"…","default":false,
                  "forced":false,"url":"/v2/playback/sessions/{id}/subtitles/t0.vtt",
                  "origin":"embedded-sidecar|container-stream"} ],
  "expiresAt": "<RFC3339>", "profile": "ios-avplayer"
}
```

Errors: 400 invalid_request; 422 media_inspection_failed / malformed_source;
503 transcode_capacity_exhausted / session_limit_exceeded; 500 internal.
Error bodies never echo magnets, tokens, or paths.

### GET /v2/playback/sessions/{id}
Current SessionView; 404 when unknown/expired.

### DELETE /v2/playback/sessions/{id}
Stops the session's processes, revokes its token, deletes ONLY its directory.
Idempotent (204 whether or not the session existed).

### GET /v2/playback/sessions/{id}/media
DIRECT mode only: byte-range progressive delivery (206/Content-Range) of the
selected torrent file through a fresh internal reader. No magnet involved.

### GET /v2/playback/sessions/{id}/master.m3u8
HLS master (`application/vnd.apple.mpegurl`): one fMP4 variant
(`#EXT-X-STREAM-INF … hls/playlist.m3u8`) plus, when validated WebVTT tracks
exist, an `#EXT-X-MEDIA:TYPE=SUBTITLES` group.

### GET /v2/playback/sessions/{id}/hls/{file}
Variant playlist and segments from the session directory
(`.m3u8` → `application/vnd.apple.mpegurl`; segments → `video/mp4` fMP4).
Traversal-refusing.

### GET /v2/playback/sessions/{id}/subtitles/{track}.vtt
Validated WebVTT (`text/vtt; charset=utf-8`). A track is offered ONLY after
its VTT exists and passes the syntactic gate (WEBVTT header, no SRT comma
timestamps). ASS/SSA convert with documented styling loss; PGS/image
subtitles are unsupported (no offer) unless burned into a transcoded variant.

## Decision table

| Inspection | Client profile | Tools | Mode |
|---|---|---|---|
| MP4/fMP4 + H.264(/HEVC per profile)/AAC within bounds | compatible | any | direct |
| MKV/other container, codecs compatible | — | ffmpeg | remux (stream copy) |
| Audio codec alone incompatible | — | ffmpeg | remux, audio → AAC, video copy |
| Video codec or profile resolution/bitrate incompatible | — | ffmpeg | transcode → H.264/AAC, height ≤ both the profile and PLAYBACK_MAX_TRANSCODE_HEIGHT (default 1080) |
| HDR rejected by the client profile | — | any | unsupported (hdr_unsupported) until a verified HDR→SDR tone-map pipeline exists |
| Any conversion needed | — | no ffmpeg | unsupported (ffmpeg_missing) |
| No video stream / implausible metadata / probe failure | — | — | unsupported (malformed_source / media_inspection_failed) |

## Profiles

Shared contract data (`internal/playback/profiles.go`): `ios-avplayer`
(MP4-family, H.264/HEVC, AAC/ALAC/MP3, HLS fMP4, VTT, HDR accepted) and
`android-media3` (MP4/WebM, H.264/HEVC/VP9, AAC/Opus/MP3/Vorbis, HLS fMP4,
VTT, HDR rejected at baseline). Handlers never branch on platform names; the
planner consumes profile data only.

## External subtitles

The existing `/v1/subtitles/*` endpoints remain the OpenSubtitles ownership
path (unchanged, already SRT→VTT). Sessions offer embedded sidecars and
container-internal text streams; external results can be attached by native
clients as text tracks fetched through the existing endpoint. No duplicate
implementation is introduced.

## Lifecycle

Session TTL default 2h (env `PLAYBACK_SESSION_TTL`); a sweeper expires
sessions every TTL/4; startup sweep removes ALL directories under the data
root (sessions never survive restart — deterministic). Max active conversion
processes default 1 (`PLAYBACK_MAX_TRANSCODES`); the slot is released when
FFmpeg exits, while completed HLS files remain session-scoped. Excess creates return 503 with
`transcode_capacity_exhausted`. Max sessions default 8.

## Environment (names only — values are operator-provided)

`FFMPEG_PATH`, `FFPROBE_PATH`, `PLAYBACK_DATA_ROOT`,
`PLAYBACK_MAX_TRANSCODES`, `PLAYBACK_SESSION_TTL`, `PLAYBACK_PROBE_TIMEOUT`,
`PLAYBACK_MAX_TRANSCODE_HEIGHT`, `PLAYBACK_MAX_SESSIONS`,
`TORWATCH_PLAYBACK_FIXTURE_ROOT` (VALIDATION ONLY — when set, sessions
resolve media from direct children of this directory; empty in production).

## Not claimed by this contract

- No 4K software transcoding claim (bounded ≤1080p fallback by default).
- No Radxa/ARM64 transcoding performance claim (hardware evidence pending).
- No iPhone/Android device results (M1.3 native gates remain open).
