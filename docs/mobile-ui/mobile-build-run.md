# torWatch mobile build & run guide (Capacitor, M1.4)

The mobile app is a Capacitor shell around the SAME shared React UI as
desktop/browser. Production playback is native (iOS AVPlayer / Android
Media3) through the server playback-compatibility service
(`/v2/playback/*`, capability `playback.compat.v1`).

## Prerequisites

- Node 20+ (the repo pins exact Capacitor versions: 8.5.2 across
  `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, `@capacitor/ios`).
- Android: Android Studio / Android SDK (API 36) for builds and emulation.
- iOS: a Mac with Xcode for builds; a free Apple ID suffices for
  device installation to your own iPhone. No paid developer account needed
  for development.
- Backend: any TorWatch server; for LAN/tailnet access run staging with
  `-WithCapacitorOrigins` so the exact Capacitor web origins
  (`capacitor://localhost`, `https://localhost`) are allowlisted.

## Commands (from `electron-app/`)

```powershell
npm run mobile:build     # production mobile bundle -> dist-mobile + cap sync
npm run cap:open:android # open Android Studio (Windows/Linux/macOS)
npm run cap:open:ios     # open Xcode (macOS only)
npm run cap:sync         # re-sync web assets after web-side changes
```

`npm run build:mobile` builds the bundle without the sync step.

## Android (Windows)

1. Install the Android SDK (Android Studio), then set `ANDROID_HOME`.
2. `npm run mobile:build`
3. `npm run cap:open:android` → Run ▶ on a device/emulator, or:
   `gradlew -p android assembleDebug` → `android/app/build/outputs/apk/debug/`.

## iOS (Mac)

1. `npm run mobile:build` (works on any host; the projects are committed).
2. On the Mac: `npm run cap:open:ios`.
3. Select your team in Xcode (Signing & Capabilities of the App target),
   plug in the iPhone, Run.
4. BEFORE any release/signing: change `appId` in `capacitor.config.ts`
   (currently the development placeholder `com.torwatch.mobile`) — a store
   identity can never change after first publication.

## In-app configuration

First launch shows the server entry screen: enter the backend origin
(HTTPS recommended, e.g. a Tailscale Serve URL). The app probes `/readyz`
and `/v1/version` and shows reachable / incompatible / unreachable states.
Settings (gear icon) reopens that surface at `#settings`. Only the server
origin is stored on the device — never credentials, magnets, or tokens.

Playback capability is server-driven: if the backend does not advertise
`playback.compat.v1` (no FFmpeg configured server-side), the app reports it
honestly instead of pretending to play.

## Native sources

- iOS plugin: `ios/App/App/TorWatchNativePlugin.swift` (AVPlayer) +
  `MainViewController.swift` registration; already added to the Xcode
  project file.
- Android plugin: `android/app/src/main/java/com/torwatch/mobile/`
  (`TorWatchNativePlugin.kt`, `TorWatchPlaybackActivity.kt`) + registered in
  `MainActivity.kt`; Media3 pinned in `android/app/build.gradle`.
- Shared client: `src/platform/playback-session-client.ts` +
  `src/platform/native-playback-controller.ts` (tests:
  `scripts/characterization/playback-session-client.test.mjs`).
