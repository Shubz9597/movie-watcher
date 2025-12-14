const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let mainWindow;
let mpvHostWindow = null;
let mpvControlsWindow = null;
let mpvWid = null;
let mpvNative = null;
let mpvNativeHandle = null;
let mpvNativeReady = false;
let mpvAttached = false;
let lastTitle = "";
let mpvSessionActive = false;
let lastPlayTitle = "";
let mpvInitialized = false;
let mpvInitPromise = null;

// Try to load native libmpv embed addon (built via @napi-rs/cli)
// Only load the module, don't create handle until needed
try {
  const candidate = path.join(__dirname, "..", "native", "mpv-embed", "index.node");
  if (fs.existsSync(candidate)) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    mpvNative = require(candidate);
    console.log("[mpv-native] addon module loaded", Boolean(mpvNative));
  }
} catch (err) {
  console.warn("[mpv-native] addon not available", err?.message || err);
}

function getMainBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0, width: 1280, height: 720 };
  const b = mainWindow.getContentBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function attachMainWindowListeners() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mpvHostWindow || mpvHostWindow.isDestroyed()) return;
  
  // Remove existing listeners to avoid duplicates (if called multiple times)
  // Note: removeAllListeners removes ALL listeners, so we need to be careful
  // For now, we'll just check if listeners are already attached by checking if the window has the event
  
  const updateBounds = () => {
    if (!mpvHostWindow || mpvHostWindow.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getContentBounds();
    mpvHostWindow.setBounds(bounds);
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      mpvControlsWindow.setBounds(bounds);
    }
  };
  
  // Only attach if not already attached (simple check - if this function is called multiple times, 
  // we'll have duplicate listeners, but that's acceptable for now)
  mainWindow.on("resize", updateBounds);
  mainWindow.on("move", updateBounds);
  mainWindow.on("maximize", updateBounds);
  mainWindow.on("unmaximize", updateBounds);
}

function hideMpvWindows() {
  if (mpvHostWindow && !mpvHostWindow.isDestroyed()) {
    mpvHostWindow.hide();
    mpvHostWindow.setSkipTaskbar(true);
  }
  if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
    mpvControlsWindow.hide();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(false);
    mainWindow.show();
  }
  mpvSessionActive = false;
}

function showMpvWindows() {
  if (!mpvSessionActive) return;
  const bounds = getMainBounds();
  if (mpvHostWindow && !mpvHostWindow.isDestroyed()) {
    mpvHostWindow.setBounds(bounds);
    mpvHostWindow.setSkipTaskbar(false);
    mpvHostWindow.show();
    mpvHostWindow.focus();
    if (lastPlayTitle) mpvHostWindow.setTitle(lastPlayTitle);
  }
  if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
    mpvControlsWindow.setBounds(bounds);
    mpvControlsWindow.showInactive();
  }
}

function ensureMpvHostWindow() {
  if (mpvHostWindow && !mpvHostWindow.isDestroyed()) return;
  
  // Get bounds - use mainWindow if available, otherwise use defaults
  let bounds;
  if (mainWindow && !mainWindow.isDestroyed()) {
    bounds = getMainBounds();
  } else {
    bounds = { x: 0, y: 0, width: 1280, height: 720 };
  }
  const { x, y, width, height } = bounds;

  // Top-level host for mpv. We hide the main window during playback so Alt+Tab shows this one.
  mpvHostWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    useContentSize: true,
    frame: false,
    transparent: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    focusable: true,
    skipTaskbar: true, // flipped to false when playing
    show: false, // shown when playing
    hasShadow: false,
    backgroundColor: "#000000",
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load blank page (mpv renders directly into window, not via web content)
  mpvHostWindow.loadURL("about:blank").catch(() => {});

  // Get native window handle for mpv - get it immediately after window creation
  // The HWND is available immediately, we don't need to wait for did-finish-load
  try {
    const handle = mpvHostWindow.getNativeWindowHandle();
    // HWND is pointer-sized; prefer 64-bit read to avoid truncation on x64.
    mpvWid = handle.readBigUInt64LE ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
    console.log("[mpv] host window HWND obtained immediately:", mpvWid);
  } catch (err) {
    console.error("[mpv] Failed to get HWND immediately:", err);
    // Fallback: try again after did-finish-load
    mpvHostWindow.webContents.once("did-finish-load", () => {
      try {
        const handle = mpvHostWindow.getNativeWindowHandle();
        mpvWid = handle.readBigUInt64LE ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
        console.log("[mpv] host window HWND obtained after load:", mpvWid);
      } catch (e) {
        console.error("[mpv] Failed to get HWND after load:", e);
      }
    });
  }

  mpvHostWindow.on("close", () => {
    try { mpvNativeHandle?.stop(); } catch {}
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      mpvControlsWindow.hide();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      hideMpvWindows();
    }
  });

  // Update bounds on maximize/restore
  mpvHostWindow.on("maximize", () => {
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      const bounds = mpvHostWindow.getBounds();
      mpvControlsWindow.setBounds(bounds);
    }
  });

  mpvHostWindow.on("unmaximize", () => {
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      const bounds = mpvHostWindow.getBounds();
      mpvControlsWindow.setBounds(bounds);
    }
  });

  // Sync bounds when main window changes (attach listeners if mainWindow exists)
  attachMainWindowListeners();

  // Also sync when mpv host window changes (user resizes it)
  mpvHostWindow.on("resize", () => {
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed() && mpvHostWindow && !mpvHostWindow.isDestroyed()) {
      const bounds = mpvHostWindow.getBounds();
      mpvControlsWindow.setBounds(bounds);
    }
  });
}

