# Movie Watcher Desktop App

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
├── main.js          # Electron main process
├── preload.js       # Preload script (exposes safe APIs)
├── index.html       # Main UI
├── renderer.js      # Frontend logic
├── package.json     # Dependencies and build config
├── README.md        # This file
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



