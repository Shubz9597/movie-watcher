# Electron Refactor Handoff

Use this as the quick context file before making Electron app changes.

## Current Direction

The Electron app is being prepared as the first major deployable release. There is no production install to preserve, so structural cleanup is allowed, but every move should be verified with TypeScript, renderer build, syntax checks, and smoke tests where relevant.

The long-term goal is a professional Electron layout that can later support macOS and Linux packaging without another large cleanup pass.

## Current Structure

- `electron-app/main.js` is the main-process composition root. Keep it small.
- `electron-app/electron/` owns main-process modules:
  - `config/` for app config, resources, setup validation, guide URLs.
  - `diagnostics/` for logging.
  - `ipc/` for IPC registration.
  - `playback/` for MPV and playback behavior.
  - `preloads/` for context bridge scripts.
  - `runtime/` for startup/setup/runtime orchestration.
  - `windows/` for BrowserWindow factories and window controllers.
- `electron-app/src/` owns React renderer surfaces.
- `electron-app/src/player-controls/` is the React player controls overlay.
- `electron-app/src/setup/` is the React setup/settings/TMDb gate surface.
- `electron-app/src/startup/` is the React startup splash surface.
- Root HTML files like `controls.html`, `setup.html`, and `startup.html` should not come back. Renderer HTML entries belong in `electron-app/src/` and build to `electron-app/dist/`.

## Build And Runtime Rules

- Vite has multiple HTML entries in `electron-app/vite.config.js`:
  - `src/index.html`
  - `src/player-controls.html`
  - `src/setup.html`
  - `src/startup.html`
- Electron should load Vite dev URLs in development and `dist/*.html` in packaged mode.
- Packaged files in `electron-app/package.json` should include built renderer outputs from `dist/`, not root HTML files.
- `electron-app/release/` is generated output for installers, unpacked app builds, and smoke screenshots. It can be deleted and should stay out of source control.
- `electron-app/dist/` is generated renderer output. Do not edit it manually.

## Quick Resolutions

- If setup/startup/player-controls looks broken after a refactor, run `npm run build:renderer` first and check the built `dist/*.html` entries exist.
- If a packaged window is blank, check the relevant `loadFile` path points to `dist/<entry>.html`.
- If dev mode is blank, check the matching dev URL:
  - `http://localhost:5173/player-controls.html`
  - `http://localhost:5173/setup.html`
  - `http://localhost:5173/startup.html`
- If TypeScript complains about preload globals, add local bridge types in the renderer feature folder instead of importing Electron into renderer code.
- If a page needs Electron APIs, keep the IPC contract in preload and create a small renderer `bridge.ts`.
- If UI smoke tests fail inside the sandbox with Chromium cache/GPU errors on Windows, rerun the smoke command outside the sandbox.
- If consumer-facing setup copy mentions internal services such as Prowlarr, Docker internals, PostgreSQL, or Go backend, prefer friendlier product language unless the screen is explicitly an advanced/admin view.
- If a generated output folder appears in review, prefer ignoring/removing it rather than committing it.

## Verification Checklist

Run the relevant subset after changes:

```powershell
npx tsc --noEmit
npm run build:renderer
node --check main.js
Get-ChildItem -Recurse -File electron -Include *.js,*.cjs | ForEach-Object { node --check $_.FullName }
npm run test:skip-segments
npm run test:diagnostics
```

For UI changes, build first, then run smoke checks:

```powershell
$env:TORWATCH_SMOKE_PAGE='setup'; npm run smoke:ui
$env:TORWATCH_SMOKE_PAGE='startup'; npm run smoke:ui
$env:TORWATCH_SMOKE_PAGE='controls'; npm run smoke:ui
npm run smoke:embedded
```

## Recently Completed

- Moved player controls from root `controls.html` into React under `src/player-controls/`.
- Moved setup and startup from root HTML files into React under `src/setup/` and `src/startup/`.
- Updated Vite to build all renderer HTML entries.
- Updated Electron window loading to use Vite dev URLs in development and built `dist/*.html` in packaged mode.
- Removed legacy root `controls.html`, `setup.html`, and `startup.html`.
- Removed unnecessary environment variable deletion logic from Electron setup/config paths.
- Kept `main.js` as a smaller driver/composition root by moving main-process behavior into `electron/` modules.
