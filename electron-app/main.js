import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file if it exists
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const result = dotenv.config({ path: envPath });
  if (result.error) {
    console.error("[Config] Error loading .env:", result.error);
  } else {
    console.log("[Config] Loaded .env file from:", envPath);
    console.log("[Config] Found keys:", Object.keys(result.parsed || {}).join(", "));
  }
} else {
  console.warn("[Config] .env file not found at:", envPath);
  console.warn("[Config] Please create .env file with TMDB_API_KEY, TMDB_ACCESS_TOKEN, PROWLARR_URL, PROWLARR_API_KEY");
}

// Fix DPI scaling on Windows
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('high-dpi-support', '1');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

let mainWindow = null;
let mpvWindow = null;
let mpvControlsWindow = null;
let mpvNative = null;
let mpvHandle = null;
let mpvWid = null;
let mpvInitialized = false;
let mpvInitPromise = null;
let mpvPlayPromise = null;
let currentStreamUrl = null;
let currentMagnet = null; // Store original magnet URI separately from stream URL
let bufferPollInterval = null; // Interval for polling buffer info and forwarding to controls
const VOD_BASE = "http://localhost:4001";

// Load MPV native module
async function loadMpvNative() {
  const possiblePaths = [
    // Prefer the JS wrapper: it selects the correct platform-specific .node (and stays in sync with rebuilds)
    path.join(__dirname, "..", "native", "mpv-embed", "index.js"),
    // Direct platform build outputs (fallbacks)
    path.join(__dirname, "..", "native", "mpv-embed", "index.win32-x64-msvc.node"),
    path.join(__dirname, "..", "native", "mpv-embed", "index.node"),
    path.join(__dirname, "mpv-embed.node"),
    path.join(process.resourcesPath, "mpv-embed.node"),
  ];

  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);

  for (const mpvPath of possiblePaths) {
    if (fs.existsSync(mpvPath)) {
      try {
        // Use createRequire for loading native bindings / CJS in ES modules
        mpvNative = require(mpvPath);
        console.log("[MPV] Native module loaded from:", mpvPath);
        return true;
      } catch (err) {
        console.warn("[MPV] Failed to load from", mpvPath, err.message);
      }
    }
  }
  console.error("[MPV] Native module not found!");
  return false;
}

// Initialize MPV - clean implementation
async function initializeMpv() {
  if (mpvInitPromise) return mpvInitPromise;

  // If previous windows/handles were destroyed, reset state so we can re-init cleanly.
  if (mpvWindow && mpvWindow.isDestroyed()) mpvWindow = null;
  if (mpvControlsWindow && mpvControlsWindow.isDestroyed()) mpvControlsWindow = null;
  if (!mpvHandle) mpvInitialized = false;

  if (mpvInitialized) return true;
  if (!mpvNative) {
    if (!(await loadMpvNative())) return false;
  }

  mpvInitPromise = (async () => {
    try {
    // Create MPV handle first
    mpvHandle = mpvNative.MpvHandle.create();
    console.log("[MPV] Handle created");

    // Create MPV window as standalone window (no parent for stable HWND)
    mpvWindow = new BrowserWindow({
      // No parent - standalone window for stable HWND on Windows
      width: 1280,
      height: 720,
      show: false, // Hidden initially, will be shown when playing
      frame: false, // Frameless for seamless appearance
      transparent: false,
      backgroundColor: "#000000",
      skipTaskbar: false, // Show in taskbar during playback
      alwaysOnTop: false, // Not always on top - allows alt-tab and normal window management
      movable: true, // Explicitly allow window to be moved
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Load blank page
    await mpvWindow.loadURL("about:blank");
    
    // Wait for window to be fully ready
    await new Promise((resolve) => {
      if (mpvWindow.webContents.isLoading()) {
        mpvWindow.webContents.once("did-finish-load", () => {
          setTimeout(resolve, 200);
        });
      } else {
        setTimeout(resolve, 200);
      }
    });

    // Show window briefly to get valid HWND (required for MPV)
    mpvWindow.show();
    mpvWindow.focus();
    await new Promise(resolve => setTimeout(resolve, 200));

    // Get HWND - CRITICAL: must get this after window is ready and visible
    const handle = mpvWindow.getNativeWindowHandle();
    // On win32 x64, HWND is 64-bit. Keep it as BigInt to avoid precision loss.
    mpvWid = handle.readBigUInt64LE ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
    console.log("[MPV] HWND obtained:", mpvWid.toString());

    // Attach HWND BEFORE init (this is critical!)
    // Pass as decimal string to avoid JS Number precision loss on Win64.
    mpvHandle.attachHwnd(mpvWid.toString());
    console.log("[MPV] HWND attached");

    // Initialize MPV (this sets up the video output)
    mpvHandle.init({});
    console.log("[MPV] Initialized");

    // Hide window until playback starts
    mpvWindow.hide();

    // Set up window event handlers
    mpvWindow.on("closed", () => {
      // If user/OS closes the window, allow re-init on next play.
      mpvWindow = null;
      mpvInitialized = false;
      mpvHandle = null;
      mpvWid = null;
    });

    mpvWindow.on("resize", () => {
      if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
        mpvControlsWindow.setBounds(mpvWindow.getBounds());
      }
    });

    mpvWindow.on("move", () => {
      if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
        mpvControlsWindow.setBounds(mpvWindow.getBounds());
      }
    });

    mpvInitialized = true;
    console.log("[MPV] Initialization complete");
    return true;
    } catch (err) {
      console.error("[MPV] Initialization failed:", err);
      return false;
    } finally {
      mpvInitPromise = null;
    }
  })();

  return mpvInitPromise;
}

