# TorWatch Windows installer

## Build

From the repository root, run:

```powershell
.\package.ps1
```

The build compiles `torrent-streamer/cmd/vod` into `torrent-streamer/bin/torWatcher.exe`, builds the Vite renderer, and creates the NSIS installer in the ignored root `package/` directory.

The installer includes the TorWatch Electron renderer, embedded MPV integration, Go backend, and Docker Compose definition. End users do not need Go, Node.js, or the source repository.

## First launch

Docker Desktop must be installed once. TorWatch then asks for:

- A persistent storage folder.
- A TMDb API key or access token.
- An OpenSubtitles API key and, optionally, an OpenSubtitles user token.
- Optional WireGuard credentials for an embedded Gluetun VPN. Leave them blank to use Docker's normal route, including a compatible system-wide VPN.

For a new installation, TorWatch generates the PostgreSQL password. For an existing installation, select the existing `data` folder and expand **Existing installation** to enter the PostgreSQL username and password that initialized that database. Existing Prowlarr configuration and watch history are then retained.

If Prowlarr is empty, TorWatch adds a starter set of public indexers on first startup. Existing indexers are preserved. Advanced changes are available from **Settings > Search sources > Open Prowlarr** or at `http://127.0.0.1:9696`; see `docs/prowlarr-indexers.md`. Prowlarr's generated API key is read directly from its persistent configuration and is never exposed to the renderer.

To reopen the setup screen later, run the installed executable with `--setup`.
The same screen is available from the settings button in the TorWatch header.

Before saving a replacement configuration, TorWatch verifies storage access,
TMDb authentication, optional OpenSubtitles authentication, Docker readiness,
the VPN-backed Compose services, and the bundled Go backend health endpoint.
The app can only be opened after all required checks pass. If testing an update
fails, the previously saved configuration is restored.

## Normal startup

The TorWatch desktop shortcut starts Electron. Electron starts or waits for Docker Desktop, runs the Compose stack idempotently, starts the bundled `torWatcher.exe` backend without a console window, waits for `/healthz`, and then opens the main UI. When TorWatch exits, it stops the backend and its Compose containers while preserving their data and leaving Docker Desktop open.

Runtime settings and logs are stored in Electron's per-user application-data directory rather than inside the installation folder. TMDb, OpenSubtitles, VPN, and generated PostgreSQL credentials are kept in Electron's OS-backed encrypted secret store. The OpenSubtitles cache is created under the selected storage folder at `subtitles/`.

## Distribution notes

- The generated installer is currently unsigned. Sign the executable and installer with a trusted Windows code-signing certificate before public distribution to avoid SmartScreen warnings.
- Docker Desktop remains an external prerequisite and has its own system requirements and licensing terms.
- There is one Prowlarr container and one FlareSolverr container in both modes. When WireGuard credentials are saved, they use Gluetun's HTTP proxy and Gluetun also supplies the TMDb fallback route. Without credentials, TorWatch creates Gluetun but leaves it stopped, and the same search containers use Docker's normal outbound route. The bundled Go torrent process runs on the Windows host; users who require torrent peer traffic to use a VPN must use a system-wide VPN.
- Replace floating container tags with tested image digests as part of a repeatable public release process.
