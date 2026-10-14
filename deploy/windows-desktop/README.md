# TorWatch local server for Windows

Use **Homeserver (recommended)** in the Windows app for your phone's shared
library. Link its existing viewing profile in desktop setup for the same watch
progress; the current API keys progress by profile as well as episode. Run this local server only when you
want an independent installation, for example when sharing TorWatch with
someone else. It has its own database and does not mirror your homeserver.

## Start

1. Install Docker Desktop and start its Linux engine.
2. Extract the complete TorWatch Windows ZIP. Install the desktop EXE.
3. Open PowerShell in the ZIP's `LocalServer` directory and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-TorWatchServer.ps1
```

The starter asks for your own TMDb v3 API key and an optional OpenSubtitles
API key, generates a database password, builds the included backend source,
and starts the five services. Node.js, Go and FFmpeg need not be installed on
Windows: the server image builds Go and contains FFmpeg/FFprobe.

Wait for `Server ready: http://127.0.0.1:8080`. In the desktop app choose
**Server on this PC**, enter that address, test and save. The first build needs
internet access to download Docker images and Go dependencies.

The startup can take several minutes on a fresh system. If it fails, run the
same command again after addressing the reported Docker/network issue.

## Existing Docker containers

The starter uses its own Compose project, `torwatch-local`. It does not adopt,
remove or reconfigure an existing Gluetun container. Gluetun is a network/VPN
service, not the TorWatch backend or database. The default local package uses
the host's normal route. Configure optional proxies separately if required.

The gateway binds only to `127.0.0.1:8080`; Prowlarr administration is on
`127.0.0.1:19696`. PostgreSQL, the backend and FlareSolverr have no published
ports. Choose unused ports during the first start if necessary:

```powershell
.\Start-TorWatchServer.ps1 -Port 8081 -AdminPort 19697
```

Saved port/project values are reused on subsequent starts. The private
configuration and persistent data default to `%LOCALAPPDATA%\TorWatchLocalServer`.
Change their location on first start with `-ConfigurationDirectory` and
`-DataDirectory`; use the same configuration directory for later commands.
Never share the generated configuration directory, `.env`, data or database.
The distributable ZIP contains source/build files and no personal credentials.

## Stop, status and restart

```powershell
.\Start-TorWatchServer.ps1 -Action Status
.\Start-TorWatchServer.ps1 -Action Stop
.\Start-TorWatchServer.ps1 -Action Start
```

Stop preserves data. Closing the desktop app also leaves this server running.
To rebuild after a source update, use `-Rebuild`. Your existing configuration
and database are preserved. Docker runs the backend's additive migrations.

To update credentials, edit the private `.env`, then run Start again so Compose
recreates the affected service. For noninteractive setup, set
`TORWATCH_LOCAL_TMDB_API_KEY` in the process environment and use `-NonInteractive`.
`-AllowDegradedCatalog` is for service verification without a provider key;
browsing will be unavailable until you supply a valid key.

## From the repository

The same starter also runs from `deploy/windows-desktop/`; it locates the
existing server Dockerfile/Compose files and `torrent-streamer/` source there.
The complete ZIP is produced by `npm run build:bundle` in `electron-app` after
building the Windows installer. The build copies only tracked backend source
needed by Go; repository secrets, runtime data and the author's homeserver URL
are not included.
