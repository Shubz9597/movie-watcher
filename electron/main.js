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

function getMainWindowHwnd() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const handle = mainWindow.getNativeWindowHandle();
  // On Windows the handle is a pointer-sized integer; readUInt32LE works for HWND.
  return handle.readUInt32LE(0);
}

function getMainBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return { x: 0, y: 0, width: 1280, height: 720 };
  const b = mainWindow.getContentBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function ensureMpvHostWindow() {
  if (mpvHostWindow && !mpvHostWindow.isDestroyed()) return;
  if (!mainWindow) return;
  
  const { x, y, width, height } = getMainBounds();
  
  // Create independent window (not a child) that will host mpv - this ensures Alt+Tab shows it correctly
  // mpv will render directly into this window via HWND, so we can't overlay HTML on top
  mpvHostWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    focusable: true,
    skipTaskbar: false, // Show in taskbar so Alt+Tab works
    show: false, // Hidden initially, shown when video plays
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
  
  // Get native window handle for mpv
  mpvHostWindow.webContents.once("did-finish-load", () => {
    const handle = mpvHostWindow.getNativeWindowHandle();
    mpvWid = handle.readUInt32LE(0);
    console.log("[mpv] host window created", { mpvWid, bounds: { x, y, width, height } });
    
    // Attach mpv if ready
    if (mpvNativeHandle && mpvNativeReady && !mpvAttached) {
      try {
        mpvNativeHandle.attachHwnd(mpvWid);
        mpvAttached = true;
        console.log("[mpv-native] attached hwnd", mpvWid);
      } catch (err) {
        console.error("[mpv-native] attach failed", err);
      }
    }
  });
  
  // Handle window close
  mpvHostWindow.on("close", (e) => {
    if (mpvNativeHandle) {
      try {
        mpvNativeHandle.stop();
      } catch (err) {
        console.error("[mpv] stop on close failed", err);
      }
    }
    // Hide controls window if it exists
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      mpvControlsWindow.hide();
    }
  });
  
  // Update bounds when main window moves/resizes (sync mpv window with main)
  const updateBounds = () => {
    if (mpvHostWindow && !mpvHostWindow.isDestroyed() && mainWindow && !mainWindow.isDestroyed()) {
      const bounds = getMainBounds();
      mpvHostWindow.setBounds(bounds);
      // Also update controls window
      if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
        mpvControlsWindow.setBounds(bounds);
      }
    }
  };
  
  mainWindow.on("resize", updateBounds);
  mainWindow.on("move", updateBounds);
}

function ensureMpvControlsWindow() {
  if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) return;
  if (!mpvHostWindow || mpvHostWindow.isDestroyed()) return;
  
  const { x, y, width, height } = getMainBounds();
  
  // Create transparent overlay window for controls that sits on top of mpv window
  // Make it independent (not a child) so it can be properly layered
  mpvControlsWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true, // Transparent so mpv video shows through
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: true, // Allow focus for keyboard shortcuts
    skipTaskbar: true, // Don't show in taskbar
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000", // Fully transparent
    webPreferences: { 
      backgroundThrottling: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  
  // Load controls overlay
  mpvControlsWindow.loadFile(path.join(__dirname, "controls.html")).catch((err) => {
    console.error("[mpv] failed to load controls", err);
  });
  
  // Always keep controls window on top of mpv window
  mpvControlsWindow.setAlwaysOnTop(true, "floating");
  
  // Sync position with mpv window
  const syncPosition = () => {
    if (mpvHostWindow && !mpvHostWindow.isDestroyed() && mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      const bounds = mpvHostWindow.getBounds();
      mpvControlsWindow.setBounds(bounds);
    }
  };
  
  mpvHostWindow.on("resize", syncPosition);
  mpvHostWindow.on("move", syncPosition);
  
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
function ensureMpvReady() {
  // Create handle if not exists
  if (!mpvNativeHandle && mpvNative) {
    try {
      mpvNativeHandle = mpvNative.MpvHandle.create();
      console.log("[mpv-native] handle created", Boolean(mpvNativeHandle));
    } catch (err) {
      console.error("[mpv-native] handle creation failed", err);
      return false;
    }
  }
  
  // Create window if not exists
  ensureMpvHostWindow();
  
  // Initialize mpv if needed
  if (mpvNativeHandle && !mpvNativeReady) {
    try {
      mpvNativeHandle.init({});
      mpvNativeReady = true;
      console.log("[mpv-native] init ok");
    } catch (err) {
      console.error("[mpv-native] init failed", err);
      return false;
    }
  }
  
  // Attach to window if not already attached (will be done in ensureMpvHostWindow after page loads)
  // Just ensure window is created and ready
  return mpvNativeHandle && mpvNativeReady;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  const startUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  mainWindow.loadURL(startUrl);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  try { mpvNativeHandle?.shutdown(); } catch {}
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("mpv:play", async (_event, url) => {
  try {
    console.log("[mpv] play requested", url);
    
    const ready = ensureMpvReady();
    if (!ready || !mpvNativeHandle) {
      return { ok: false, error: "mpv native addon not ready" };
    }
    
    // Ensure window is created
    ensureMpvHostWindow();
    
    // Wait for window to be ready and mpv attached
    let attempts = 0;
    while ((!mpvWid || !mpvAttached) && attempts < 20) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (!mpvWid || !mpvAttached) {
      return { ok: false, error: "mpv window not ready" };
    }
    
    // Show the mpv window - it's independent so Alt+Tab will show it
    if (mpvHostWindow && !mpvHostWindow.isDestroyed()) {
      const bounds = getMainBounds();
      mpvHostWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      mpvHostWindow.show();
      mpvHostWindow.focus(); // Focus so it appears in Alt+Tab
      console.log("[mpv] host window shown with bounds", bounds);
    }
    
    // Create and show controls overlay
    ensureMpvControlsWindow();
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      const bounds = getMainBounds();
      mpvControlsWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
      mpvControlsWindow.show();
      console.log("[mpv] controls window shown");
    }
    
    // Hide main window web content when mpv is playing
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
    
    mpvNativeHandle.load(url);
    return { ok: true, native: true };
  } catch (err) {
    console.error("[mpv] play failed", err);
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
    if (!ensureMpvReady() || !mpvNativeHandle) return { ok: false, error: "mpv not ready" };
    const state = mpvNativeHandle.getState(); // napi-rs converts snake_case to camelCase
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
    
    // Hide the host window and controls when video stops
    if (mpvHostWindow && !mpvHostWindow.isDestroyed()) {
      mpvHostWindow.hide();
      console.log("[mpv] host window hidden");
    }
    if (mpvControlsWindow && !mpvControlsWindow.isDestroyed()) {
      mpvControlsWindow.hide();
      console.log("[mpv] controls window hidden");
    }
    
    // Show main window again
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
    
    return { ok: true };
  } catch (err) {
    console.error("[mpv] stop failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle("mpv:setVolume", async (_event, volume) => {
  try {
    if (!mpvNativeHandle) return { ok: false, error: "mpv not ready" };
    mpvNativeHandle.setVolume(Number(volume));
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

ipcMain.handle("stack:up", async () => {
  try {
    const result = await startDockerStack();
    return result;
  } catch (err) {
    console.error("[stack] docker compose up failed", err);
    return { ok: false, error: err?.message || String(err) };
  }
});