function ensureMpvControlsWindow() {
  if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) return;
  if (!mpvHostWindow || mpvHostWindow.isDestroyed()) return;

  const { x, y, width, height } = getMainBounds();

  // Transparent overlay that follows the main window and never shows in taskbar.
  mpvControlsWindow = new BrowserWindow({
    parent: mpvHostWindow,
    modal: false,
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false, // Don't steal focus from video window
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mpvControlsWindow.loadFile(path.join(__dirname, "controls.html")).catch((err) => {
    console.error("[mpv] failed to load controls", err);
  });

  mpvControlsWindow.webContents.on("did-finish-load", () => {
    if (lastTitle) {
      mpvControlsWindow.webContents.send("mpv:title", lastTitle);
    }
  });

  const syncPosition = () => {
    if (mpvHostWindow && !mpvHostWindow.isDestroyed() && mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      const bounds = mpvHostWindow.getBounds();
      mpvControlsWindow.setBounds(bounds);
    }
  };

  // Only attach listeners if mainWindow exists
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.on("resize", syncPosition);
    mainWindow.on("move", syncPosition);
  }

  console.log("[mpv] controls window created");
}

// ----- Docker helpers -----
function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "pipe", ...options });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}\n${stderr}`));
    });
  });
}

async function startDockerStack() {
  const composePath = path.join(__dirname, "..", "docker-compose.yml");
  const cwd = path.join(__dirname, "..");
  // Check docker
  await runCommand("docker", ["--version"]);
  // Run compose
  await runCommand("docker", ["compose", "-f", composePath, "up", "-d"], { cwd });
  return { ok: true };
}

// ----- mpv helpers -----
async function initializeMpvAtStartup() {
  if (mpvInitPromise) return mpvInitPromise;
  
  mpvInitPromise = (async () => {
    try {
      console.log("[mpv] Starting initialization at app startup...");
      
      if (!mpvNative) {
        throw new Error("mpv native addon not loaded");
      }
      
      // Create handle
      if (!mpvNativeHandle) {
        mpvNativeHandle = mpvNative.MpvHandle.create();
        console.log("[mpv-native] handle created");
      }
      
      if (!mpvNativeHandle) {
        throw new Error("mpv handle creation failed");
      }
      
      // Create window (ensureMpvHostWindow will use default bounds if mainWindow doesn't exist)
      ensureMpvHostWindow();
      
      if (!mpvHostWindow || mpvHostWindow.isDestroyed()) {
        throw new Error("mpv host window creation failed");
      }
      
      // Show window to ensure it's fully created and has valid rendering context
      mpvHostWindow.show();
      mpvHostWindow.setSkipTaskbar(false);
      
      // Ensure HWND is available - get it now if not already set
      if (!mpvWid) {
        try {
          const handle = mpvHostWindow.getNativeWindowHandle();
          mpvWid = handle.readBigUInt64LE ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
          console.log("[mpv] HWND obtained:", mpvWid);
        } catch (err) {
          console.error("[mpv] Failed to get HWND:", err);
        }
      }
      
      // Wait for HWND with timeout
      let attempts = 0;
      while (!mpvWid && attempts < 100) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!mpvWid) {
          try {
            const handle = mpvHostWindow.getNativeWindowHandle();
            mpvWid = handle.readBigUInt64LE ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
          } catch {}
        }
        attempts++;
      }
      
      if (!mpvWid) {
        throw new Error("Window HWND not available after waiting");
      }
      
      console.log("[mpv] HWND confirmed:", mpvWid, "Window visible:", mpvHostWindow.isVisible());
      
      // Wait a bit for window to be fully ready (rendering context)
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Attach HWND (window MUST be visible for mpv to render)
      if (!mpvAttached) {
        try {
          mpvNativeHandle.attachHwnd(mpvWid);
          mpvAttached = true;
          console.log("[mpv-native] attached hwnd", mpvWid);
        } catch (err) {
          console.error("[mpv-native] attachHwnd failed:", err);
          throw err;
        }
      }
      
      // Initialize mpv (AFTER wid is set, window is visible)
      if (!mpvNativeReady) {
        try {
          mpvNativeHandle.init({});
          mpvNativeReady = true;
          console.log("[mpv-native] init ok");
        } catch (err) {
          console.error("[mpv-native] init failed with error:", err);
          throw err;
        }
      }
      
      // Keep window visible but behind main window (don't hide or move off-screen)
      // mpv needs the window to remain visible for rendering context
      mpvHostWindow.setSkipTaskbar(true);
      // Keep it visible but send it behind main window
      if (mainWindow && !mainWindow.isDestroyed()) {
        mpvHostWindow.setAlwaysOnTop(false);
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setAlwaysOnTop(false);
      }
      
      mpvInitialized = true;
      console.log("[mpv] Initialization complete! mpv is ready for playback.");
      return true;
    } catch (err) {
      console.error("[mpv] Initialization failed", err);
      mpvInitialized = false;
      throw err;
    }
  })();
  
  return mpvInitPromise;
}

async function ensureMpvReady() {
  // If not initialized, try to initialize now (fallback)
  if (!mpvInitialized) {
    try {
      await initializeMpvAtStartup();
    } catch (err) {
      console.error("[mpv] ensureMpvReady: initialization failed", err);
      return false;
    }
  }
  return mpvInitialized && mpvNativeHandle && mpvNativeReady && mpvAttached;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  const startUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  mainWindow.loadURL(startUrl);
  
  // Attach event listeners now that mainWindow exists
  // This ensures mpvHostWindow bounds sync with mainWindow even if mpv was initialized first
  attachMainWindowListeners();
}

app.whenReady().then(async () => {
  // Initialize mpv first, before creating main window
  if (mpvNative) {
    try {
      console.log("[mpv] Pre-initializing mpv at app startup...");
      await initializeMpvAtStartup();
    } catch (err) {
      console.error("[mpv] Failed to pre-initialize mpv at startup", err);
      // Continue anyway - will try lazy initialization as fallback
    }
  } else {
    console.warn("[mpv] Native addon not available, skipping pre-initialization");
  }
  
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  try { mpvNativeHandle?.shutdown(); } catch {}
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("mpv:play", async (_event, payload) => {
  try {
    const url = typeof payload === "string" ? payload : payload?.url;
    const title = typeof payload === "object" && payload ? payload.title : "";
    lastTitle = title || "";
    lastPlayTitle = title || "";
    console.log("[mpv] play requested", url, "title:", title);
    
    // Ensure window is created first
    ensureMpvHostWindow();
    
    // Wait for ensureMpvReady (which now handles attach + init in correct order)
    const ready = await ensureMpvReady();
    if (!ready || !mpvNativeHandle) {
      return { ok: false, error: "mpv native addon not ready" };
    }
    
  // Show the host + controls layered over the main window
  if (mpvHostWindow && !mpvHostWindow.isDestroyed()) {
    const bounds = getMainBounds();
    
    // Update window position and size
    mpvHostWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });
    
    // Verify HWND is still valid (shouldn't change, but check anyway)
    try {
      const handle = mpvHostWindow.getNativeWindowHandle();
      const currentWid = handle.readBigUInt64LE ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
      if (currentWid !== mpvWid) {
        console.log("[mpv] HWND changed, re-attaching:", currentWid, "was:", mpvWid);
        mpvWid = currentWid;
        try {
          mpvNativeHandle.attachHwnd(mpvWid);
          mpvAttached = true;
          console.log("[mpv-native] re-attached hwnd", mpvWid);
        } catch (err) {
          console.error("[mpv-native] re-attach failed", err);
          throw err;
        }
      }
    } catch (err) {
      console.error("[mpv] Failed to verify HWND:", err);
    }
    
    mpvHostWindow.setTitle(title || "Player");
    mpvHostWindow.setSkipTaskbar(false);
    // Ensure window is visible on all workspaces
    mpvHostWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    
    // CRITICAL: Window must be visible and have focus for mpv to render
    mpvHostWindow.show();
    // Wait a moment for window to be fully ready
    await new Promise(resolve => setTimeout(resolve, 100));
    mpvHostWindow.focus();
    
    console.log("[mpv] host window shown with bounds", bounds, "HWND:", mpvWid, "Visible:", mpvHostWindow.isVisible());
  }
    
    // Create and show controls overlay (AFTER video window is shown)
    ensureMpvControlsWindow();
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      const bounds = getMainBounds();
      mpvControlsWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      mpvControlsWindow.showInactive(); // Don't focus controls window
      // Don't call focus() on controls window - it should not steal focus
      console.log("[mpv] controls window shown");
    }

    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      mpvControlsWindow.webContents.send("mpv:title", title);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSkipTaskbar(true);
      mainWindow.hide();
    }
    
    // CRITICAL: Wait for window to be fully ready before loading video
    // mpv needs the window to be visible and have a valid rendering context
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Load video (window is now visible and HWND is attached)
    console.log("[mpv] Loading video URL:", url);
    try {
      mpvNativeHandle.load(url);
      console.log("[mpv] Video load command sent successfully");
    } catch (err) {
      console.error("[mpv] Failed to load video:", err);
      throw err;
    }
  try { mpvNativeHandle.pause(false); } catch {}
  mpvSessionActive = true;
    setTimeout(async () => {
      try {
        const st = await mpvNativeHandle.getState();
        console.log("[mpv] post-load state", st);
      } catch (err) {
        console.warn("[mpv] post-load state failed", err);
      }
    }, 500);
  return { ok: true, native: true };
} catch (err) {
  console.error("[mpv] play failed", err);
  hideMpvWindows();
  return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:pause", async (_event, paused) => {
  try {
    if (!ensureMpvReady() || !mpvNativeHandle) return { ok: false, error: "mpv not ready" };
    mpvNativeHandle.pause(Boolean(paused));
    return { ok: true };
  } catch (err) {
    console.error("[mpv] pause failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:seek", async (_event, seconds, relative = true) => {
  try {
    if (!ensureMpvReady() || !mpvNativeHandle) return { ok: false, error: "mpv not ready" };
    mpvNativeHandle.seek(Number(seconds) || 0, Boolean(relative));
    return { ok: true };
  } catch (err) {
    console.error("[mpv] seek failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:state", async () => {
  try {
    if (!mpvNativeHandle || !mpvNativeReady) return { ok: false, error: "mpv not ready" };
    const state = mpvNativeHandle.getState(); // napi-rs converts snake_case to camelCase
    // Convert mpv volume (0-100) to 0-1 range for UI
    if (state && typeof state.volume === "number") {
      state.volume = state.volume / 100;
    }
    return { ok: true, state };
  } catch (err) {
    console.error("[mpv] state failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:stop", async () => {
  try {
    if (!mpvNativeHandle) return { ok: false, error: "mpv not ready" };
    
    // Stop playback
    mpvNativeHandle.stop();
    
    hideMpvWindows();
    console.log("[mpv] stop -> windows hidden");
    
    return { ok: true };
  } catch (err) {
    console.error("[mpv] stop failed", err);
    hideMpvWindows();
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:setVolume", async (_event, volume) => {
  try {
    if (!mpvNativeHandle) return { ok: false, error: "mpv not ready" };
    // Convert 0-1 range to mpv's 0-100 range
    const mpvVolume = Math.max(0, Math.min(100, Number(volume) * 100));
    mpvNativeHandle.setVolume(mpvVolume);
    return { ok: true };
  } catch (err) {
    console.error("[mpv] setVolume failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:setMute", async (_event, mute) => {
  try {
    if (!mpvNativeHandle) return { ok: false, error: "mpv not ready" };
    mpvNativeHandle.setMute(Boolean(mute));
    return { ok: true };
  } catch (err) {
    console.error("[mpv] setMute failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:isReady", () => {
  return { ok: true, ready: mpvInitialized && mpvNativeHandle && mpvNativeReady && mpvAttached };
});

ipcMain.handle("window:toggleFullscreen", async () => {
  // Toggle fullscreen on the mpv host window if it exists, otherwise main window
  const targetWindow = (mpvHostWindow && !mpvHostWindow.isDestroyed()) ? mpvHostWindow : mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return { ok: false, error: "window missing" };
  const next = !targetWindow.isFullScreen();
  targetWindow.setFullScreen(next);
  // Update controls window bounds if it exists
  if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
    const bounds = targetWindow.getBounds();
    mpvControlsWindow.setBounds(bounds);
  }
  return { ok: true, fullscreen: next };
});

ipcMain.handle("stack:up", async () => {
  try {
    const result = await startDockerStack();
    return result;
  } catch (err) {
    console.error("[stack] docker compose up failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

// Safety: if main window regains focus while a session is active, ensure host is visible; if not active, hide overlays.
app.on("browser-window-focus", () => {
  if (mpvSessionActive) {
    if (mpvHostWindow && !mpvHostWindow.isDestroyed()) {
      mpvHostWindow.show();
      mpvHostWindow.setSkipTaskbar(false);
    }
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      mpvControlsWindow.showInactive();
    }
  } else {
    hideMpvWindows();
  }
});