// Create main window
function createMainWindow() {
  try {
    console.log("[Main] Creating main window...");
    
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      x: 100, // Explicit position to ensure it's on screen
      y: 100,
      show: true, // Explicitly show the window
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    console.log("[Main] Main window created, loading content...");

    // In development, load from Vite dev server
    // In production, load from dist folder
    if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
      // Try to load from Vite, but don't fail if it's not ready
      mainWindow.loadURL('http://localhost:5173').catch((err) => {
        console.warn("[Main] Vite not ready yet, will retry:", err.message);
        // Retry after a delay
        setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL('http://localhost:5173').catch((e) => {
              console.error("[Main] Failed to load from Vite:", e.message);
            });
          }
        }, 2000);
      });
    } else {
      mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    
    // Handle window errors
    mainWindow.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
      console.error("[Main] Failed to load:", errorCode, errorDescription);
    });
    
    // Ensure window is visible and focused - multiple approaches
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    if (!mainWindow.isFocused()) {
      mainWindow.focus();
    }
    mainWindow.moveTop();
    
    // Also show after a small delay to ensure it's visible
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    }, 100);
    
    console.log("[Main] Main window shown and focused, visible:", mainWindow.isVisible());
  } catch (err) {
    console.error("[Main] Error creating main window:", err);
    throw err;
  }
}

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  console.error("[App] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[App] Unhandled rejection:", reason);
});

// Debug log bridge from renderer -> main (via preload debugLog)
ipcMain.on("debug:log", (_event, args) => {
  try {
    console.log("[Renderer]", ...(Array.isArray(args) ? args : [args]));
  } catch {
    console.log("[Renderer] (unserializable log)");
  }
});

// App lifecycle
app.whenReady().then(() => {
  console.log("[App] Electron app ready, creating main window...");
  
  // Create main window immediately - don't wait for MPV
  try {
    createMainWindow();
    console.log("[App] Main window created successfully");
  } catch (err) {
    console.error("[App] Failed to create main window:", err);
    // Try to show error dialog
    app.quit();
  }
  
  // Don't initialize MPV on startup - do it lazily when play is called
  // This prevents blocking the main window from showing

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}).catch((err) => {
  console.error("[App] Error in whenReady:", err);
});

