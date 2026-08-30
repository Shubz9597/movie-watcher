import { app, BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import {
  SETUP_GUIDE_URLS,
  createAppConfigStore,
  createAppResourcePaths,
  createTmdbTransport,
  verifyOpenSubtitlesConnection,
  verifyStorageDirectory,
  verifyTmdbConnection,
} from "./electron/config/index.js";
import { installDiagnosticLogging } from "./electron/diagnostics/diagnostic-logger.js";
import {
  registerConfigIpc,
  registerDiagnosticsIpc,
  registerMpvIpc,
  registerSetupIpc,
  registerTmdbIpc,
} from "./electron/ipc/index.js";
import {
  RESUME_TOLERANCE_SECONDS,
  RESUME_VERIFY_TIMEOUT_MS,
  VOD_BASE,
  createMpvSessionManager,
  createPlaybackController,
} from "./electron/playback/index.js";
import { createStartupController } from "./electron/runtime/startup-controller.js";
import { RuntimeManager } from "./electron/runtime/runtime-manager.js";
import {
  createMainBrowserWindow,
  createPlayerSurfaceController,
  createSetupBrowserWindow,
  createStartupBrowserWindow,
} from "./electron/windows/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appResourcePaths = createAppResourcePaths(__dirname);
app.setName("TorWatch");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const diagnosticLog = installDiagnosticLogging({
  logDir: path.join(app.getPath("userData"), "logs"),
  appVersion: app.getVersion(),
  packaged: app.isPackaged,
  rotateLogs: hasSingleInstanceLock,
});
process.env.TORWATCH_DIAGNOSTIC_SESSION_ID = diagnosticLog.sessionId;
const runtimeManager = new RuntimeManager({
  reportError: (scope, message, details, options) => diagnosticLog.write("error", scope, message, details, options),
});

app.on("web-contents-created", (_event, contents) => {
  const scope = `renderer:${contents.getType()}:${contents.id}`;
  contents.on("console-message", (_consoleEvent, level, message, line, sourceId) => {
    const names = ["debug", "info", "warn", "error"];
    diagnosticLog.write(names[level] || "info", scope, message, {
      source: sourceId,
      line,
    });
  });
  contents.on("render-process-gone", (_goneEvent, details) => {
    const level = details.reason === "clean-exit" ? "info" : "error";
    diagnosticLog.write(level, scope, "renderer process exited", details);
  });
});

app.on("child-process-gone", (_event, details) => {
  const level = details.reason === "clean-exit" ? "info" : "error";
  diagnosticLog.write(level, "electron-child", "Electron child process exited", details);
});

process.on("warning", (warning) => {
  diagnosticLog.write("warn", "node", "Node.js process warning", warning);
});

// Load .env file if it exists
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  const electronEnv = {};
  const result = dotenv.config({ path: envPath, processEnv: electronEnv });
  if (result.error) {
    console.error("[Config] Error loading .env:", result.error);
  } else {
    for (const key of [
      "TMDB_API_KEY",
      "TMDB_ACCESS_TOKEN",
      "OPENSUB_API_KEY",
      "OPENSUBTITLES_API_KEY",
      "OPENSUBTITLES_USER_TOKEN",
      "OPENSUB_USER_TOKEN",
    ]) {
      if (!process.env[key] && electronEnv[key]) process.env[key] = electronEnv[key];
    }
    console.log("[Config] Loaded .env file from:", envPath);
  }
} else if (!app.isPackaged) {
  console.warn("[Config] .env file not found at:", envPath);
  console.warn("[Config] Please create .env file with TMDB_API_KEY and TMDB_ACCESS_TOKEN");
}

// Fix DPI scaling on Windows
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('high-dpi-support', '1');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

const appConfigStore = createAppConfigStore({
  runtimeManager,
  userDataPath: app.getPath("userData"),
});

let startupController = null;
let tmdbProxySessionPromise = null;
const tmdbTransport = createTmdbTransport({
  ensureProxyReady: () => runtimeManager.ensureTmdbProxy((message) => {
    startupController?.sendStartupStatus(message);
  }),
  getProxySession: async () => {
    if (!tmdbProxySessionPromise) {
      tmdbProxySessionPromise = (async () => {
        const proxySession = session.fromPartition("torwatch:tmdb-vpn", { cache: false });
        await proxySession.setProxy({
          mode: "fixed_servers",
          proxyRules: "http://127.0.0.1:8888",
          proxyBypassRules: "<-loopback>",
        });
        return proxySession;
      })().catch((error) => {
        tmdbProxySessionPromise = null;
        throw error;
      });
    }
    return tmdbProxySessionPromise;
  },
  onFallback: (message) => {
    console.warn(`[TMDb] ${message}`);
    startupController?.sendStartupStatus(message);
  },
});
const verifyTmdbWithFallback = (credentials) => verifyTmdbConnection(credentials, {
  fetch: tmdbTransport.fetch,
});

