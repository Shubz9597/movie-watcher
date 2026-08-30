# TorWatch Desktop App

Desktop application with embedded MPV player for streaming movies and TV shows.

## Setup Instructions

### 1. Get MPV DLLs

Download MPV for Windows and extract the DLL:

1. Go to https://mpv.io/installation/
2. Download the Windows build (or get from https://github.com/mpv-player/mpv/releases)
3. Extract `libmpv-2.dll` (or `mpv.dll`) 
4. Place it in: `electron-app/mpv-sdk/libmpv-2.dll`

**Required DLL:** `libmpv-2.dll` (or `mpv.dll` or `libmpv.dll`)

The Rust module will look for these DLL names in this order:
- `libmpv-2.dll`
- `mpv.dll`
- `libmpv.dll`

### 2. Rebuild Rust Native Module (if needed)

If the native module needs to be rebuilt or you're on a different platform:

```bash
cd native/mpv-embed
npm install
npm run build
```

This creates `index.node` which will be used by Electron.

**Requirements for building:**
- Rust toolchain (install from https://rustup.rs/)
- Node.js 18+
- `@napi-rs/cli` (installed via npm install)

### 3. Install Dependencies

```bash
cd electron-app
npm install
```

### 4. Run the App

Make sure your backends are running:
- Next.js server on `http://localhost:3000`
- Go backend on `http://localhost:4001`

Then run:
```bash
npm run dev
```

### 5. Build for Distribution

```bash
npm run build
```

This will create an installer in the `dist/` directory.

## Requirements

- **Node.js 18+**
- **Rust toolchain** (for rebuilding native module if needed)
- **MPV DLL** (`libmpv-2.dll`) - Download from https://mpv.io/installation/
- **Next.js backend** running on `http://localhost:3000`
- **Go backend** running on `http://localhost:4001`

## File Structure

```
electron-app/
├── main.js          # Electron main-process bootstrap
├── electron/        # Main-process support modules
│   ├── diagnostics/
│   ├── config/
│   ├── ipc/
│   ├── playback/
│   ├── preloads/
│   ├── runtime/
│   └── windows/
├── src/             # React renderer entries, including setup/startup/player controls
├── package.json     # Dependencies and build config
└── mpv-sdk/         # Place MPV DLL here
    └── libmpv-2.dll
```

## API Endpoints Used

### Next.js API (`http://localhost:3000/api`)
- `GET /tmdb/movies` - Get movies (trending, search, etc.)
- `GET /torrents/movie` - Get torrents for a movie
- `POST /torrents/resolve` - Resolve torrent to stream URL
- `GET /tmdb/tv/shows` - Get TV shows
- `GET /torrents/tv` - Get torrents for TV shows
- `GET /continue` - Get continue watching list

### Go Backend (`http://localhost:4001`)
- `GET /stream` - Stream video content
- `POST /v1/session/start` - Start playback session
- `POST /v1/session/heartbeat` - Update playback progress
- `POST /v1/session/ended` - End playback session
- `GET /buffer/info` - Get buffer information
- `GET /subtitles/list` - Get available subtitles
- `GET /subtitles/torrent` - Serve a subtitle included in the selected torrent
- `GET /subtitles/external` - Download and normalize an OpenSubtitles fallback

### Subtitle configuration

Subtitle discovery is owned by the Go backend. It checks matching text subtitle
files in the selected torrent first and only calls OpenSubtitles when none are
available. Configure the backend process (for example in
`torrent-streamer/.env`) with:

```env
OPENSUB_API_KEY=your_opensubtitles_api_key
```

Packaged installations collect this key in the first-run setup instead of
shipping an `.env` file. The key is stored with the application's encrypted
runtime secrets and passed only to the bundled Go backend. The legacy
`OPENSUBTITLES_API_KEY` name is accepted during local migration, but
`OPENSUB_API_KEY` is the canonical backend variable.

`OS_KEY` is also accepted as an alias for `OPENSUB_API_KEY`. The optional
language preference belongs in `electron-app/.env` (or the Electron config)
and defaults to `en,hi`:

```env
SUBTITLE_LANGS=en,hi
```

For personal-account safety, the Go backend caches identical searches for 30
minutes and downloaded subtitle content for 24 hours, serializes download-link
generation, spaces OpenSubtitles API requests by at least 300 ms, and retries a
single `429 Too Many Requests` response after the provider's requested delay.

## Features

- Browse trending movies
- Search movies and TV shows
- Play videos using embedded MPV player
- Full MPV controls (play, pause, seek, volume, mute)
- Calls all backend APIs for streaming

## Troubleshooting

### MPV DLL not found
- Make sure `libmpv-2.dll` is in `electron-app/mpv-sdk/`
- Or place it in the same directory as the Electron executable
- Or add it to your system PATH

### Native module not found
- Rebuild the module: `cd native/mpv-embed && npm run build`
- Make sure you have Rust installed
- Check that `index.node` exists in `native/mpv-embed/`

### Backend connection errors
- Ensure Next.js is running on port 3000
- Ensure Go backend is running on port 4001
- Check firewall settings

### Video not playing
- Check that MPV DLL is correct version
- Verify stream URL is accessible
- Check console for MPV initialization errors