app.on("window-all-closed", () => {
  if (mpvHandle) {
    try {
      mpvHandle.shutdown();
    } catch (err) {
      console.error("[MPV] Shutdown error:", err);
    }
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Create controls overlay window - clean implementation
function ensureControlsWindow() {
  if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) return;
  if (!mpvWindow || mpvWindow.isDestroyed()) return;

  const bounds = mpvWindow.getBounds();
  
  mpvControlsWindow = new BrowserWindow({
    parent: mpvWindow, // Child window stays on top
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: true, // Required for controls.html to use require("electron")
      contextIsolation: false, // Required for controls.html
    },
  });

  const controlsPath = path.join(__dirname, "controls.html");
  mpvControlsWindow.loadFile(controlsPath).catch((err) => {
    console.error("[MPV] Failed to load controls.html:", err);
  });
}

// Resolve source URL to stream URL
// Backend accepts both magnet URIs and HTTP URLs (Prowlarr) via the 'magnet' parameter
async function resolveStreamUrl(url, cat = "movie", fileIndex = 0) {
  // If it's already a stream URL, return it
  if (url && url.includes("/stream")) {
    return url;
  }

  // Build stream URL - backend accepts both magnet URIs and HTTP URLs (Prowlarr)
  // Use encodeURIComponent instead of URLSearchParams to preserve '+' characters
  // URLSearchParams encodes '+' as '+' which gets decoded as space on the backend
  if (url) {
    let streamUrl = `${VOD_BASE}/stream?cat=${encodeURIComponent(cat)}&magnet=${encodeURIComponent(url)}`;
    if (fileIndex > 0) {
      streamUrl += `&fileIndex=${fileIndex}`;
    }
    return streamUrl;
  }

  return url;
}

// IPC Handlers - clean implementation
ipcMain.handle("mpv:play", async (_event, payload) => {
  // Prevent duplicate play calls from racing and leaving windows hidden.
  if (mpvPlayPromise) return mpvPlayPromise;

  mpvPlayPromise = (async () => {
    try {
    console.log("[MPV] play handler called with payload:", payload);
    
    // Handle both object and string payloads
    let url, title, cat, fileIndex, magnet;
    if (typeof payload === "string") {
      url = payload;
      title = "Playing";
      cat = "movie";
      fileIndex = 0;
      magnet = null;
    } else if (payload && typeof payload === "object") {
      url = payload.url;
      title = payload.title;
      cat = payload.cat;
      fileIndex = payload.fileIndex;
      magnet = payload.magnet || null; // Extract magnet if provided
    } else {
      console.error("[MPV] Invalid payload:", payload);
      return { ok: false, error: "Invalid payload: expected object with url, title, cat, fileIndex" };
    }

    if (!url) {
      console.error("[MPV] No URL provided in payload");
      return { ok: false, error: "URL is required" };
    }

    console.log("[MPV] Extracted parameters:", { url, title, cat, fileIndex, magnet: magnet ? "provided" : "not provided" });

    // Store the source URL for backend API calls - backend accepts both magnets and HTTP URLs (Prowlarr)
    if (magnet) {
      currentMagnet = magnet;
      console.log("[MPV] Stored source URL for backend API calls:", magnet.substring(0, 50) + (magnet.length > 50 ? "..." : ""));
    } else if (url) {
      currentMagnet = url;
      console.log("[MPV] Using URL as source for backend API calls");
    } else {
      currentMagnet = null;
      console.warn("[MPV] No source URL available - backend API calls will fail");
    }

    // Ensure MPV is initialized (and recover if previous windows were destroyed)
    if (!mpvInitialized || !mpvHandle || !mpvWindow || mpvWindow.isDestroyed()) {
      console.log("[MPV] MPV not initialized, initializing now...");
      const ready = await initializeMpv();
      if (!ready) {
        console.error("[MPV] MPV initialization failed");
        return { ok: false, error: "MPV initialization failed" };
      }
      console.log("[MPV] MPV initialized successfully");
    }

    // Resolve source URL to stream URL
    const streamUrl = await resolveStreamUrl(currentMagnet || url, cat || "movie", fileIndex || 0);
    console.log("[MPV] Resolved stream URL:", streamUrl);
    currentStreamUrl = streamUrl;

    // Get main window bounds and position MPV window to match
    if (mainWindow && !mainWindow.isDestroyed()) {
      const mainBounds = mainWindow.getBounds();
      console.log("[MPV] Main window bounds:", mainBounds);
      
      // Position MPV window to match main window
      mpvWindow.setBounds({
        x: mainBounds.x,
        y: mainBounds.y,
        width: mainBounds.width,
        height: mainBounds.height,
      });
      
      // Re-verify HWND when showing window (in case it changed)
      const currentHandle = mpvWindow.getNativeWindowHandle();
      const currentWid = currentHandle.readBigUInt64LE 
        ? currentHandle.readBigUInt64LE(0)
        : BigInt(currentHandle.readUInt32LE(0));
      
      if (currentWid !== mpvWid) {
        console.log("[MPV] HWND changed, re-attaching:", currentWid.toString(), "was:", mpvWid.toString());
        mpvWid = currentWid;
        mpvHandle.attachHwnd(mpvWid.toString());
      }
      
      // Show MPV window
      mpvWindow.setTitle(title || "Player");
      mpvWindow.show();
      mpvWindow.focus();
      mpvWindow.moveTop();
      
      // Wait a bit for window to be fully visible
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Hide main window
      mainWindow.hide();
      console.log("[MPV] Main window hidden, MPV window shown");
    }

    // Load the video
    console.log("[MPV] Loading video URL...");
    mpvHandle.load(streamUrl);
    
    // Start playing
    mpvHandle.pause(false);
    console.log("[MPV] Video started");

    // Create and show controls overlay
    ensureControlsWindow();
    
    // Wait for controls to load
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      if (mpvControlsWindow.webContents.isLoading()) {
        await new Promise((resolve) => {
          mpvControlsWindow.webContents.once("did-finish-load", () => {
            setTimeout(resolve, 100);
          });
        });
      }
      
      // Position controls over video
      const mpvBounds = mpvWindow.getBounds();
      mpvControlsWindow.setBounds(mpvBounds);
      mpvControlsWindow.webContents.send("mpv:title", title || "Playing");
      
      // Send loading metadata to controls window
      if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
        const loadingMeta = {
          title: title || "Playing",
          year: payload.year ? Number(payload.year) : undefined,
          posterUrl: payload.posterUrl || undefined,
        };
        mpvControlsWindow.webContents.send("mpv:loadingMeta", loadingMeta);
        // Send initial loading state
        mpvControlsWindow.webContents.send("mpv:loadingState", {
          status: "connecting",
          percentage: 0,
        });
      }
      
      mpvControlsWindow.show();
      mpvControlsWindow.moveTop();
      
      // Keep focus on video window
      mpvWindow.focus();
      console.log("[MPV] Controls overlay shown");
      
      // Start polling buffer info and forwarding to controls window
      if (bufferPollInterval) {
        clearInterval(bufferPollInterval);
      }
      bufferPollInterval = setInterval(async () => {
        if (!mpvControlsWindow || mpvControlsWindow.isDestroyed() || !currentMagnet) {
          if (bufferPollInterval) {
            clearInterval(bufferPollInterval);
            bufferPollInterval = null;
          }
          return;
        }
        
        try {
          // Get buffer info from backend
          // Use encodeURIComponent to preserve '+' characters in magnet URIs
          const bufferResult = await fetch(
            `${VOD_BASE}/buffer/info?magnet=${encodeURIComponent(currentMagnet)}&cat=${encodeURIComponent(cat || "movie")}&fileIndex=${fileIndex || 0}`
          );
          
          if (bufferResult.ok) {
            const bufferData = await bufferResult.json();
            const contiguousAhead = bufferData.contiguousAhead || 0;
            const targetBytes = bufferData.targetBytes || 0;
            const fileLength = bufferData.fileLength || 0;
            
            // Calculate buffer percentage
            let percentage = 0;
            let status = "connecting";
            
            if (targetBytes > 0 && fileLength > 0) {
              percentage = Math.min(100, (contiguousAhead / targetBytes) * 100);
              if (percentage >= 50) {
                status = "ready";
              } else if (percentage >= 10) {
                status = "buffering";
              } else {
                status = "connecting";
              }
            } else if (targetBytes > 0) {
              percentage = Math.min(100, (contiguousAhead / targetBytes) * 100);
              status = percentage >= 10 ? "buffering" : "connecting";
            }
            
            // Forward to controls window
            if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
              mpvControlsWindow.webContents.send("mpv:loadingState", {
                status,
                percentage,
              });
            }
          }
        } catch (err) {
          console.error("[MPV] Buffer polling error:", err);
        }
      }, 1000);
    }

    return { ok: true, streamUrl };
    } catch (err) {
      console.error("[MPV] Play error:", err);
      return { ok: false, error: err.message || String(err) };
    } finally {
      mpvPlayPromise = null;
    }
  })();

  return mpvPlayPromise;
});

