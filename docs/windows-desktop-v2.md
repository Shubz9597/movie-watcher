# Windows desktop with a Version 2 server

The Windows/Electron client can connect to a Docker-hosted Version 2 server on
this PC or to an existing LAN/Tailscale homeserver. These choices share one
saved server origin. The client does not start, stop or configure external
server services. MPV playback remains local to Windows.

See [the bundled setup guide](../electron-app/desktop-server-guide.html) for
the complete Windows Docker Compose commands and connection troubleshooting.

## Install and connect

1. Build from the repository root: `cd electron-app`, then `npm ci` if needed,
   then `npm run build`. The Windows native binding and MPV DLL must be present
   (see `electron-app/README.md` for native build prerequisites).
2. Run `electron-app/release/TorWatch Setup 2.0.1.exe`.
3. Choose **Server on this PC** for a separately started Docker stack, or
   **Homeserver** for another machine. Enter the base gateway URL, including
   its port if needed. A local server defaults to `http://127.0.0.1:8080`.
4. Test and save. The client checks `/readyz` and `/v1/version` before writing
   configuration and restarts to apply it consistently to every desktop path.

For source development of the external-server desktop, run
`npm run build:renderer` followed by `npm run electron`; this mode uses the
production renderer with an exact CSP for the saved server. Legacy managed
development continues to support `npm run dev` and Vite hot reload.

## Configuration and ownership

- `%APPDATA%/TorWatch/desktop-server.json` stores `{ mode, origin }` and an optional
  `progressSubjectId` for linking the phone's viewing profile. No server
  credentials are copied to the client. Settings are written atomically only
  after a successful readiness/protocol check. A failed edit keeps the prior
  connection. Corrupt saved settings return to setup.
- Saving restarts Electron, stopping playback first and recreating main-process
  controllers and renderer stores together. Library/watch state remains owned
  by the selected server. Closing an external-server desktop leaves that server
  running, even when its Docker stack is on this PC.
- The desktop renderer retains its `file://` / `Origin: null` CORS contract.
  Its HTML shell is generated under userData with the exact selected server
  in `connect-src` and `media-src`; packaged assets remain read-only in app.asar.
  An explicit server allowlist must include `null` without removing phone origins.
- If an existing managed installation has no desktop-server.json, its prior
  startup behavior remains available. Settings offers the new connection flow
  and a link to its existing built-in setup. Switching to V2 stops only the
  former app-owned runtime during the relaunch.
- Desktop packaging sets Windows release metadata to `2.0.1` independently of
  package.json's mobile version. The Capacitor builds, native phone code, mobile
  entries, shared connection logic and server implementation are unchanged.
- iPhone native offline downloads are outside this desktop connection change.

## Verification

Run `npm run test:desktop-connection`, `npm test`, `npx tsc --noEmit`, and the
desktop connection smoke harness after building the renderer. The desktop
smoke uses an isolated profile and a test HTTP server; it does not change
your installed configuration or contact your homeserver.

### Verified on 14 October 2026

- Existing regression suite: 239 passed. Desktop connection suite: 8 passed.
- TypeScript check, Windows renderer build and mobile web build passed.
- Real source Electron startup: both modes, invalid URL preservation, settings
  save and actual app relaunch passed with an isolated profile.
- Real packaged executable: the same checks passed before generating
  `release/TorWatch Setup 2.0.0.exe`. The package verifier checked all relative
  main-process imports, the setup guide, and Windows version metadata; the
  missing `backend-origin.mjs` crash is fixed.
- BFF catalog evidence is stub-backed. Main-process buffer, resume and progress
  routing used real HTTP against an isolated server. These checks do not claim
  live homeserver, live provider/torrent playback or a newly deployed Docker
  server on Windows.
- Git diff confirms no changes under `ios/`, `android/`, `src/mobile/`,
  `src/browser/`, `src/lib/`, `torrent-streamer/`, or `native/`. Mobile/Capacitor
  build command strings and package version are unchanged.
- Screenshots and packaged smoke results: `electron-app/release/desktop-v2-smoke/`.

### Live homeserver follow-up

After reconnecting this Windows PC to its existing Tailscale session, the
user-supplied homeserver passed readiness and protocol checks. Its live catalog
returned 40 titles with `Access-Control-Allow-Origin: null`.

An isolated packaged Version 2 desktop then rendered real catalog titles and
returned real Interstellar search results. Library overview/membership reads
also returned HTTP 200. No library or progress writes were performed. Live
source selection and video playback were not exercised in this read-only check.
Results and screenshots are in `electron-app/release/homeserver-check/`.

Repeat with `node scripts/desktop-homeserver-check.mjs <origin> <TorWatch.exe>`.
This uses a temporary profile and leaves the installed app settings untouched.

### Version 2.0.1, 15 October 2026

- Homeserver is the default choice. Its optional **Link Continue Watching from
  your phone** field accepts the phone's existing `mw_device_id`. The shared
  library uses the server database, but `/v1/continue` and progress rows are
  scoped by `subjectId`; the same URL alone does not select the phone's history.
  Desktop linking aliases only its own viewing profile and preserves its
  original ID for unlinking. Each desktop retains a separate stable writer ID.
- To read that value from an inspectable iPhone development build, enable Web
  Inspector on the phone, connect it to the development Mac, open Safari's
  Develop menu, and inspect the TorWatch WebView. Run
  `localStorage.getItem('mw_device_id')` in its console. Paste the result into
  desktop connection settings. See [WebKit's inspector instructions](https://webkit.org/web-inspector/enabling-web-inspector/).
  This does not require changing or rebuilding phone code. The actual phone's
  ID and a real playback handoff remain pending; synthetic profile tests do
  not establish that its existing records have been linked.
- Desktop skip times now come from the selected server's `/skip-segments`,
  with matching anime/TV identity and one delayed retry for incomplete detection.
  A read-only request to the live homeserver returned the expected Dragon Ball
  Z Kai episode 21 intro at 25–112 seconds and credits at 1290.049–1351.949.
- Desktop progress now includes `clientId`, a per-play `sessionId` and increasing
  `seq`. A throwaway local PostgreSQL stack passed desktop-to-phone and
  phone-to-desktop resume contract checks, stale-sequence rejection, intentional
  rewind, and profile isolation. These tests wrote no homeserver progress.
- Existing regression suite: 239 passed; desktop connection/playback suite:
  13 passed. TypeScript, desktop renderer and mobile web builds passed. The
  executable extracted from the final installer passed first-run connection,
  invalid-edit preservation, real relaunch, both modes and profile unlinking.
  It also rendered the live homeserver catalog and Interstellar search results
  through Tailscale with no renderer errors. Live video playback was not tested.
- `TorWatch Windows 2.0.1.zip` includes the installer, checksums and a standalone
  `LocalServer` package. Its extracted backend source built successfully in
  Docker and all five services became healthy on isolated test ports. The
  readiness/version API returned 2.0.1. All 269 included file checksums matched;
  runtime configuration, database and personal keys were excluded.
- Local stack verification deliberately omitted a TMDb key; it establishes
  service startup and database contracts, not live catalog/provider playback.
  Recipients must supply their own TMDb key. Existing Gluetun was preserved.
- Phone native/shared sources, backend Go sources, the mobile package version
  and mobile/Capacitor build commands remain unchanged. The installed desktop
  is upgraded only when the user runs the new installer.
