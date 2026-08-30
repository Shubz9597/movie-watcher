import path from "path";

export function createStartupController({
  app,
  appConfigStore,
  appDirectory,
  appResourcePaths,
  createMainWindow,
  createSetupBrowserWindow,
  createStartupBrowserWindow,
  getMainWindow,
  runtimeManager,
  setupDevUrl = "",
  setupFilePath = "",
  startupDevUrl = "",
  startupFilePath = "",
  verifyTmdbConnection,
}) {
  let setupWindow = null;
  let setupMode = "settings";
  let setupIssue = "";
  let startupWindow = null;
  let runtimeStartPromise = null;
  let runtimeState = {
    status: "idle",
    message: "Playback services have not started.",
    code: "RUNTIME_IDLE",
  };
  let catalogState = {
    status: "checking",
    issue: "",
    hasSavedCredential: appConfigStore.hasTmdbCredential(),
  };

  function getRuntimeState() {
    return runtimeState;
  }

  function getCatalogState() {
    return catalogState;
  }

  function getSetupWindow() {
    return setupWindow;
  }

  function getStartupWindow() {
    return startupWindow;
  }

  function getSetupMode() {
    return setupMode;
  }

  function getSetupIssue() {
    return setupIssue;
  }

  function setSetupIssue(issue) {
    setupIssue = issue;
  }

  function publishRuntimeState(nextState) {
    runtimeState = {
      status: nextState.status,
      message: nextState.message || "",
      code: nextState.code || "",
    };

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("runtime:state", runtimeState);
    }
    return runtimeState;
  }

  function publishCatalogState(nextState) {
    catalogState = {
      status: nextState.status,
      issue: nextState.issue || "",
      hasSavedCredential: appConfigStore.hasTmdbCredential(),
    };
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("catalog:state", catalogState);
    }
    return catalogState;
  }

  function requireTmdbSetup(issue) {
    const state = publishCatalogState({
      status: "needs-setup",
      issue: String(issue || "TMDb needs attention before TorWatch can continue.").trim(),
    });
    startupWindow?.close();
    const mainWindow = getMainWindow();
    if (!mainWindow) createMainWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
    return state;
  }

  function hasTmdbCredential() {
    return appConfigStore.hasTmdbCredential();
  }

  function createStartupWindow() {
    if (startupWindow && !startupWindow.isDestroyed()) return startupWindow;
    startupWindow = createStartupBrowserWindow({
      iconPath: appResourcePaths.appIcon,
      preloadPath: appResourcePaths.startupPreload,
    });
    startupWindow.once("ready-to-show", () => startupWindow?.show());
    startupWindow.on("closed", () => { startupWindow = null; });
    if (startupDevUrl) {
      void startupWindow.loadURL(startupDevUrl);
    } else {
      void startupWindow.loadFile(startupFilePath || path.join(appDirectory, "dist", "startup.html"));
    }
    return startupWindow;
  }

  function publishSetupMode() {
    const state = {
      mode: setupMode,
      issue: setupIssue,
      hasSavedTmdbCredential: hasTmdbCredential(),
    };
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.webContents.send("setup:mode", state);
    }
    return state;
  }

  function sizeSetupWindowForMode() {
    if (!setupWindow || setupWindow.isDestroyed()) return;
    const gateMode = setupMode === "tmdb-gate";
    setupWindow.setMinimumSize(gateMode ? 520 : 680, gateMode ? 560 : 720);
    if (!setupWindow.isMaximized()) {
      setupWindow.setSize(gateMode ? 620 : 820, gateMode ? 640 : 820, true);
      setupWindow.center();
    }
  }

  function createSetupWindow(options = {}) {
    setupMode = options.mode || "settings";
    setupIssue = String(options.issue || "").trim();
    if (setupWindow && !setupWindow.isDestroyed()) {
      sizeSetupWindowForMode();
      publishSetupMode();
      setupWindow.show();
      setupWindow.focus();
      return setupWindow;
    }

    setupWindow = createSetupBrowserWindow({
      iconPath: appResourcePaths.appIcon,
      preloadPath: appResourcePaths.setupPreload,
      mode: setupMode,
    });
    setupWindow.webContents.on("did-finish-load", publishSetupMode);
    setupWindow.on("closed", () => {
      const closedMode = setupMode;
      const mainWindow = getMainWindow();
      setupWindow = null;
      setupMode = "settings";
      setupIssue = "";
      if (closedMode === "tmdb-gate" && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        app.quit();
      }
    });
    if (setupDevUrl) {
      void setupWindow.loadURL(setupDevUrl);
    } else {
      void setupWindow.loadFile(setupFilePath || path.join(appDirectory, "dist", "setup.html"));
    }
    return setupWindow;
  }

  function sendStartupStatus(message) {
    if (startupWindow && !startupWindow.isDestroyed()) {
      startupWindow.webContents.send("startup:status", message);
    }
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.webContents.send("setup:status", message);
    }
  }

  function sendSetupCheck(id, state, message) {
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.webContents.send("setup:check", { id, state, message });
    }
  }

  async function startApplicationRuntime({ showStartup = true } = {}) {
    if (runtimeStartPromise) return runtimeStartPromise;

    runtimeStartPromise = (async () => {
      if (showStartup) createStartupWindow();
      publishRuntimeState({ status: "starting", message: "Starting playback services...", code: "RUNTIME_STARTING" });
      try {
        await runtimeManager.startBackend((message) => {
          sendStartupStatus(message);
          publishRuntimeState({ status: "starting", message, code: "RUNTIME_STARTING" });
        });
        publishRuntimeState({ status: "ready", message: "Playback is ready.", code: "RUNTIME_READY" });
        startupWindow?.close();
        if (!getMainWindow()) createMainWindow();
        return { ok: true, state: runtimeState };
      } catch (error) {
        console.error("[Startup] Runtime failed:", error);
        publishRuntimeState({
          status: "error",
          message: error.message || "Playback services could not start.",
          code: error.code || "RUNTIME_START_FAILED",
        });
        startupWindow?.close();
        const mainWindow = getMainWindow();
        if (!mainWindow) createMainWindow();
        else {
          mainWindow.show();
          mainWindow.focus();
        }
        return { ok: false, state: runtimeState };
      }
    })();

    try {
      return await runtimeStartPromise;
    } finally {
      runtimeStartPromise = null;
    }
  }

  async function checkSavedTmdbCredential() {
    const credentials = appConfigStore.resolveSetupCredentials({});
    if (!credentials.tmdbAccessToken && !credentials.tmdbApiKey) {
      return {
        ok: false,
        issue: "Add a TMDb access token or API key to continue.",
        requiresSetup: true,
        code: "TMDB_CREDENTIAL_MISSING",
      };
    }
    try {
      await verifyTmdbConnection(credentials);
      return { ok: true, issue: "", requiresSetup: false, code: "" };
    } catch (error) {
      return {
        ok: false,
        issue: error?.message || "TMDb could not be verified. Check your connection and try again.",
        requiresSetup: error?.code === "TMDB_CREDENTIAL_REJECTED",
        code: error?.code || "TMDB_REQUEST_FAILED",
      };
    }
  }

  async function continueAfterTmdbReady({ showStartup = true } = {}) {
    if (!runtimeManager.isConfigured()) {
      startupWindow?.close();
      createSetupWindow({ mode: "settings" });
      return { ok: true, next: "setup" };
    }

    if (runtimeManager.isRuntimeConfigured()) {
      await startApplicationRuntime({ showStartup });
    } else {
      startupWindow?.close();
      publishRuntimeState({
        status: "setup-required",
        message: "Browsing is ready. Add your playback connection when you want to watch.",
        code: "PLAYBACK_SETUP_REQUIRED",
      });
      if (!getMainWindow()) createMainWindow();
    }

    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    return { ok: true, next: "home" };
  }

  async function bootstrapApplication() {
    if (process.argv.includes("--setup") || !runtimeManager.isConfigured()) {
      createSetupWindow({ mode: "settings" });
      return;
    }

    createStartupWindow();
    sendStartupStatus("Checking TMDb…");
    publishCatalogState({ status: "checking", issue: "" });
    const tmdb = await checkSavedTmdbCredential();
    if (!tmdb.ok && tmdb.requiresSetup) {
      console.warn("[TMDb Gate] Home blocked:", tmdb.issue);
      requireTmdbSetup(tmdb.issue);
      return;
    }
    if (!tmdb.ok) {
      console.warn("[TMDb] Availability check failed; opening TorWatch without the credential gate:", tmdb.issue);
    }
    publishCatalogState({ status: "ready", issue: "" });
    await continueAfterTmdbReady({ showStartup: true });
  }

  return {
    bootstrapApplication,
    checkSavedTmdbCredential,
    continueAfterTmdbReady,
    createSetupWindow,
    createStartupWindow,
    getCatalogState,
    getRuntimeState,
    getSetupIssue,
    getSetupMode,
    getSetupWindow,
    getStartupWindow,
    hasTmdbCredential,
    publishRuntimeState,
    publishCatalogState,
    requireTmdbSetup,
    publishSetupMode,
    sendSetupCheck,
    sendStartupStatus,
    setSetupIssue,
    startApplicationRuntime,
  };
}