ipcMain.handle("mpv:pause", async (_event, paused) => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    mpvHandle.pause(Boolean(paused));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("mpv:seek", async (_event, seconds, relative) => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    mpvHandle.seek(Number(seconds), Boolean(relative));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("mpv:state", async () => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    const state = mpvHandle.getState();
    if (state && typeof state.volume === "number") {
      state.volume = state.volume / 100;
    }
    return { ok: true, state };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("mpv:stop", async () => {
  try {
    console.log("[MPV] Stop handler called");
    
    // Stop video playback
    if (mpvHandle && mpvInitialized) {
      mpvHandle.stop();
      console.log("[MPV] Video stopped");
    } else {
      console.log("[MPV] Stop ignored - MPV not initialized");
    }
    
    // Hide controls overlay
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      mpvControlsWindow.hide();
      console.log("[MPV] Controls overlay hidden");
    }
    
    // Hide MPV window
    if (mpvWindow && !mpvWindow.isDestroyed()) {
      mpvWindow.setAlwaysOnTop(false);
      mpvWindow.hide();
      console.log("[MPV] MPV window hidden");
    }
    
    // Clear stream URL and magnet
    currentStreamUrl = null;
    currentMagnet = null;
    
    // Clear buffer polling interval
    if (bufferPollInterval) {
      clearInterval(bufferPollInterval);
      bufferPollInterval = null;
    }
    
    // Show and focus main window
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.moveTop();
      console.log("[MPV] Main window shown and focused");
    }
    
    return { ok: true };
  } catch (err) {
    console.error("[MPV] Stop error:", err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("window:toggleFullscreen", async () => {
  try {
    if (mpvWindow && !mpvWindow.isDestroyed()) {
      const isFullscreen = mpvWindow.isFullScreen();
      mpvWindow.setFullScreen(!isFullscreen);
      // Sync controls window bounds after fullscreen toggle
      setTimeout(() => {
        if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
          const bounds = mpvWindow.getBounds();
          mpvControlsWindow.setBounds(bounds);
        }
      }, 100);
      return { ok: true, fullscreen: !isFullscreen };
    }
    return { ok: false, error: "MPV window not available" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("mpv:setVolume", async (_event, volume) => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    const mpvVolume = Math.max(0, Math.min(100, Number(volume) * 100));
    mpvHandle.setVolume(mpvVolume);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("mpv:setMute", async (_event, mute) => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    mpvHandle.setMute(Boolean(mute));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("mpv:isReady", () => {
  return { ok: true, ready: mpvInitialized && mpvHandle !== null };
});

ipcMain.handle("mpv:waitForReady", async () => {
  if (mpvInitialized && mpvHandle !== null) {
    return { ok: true, ready: true };
  }
  const ready = await initializeMpv();
  return { ok: true, ready };
});

// Embed MPV window at specific bounds within main window
ipcMain.handle("mpv:embed", async (_event, bounds) => {
  try {
    if (!mpvWindow || mpvWindow.isDestroyed()) {
      return { ok: false, error: "MPV window not initialized" };
    }
    
    // Convert bounds from renderer coordinates to screen coordinates
    if (mainWindow && !mainWindow.isDestroyed()) {
      const mainBounds = mainWindow.getBounds();
      const screenX = mainBounds.x + (bounds.x || 0);
      const screenY = mainBounds.y + (bounds.y || 0);
      
      mpvWindow.setBounds({
        x: screenX,
        y: screenY,
        width: bounds.width || 1280,
        height: bounds.height || 720,
      });
      
      // Re-verify HWND when showing window
      const currentHandle = mpvWindow.getNativeWindowHandle();
      const currentWid = currentHandle.readBigUInt64LE 
        ? currentHandle.readBigUInt64LE(0)
        : BigInt(currentHandle.readUInt32LE(0));
      
      if (currentWid !== mpvWid) {
        console.log("[MPV] HWND changed, re-attaching:", currentWid.toString(), "was:", mpvWid.toString());
        mpvWid = currentWid;
        mpvHandle.attachHwnd(mpvWid.toString());
      }
      
      // Show window after positioning
      mpvWindow.show();
      await new Promise(resolve => setTimeout(resolve, 100));
      
      return { ok: true };
    }
    
    return { ok: false, error: "Main window not available" };
  } catch (err) {
    console.error("[MPV] Embed error:", err);
    return { ok: false, error: err.message || String(err) };
  }
});

// Get buffer info from backend (proxy request)
ipcMain.handle("mpv:bufferInfo", async (_event, params) => {
  try {
    // Use stored magnet if available, otherwise try to extract from stream URL
    let magnet = currentMagnet;
    let cat = "movie";
    let fileIndex = "0";
    
    if (!magnet && currentStreamUrl) {
      // Fallback: try to extract from stream URL
      try {
        const url = new URL(currentStreamUrl);
        magnet = url.searchParams.get("magnet");
        cat = url.searchParams.get("cat") || "movie";
        fileIndex = url.searchParams.get("fileIndex") || "0";
      } catch (e) {
        console.warn("[MPV] Could not parse stream URL:", e.message);
      }
    }
    
    if (!magnet) {
      console.error("[MPV] No magnet URI available for buffer info");
      return { ok: false, error: "No magnet URI available" };
    }
    
    // Build buffer info URL using stored magnet
    const bufferUrl = new URL(`${VOD_BASE}/buffer/info`);
    bufferUrl.searchParams.set("magnet", magnet);
    bufferUrl.searchParams.set("cat", cat);
    bufferUrl.searchParams.set("fileIndex", fileIndex);
    bufferUrl.searchParams.set("sse", params?.sse ? "1" : "0");
    
    console.log("[MPV] Requesting buffer info:", bufferUrl.toString());
    const response = await fetch(bufferUrl.toString());
    if (!response.ok) {
      console.error("[MPV] Buffer info request failed:", response.status, response.statusText);
      return { ok: false, error: `HTTP ${response.status}` };
    }
    
    if (params?.sse) {
      // For SSE, return the response stream (handled differently in renderer)
      const text = await response.text();
      return { ok: true, data: text };
    } else {
      const data = await response.json();
      return { ok: true, data };
    }
  } catch (err) {
    console.error("[MPV] Buffer info error:", err);
    return { ok: false, error: err.message || String(err) };
  }
});

// Load subtitle track
ipcMain.handle("mpv:loadSub", async (_event, url) => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    mpvHandle.loadSubtitle(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Set audio track
ipcMain.handle("mpv:setAudio", async (_event, index) => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    mpvHandle.setAudioTrack(Number(index));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Set subtitle track
ipcMain.handle("mpv:setSub", async (_event, index) => {
  try {
    if (!mpvHandle) return { ok: false, error: "MPV not ready" };
    mpvHandle.setSubtitleTrack(Number(index));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Config management - secure storage for API keys
let appConfig = {};

// Load config from file on startup
const configPath = path.join(app.getPath("userData"), "config.json");
try {
  if (fs.existsSync(configPath)) {
    const configData = fs.readFileSync(configPath, "utf-8");
    appConfig = JSON.parse(configData);
  }
} catch (err) {
  console.warn("[Config] Failed to load config:", err);
}

// Also check environment variables as fallback (from .env file)
if (!appConfig.TMDB_API_KEY && process.env.TMDB_API_KEY) {
  appConfig.TMDB_API_KEY = process.env.TMDB_API_KEY;
  console.log("[Config] Loaded TMDB_API_KEY from environment");
}
if (!appConfig.TMDB_ACCESS_TOKEN && process.env.TMDB_ACCESS_TOKEN) {
  appConfig.TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
  console.log("[Config] Loaded TMDB_ACCESS_TOKEN from environment");
}
if (!appConfig.PROWLARR_URL && process.env.PROWLARR_URL) {
  appConfig.PROWLARR_URL = process.env.PROWLARR_URL;
  console.log("[Config] Loaded PROWLARR_URL from environment");
}
if (!appConfig.PROWLARR_API_KEY && process.env.PROWLARR_API_KEY) {
  appConfig.PROWLARR_API_KEY = process.env.PROWLARR_API_KEY;
  console.log("[Config] Loaded PROWLARR_API_KEY from environment");
}

// Log config status (without exposing keys)
console.log("[Config] Configuration status:", {
  hasTmdbKey: !!(appConfig.TMDB_API_KEY || appConfig.TMDB_ACCESS_TOKEN),
  hasProwlarr: !!(appConfig.PROWLARR_URL && appConfig.PROWLARR_API_KEY),
});

ipcMain.handle("config:get", () => {
  return appConfig;
});

ipcMain.handle("config:set", (_event, config) => {
  appConfig = { ...appConfig, ...config };
  try {
    fs.writeFileSync(configPath, JSON.stringify(appConfig, null, 2), "utf-8");
    return { ok: true };
  } catch (err) {
    console.error("[Config] Failed to save config:", err);
    return { ok: false, error: err.message };
  }
});



