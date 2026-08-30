# Tor Watch

Tor Watch is a multi platform application for discovering and watching movies, series, and anime.

## First-time setup

Allow about 10 minutes for the first setup. Docker Desktop may take longer the first time it opens.

### 1. Prepare the prerequisites

- Windows 10 or 11 on x64.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) is needed for playback services. You can install it later from torWatch Settings.
- One credential from [TMDb API settings](https://www.themoviedb.org/settings/api). torWatch accepts either an API Read Access Token or an API Key.
- Optional WireGuard details from your VPN provider. Without them, Prowlarr and FlareSolverr use the normal Docker network, including any compatible system-wide VPN route. Use the [WireGuard provider guide](https://github.com/qdm12/gluetun-wiki/tree/main/setup/providers) to configure the embedded Gluetun tunnel.
- Optional: an API key from the [OpenSubtitles consumer dashboard](https://www.opensubtitles.com/en/consumers).

End users do not need Node.js, Go, PostgreSQL, Prowlarr, or MPV installed separately.

### 2. Install and open torWatch

Run `torWatch Setup 1.2.0.exe`, finish the Windows installation, and open the torWatch desktop shortcut. Windows SmartScreen may warn because the current development installer is unsigned.

### 3. Enter the setup details

1. Choose an application storage location.
2. Paste either your TMDb API Read Access Token or API Key.
3. Optionally enter an OpenSubtitles API key.
4. Optionally enter the VPN provider, WireGuard private key, WireGuard address, and preferred city. Leave these blank to use the computer's normal/system-VPN route.

### 4. Start torWatch

Select **Start torWatch**. TMDb is the only required connection. If an optional playback connection needs attention, torWatch shows the relevant action and still lets you continue browsing.

Docker Desktop and VPN details can be added later from Settings.

### 5. Manage search sources (optional)

When Prowlarr is completely empty, torWatch adds a starter set of public movie, series, and anime indexers during the first successful start. Existing Prowlarr indexers are never changed or replaced.

For advanced control, open **Settings > Open Prowlarr** or visit [http://127.0.0.1:9696](http://127.0.0.1:9696) while torWatch is running. See the [Prowlarr indexer guide](docs/prowlarr-indexers.md) to add, remove, enable, disable, or test sources.

## Changing setup later

Use the settings button in the torWatch header to open **torWatch settings**. Update a connection or storage location, then select **Apply changes**. The settings screen can also be opened from a terminal with:

```powershell
torWatch.exe --setup
```

If a replacement configuration fails, torWatch restores the previously saved configuration.

Closing torWatch stops its `torWatcher.exe` backend and the torWatch Docker containers. Container data is preserved, and Docker Desktop itself remains open. The services start again automatically the next time torWatch opens.

## Diagnostic logs

torWatch keeps separate diagnostic files for the desktop UI and Go backend. On Windows, open them with:

```powershell
explorer "$env:APPDATA\torWatch\logs"
```

- `frontend.log` contains Electron and renderer warnings, errors, crashes, source locations, and stack traces.
- `backend.log` contains every backend category with UTC timestamps and Go source locations. The console allow-list does not remove records from this file.
- `errors.log` is the error-only JSONL index. Each entry has a `correlation_id`, stack, diagnostic session, and `source_log` pointing to the matching full-context record.
- `.1`, `.2`, and `.3` files are rotated history. Frontend logs rotate at approximately 5 MB; backend and error-index logs rotate safely on the next new backend start after reaching that size.

When reporting a failure, reproduce it once, close torWatch, and share `errors.log` first plus the `source_log` named by its relevant entry. If the correlation ID is in rotated history, include that file too. Credential-like values and magnet links are automatically redacted, but review logs before sharing them publicly. See the [diagnostic coverage audit](docs/diagnostic-coverage.md) for the complete capture matrix and hard limits.

## Credentials and environment files

The installed application does not ship or require repository `.env` files. TMDb, OpenSubtitles, VPN, and generated PostgreSQL credentials are stored using Electron's OS-backed encrypted storage and are injected only into the processes that need them.

Repository infra files are for source development or a small home-network deployment. Do not distribute or commit them. The root `docker-compose.yml` is the single Compose manifest for local development, packaged Electron runtime resources, and small deployments. Electron injects values at runtime; manual Docker Compose runs can use the three readable env files under `infra/`.

Create local or deployment values from the tracked examples:

```powershell
Copy-Item infra\gluetun.env.example infra\gluetun.env
Copy-Item infra\postgres.env.example infra\postgres.env
Copy-Item infra\prowlarr.env.example infra\prowlarr.env
Copy-Item infra\proxy.env.example infra\proxy.env
docker compose --profile embedded-vpn up -d
```

For the normal or system-VPN route, do not create `infra/proxy.env`; use `docker compose up -d`. This starts Prowlarr, FlareSolverr, and PostgreSQL without starting Gluetun.

For SBC/home-network deployment, keep the same three-file shape, set a strong PostgreSQL password, set the real WireGuard values, and choose host overrides deliberately. By default, mapped ports bind to `127.0.0.1`; set `MW_BIND_HOST=0.0.0.0` in the shell or a root `.env` only when you want to expose mapped ports to the network/firewall.

The `infra/` directory is ignored except for `infra/*.env.example`, so local secrets stay out of git. After the installed setup has been verified, local infra files can be removed if the repository will no longer be used to run the services directly.

## Building from source

Prerequisites for developers are Node.js, npm, Go, Docker Desktop, and the native MPV SDK files already expected by `electron-app/package.json`.

```powershell
.\package.ps1
```

The script installs Electron dependencies when needed, builds the backend and
renderer, and generates the NSIS installer under the ignored root `package/`
directory.

For development:

```powershell
cd electron-app
npm run dev
```

The Go service can be tested independently with:

```powershell
cd torrent-streamer
go test ./...
```

## Runtime architecture

- Electron owns the catalog UI, setup experience, and embedded MPV control.
- Go owns torrent search, source selection, streaming, subtitles, buffering, and watch progress.
- Docker Compose owns Gluetun, Prowlarr, FlareSolverr, and PostgreSQL.
- PostgreSQL also stores the IMDb rating cache. After PostgreSQL starts for the first time, the Go backend imports IMDb's official non-commercial `title.ratings.tsv.gz` dataset in the background. It checks for an update daily on later app starts and keeps the last successful import if an update fails. The legacy `data/imdb-ratings.db` SQLite file is not used by the Electron app.
- OpenSubtitles requests are made by Go; Electron only displays and loads the returned subtitle tracks.

When WireGuard credentials are saved, the single Prowlarr and FlareSolverr instances use Gluetun's HTTP proxy, which also provides TMDb's fallback route. Without credentials, torWatch creates Gluetun but leaves it stopped, while those same search-service containers use Docker's normal outbound route, which may follow a compatible system-wide VPN. The bundled Go torrent process always runs on the Windows host, so users who require peer traffic to pass through a VPN must use a system-wide VPN.