let mainWindow = null;
startupController = createStartupController({
  app,
  appConfigStore,
  appDirectory: __dirname,
  appResourcePaths,
  createMainWindow,
  createSetupBrowserWindow,
  createStartupBrowserWindow,
  getMainWindow: () => mainWindow,
  runtimeManager,
  setupDevUrl: app.isPackaged ? "" : "http://localhost:5173/setup.html",
  setupFilePath: path.join(__dirname, "dist", "setup.html"),
  startupDevUrl: app.isPackaged ? "" : "http://localhost:5173/startup.html",
  startupFilePath: path.join(__dirname, "dist", "startup.html"),
  verifyTmdbConnection: verifyTmdbWithFallback,
});
let playerSurface = null;
const mpvSession = createMpvSessionManager({
  appDirectory: __dirname,
  getAspectMode: () => playerSurface.currentAspectMode,
  getMainWindow: () => mainWindow,
  getVideoHostRect: () => playerSurface.getVideoHostRect(),
  resourcesPath: process.resourcesPath,
  sleep,
});
playerSurface = createPlayerSurfaceController({
  appDirectory: __dirname,
  controlsDevUrl: app.isPackaged ? "" : "http://localhost:5173/player-controls.html",
  controlsFilePath: path.join(__dirname, "dist", "player-controls.html"),
  controlsPreloadPath: appResourcePaths.playerPreload,
  getMainWindow: () => mainWindow,
  getMpvSession: () => mpvSession,
  sleep,
});
const playbackController = createPlaybackController({
  getControlsWindow: () => playerSurface.controlsWindow,
  getMpvHandle: () => mpvSession.handle,
  getUserDataPath: () => app.getPath("userData"),
  resumeToleranceSeconds: RESUME_TOLERANCE_SECONDS,
  resumeVerifyTimeoutMs: RESUME_VERIFY_TIMEOUT_MS,
  sleep,
  vodBase: VOD_BASE,
});
const mpvIpc = registerMpvIpc(ipcMain, {
  getMainWindow: () => mainWindow,
  mpvSession,
  playbackController,
  playerSurface,
  sleep,
  vodBase: VOD_BASE,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Create main window
function createMainWindow() {
  try {
    console.log("[Main] Creating main window...");
    
    mainWindow = createMainBrowserWindow({
      iconPath: appResourcePaths.appIcon,
      preloadPath: appResourcePaths.mainPreload,
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

    mainWindow.webContents.once("did-finish-load", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("runtime:state", startupController.getRuntimeState());
        mainWindow.webContents.send("catalog:state", startupController.getCatalogState());
      }
    });

    playerSurface.bindMainWindow();

    mainWindow.on("closed", () => {
      playerSurface.handleMainWindowClosed();
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
let shutdownPromise = null;
let shutdownComplete = false;

async function shutdownApplication() {
  await mpvIpc.shutdownPlayback();
  await runtimeManager.shutdown();
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = startupController.getSetupWindow() || mainWindow || startupController.getStartupWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

app.on("before-quit", (event) => {
  if (!hasSingleInstanceLock || shutdownComplete) return;
  event.preventDefault();
  if (shutdownPromise) return;

  shutdownPromise = shutdownApplication()
    .catch((error) => {
      console.error("[App] Shutdown error:", error);
    })
    .finally(() => {
      shutdownComplete = true;
      app.quit();
    });
});

app.whenReady().then(async () => {
  console.log("[App] Electron app ready, starting runtime...");
  appConfigStore.hydrateSecureConfig();
  await startupController.bootstrapApplication();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void startupController.bootstrapApplication();
    }
  });
}).catch((err) => {
  console.error("[App] Error in whenReady:", err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

registerDiagnosticsIpc(ipcMain, { diagnosticLog, shell });
playerSurface.registerDragIpc(ipcMain);

registerConfigIpc(ipcMain, {
  getPublicConfig: () => appConfigStore.getPublicConfig(),
  saveConfig: (config) => appConfigStore.saveConfig(config),
});

registerTmdbIpc(ipcMain, {
  getCredentials: () => appConfigStore.resolveSetupCredentials({}),
  getCatalogState: startupController.getCatalogState,
  publishCatalogState: startupController.publishCatalogState,
  requireTmdbSetup: startupController.requireTmdbSetup,
  tmdbFetch: tmdbTransport.fetch,
});

registerSetupIpc(ipcMain, {
  dialog,
  shell,
  runtimeManager,
  playbackController,
  vodBase: VOD_BASE,
  urls: SETUP_GUIDE_URLS,
  getAppConfig: () => appConfigStore.getConfig(),
  getMainWindow: () => mainWindow,
  getRuntimeState: startupController.getRuntimeState,
  getSetupIssue: startupController.getSetupIssue,
  getSetupMode: startupController.getSetupMode,
  getSetupWindow: startupController.getSetupWindow,
  setSetupIssue: startupController.setSetupIssue,
  applyTmdbCredential: (tmdbKey) => appConfigStore.applyTmdbCredential(tmdbKey),
  checkSavedTmdbCredential: startupController.checkSavedTmdbCredential,
  continueAfterTmdbReady: startupController.continueAfterTmdbReady,
  createMainWindow,
  createSetupWindow: startupController.createSetupWindow,
  hasTmdbCredential: startupController.hasTmdbCredential,
  persistAppConfig: () => appConfigStore.persist(),
  publishRuntimeState: startupController.publishRuntimeState,
  publishCatalogState: startupController.publishCatalogState,
  publishSetupMode: startupController.publishSetupMode,
  requireTmdbSetup: startupController.requireTmdbSetup,
  resolveSetupCredentials: (configuration) => appConfigStore.resolveSetupCredentials(configuration),
  sendSetupCheck: startupController.sendSetupCheck,
  sendStartupStatus: startupController.sendStartupStatus,
  startApplicationRuntime: startupController.startApplicationRuntime,
  verifyOpenSubtitlesConnection,
  verifyStorageDirectory,
  verifyTmdbConnection: verifyTmdbWithFallback,
});
