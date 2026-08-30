function tmdbRequiresCredentialRepair(error) {
  return error?.code === "TMDB_CREDENTIAL_MISSING"
    || error?.code === "TMDB_CREDENTIAL_REJECTED";
}

export function registerSetupIpc(ipcMain, deps) {
  const {
    dialog,
    shell,
    runtimeManager,
    playbackController,
    vodBase,
    urls,
    getAppConfig,
    getMainWindow,
    getRuntimeState,
    getSetupIssue,
    getSetupMode,
    getSetupWindow,
    setSetupIssue,
    applyTmdbCredential,
    checkSavedTmdbCredential,
    continueAfterTmdbReady,
    createMainWindow,
    createSetupWindow,
    hasTmdbCredential,
    persistAppConfig,
    publishCatalogState,
    publishRuntimeState,
    publishSetupMode,
    resolveSetupCredentials,
    requireTmdbSetup,
    sendSetupCheck,
    sendStartupStatus,
    startApplicationRuntime,
    verifyOpenSubtitlesConnection,
    verifyStorageDirectory,
    verifyTmdbConnection,
  } = deps;

  ipcMain.handle("setup:get-defaults", () => ({
    ...runtimeManager.loadSettings(),
    hasTmdbKey: hasTmdbCredential(),
    hasOpenSubApiKey: Boolean(runtimeManager.loadSecrets().openSubApiKey || process.env.OPENSUB_API_KEY || process.env.OPENSUBTITLES_API_KEY),
    hasOpenSubUserToken: Boolean(runtimeManager.loadSecrets().openSubUserToken || process.env.OPENSUBTITLES_USER_TOKEN || process.env.OPENSUB_USER_TOKEN),
    hasVpnPrivateKey: Boolean(runtimeManager.loadSecrets().vpnPrivateKey),
  }));

  ipcMain.handle("setup:get-mode", () => ({
    mode: getSetupMode(),
    issue: getSetupIssue(),
    hasSavedTmdbCredential: hasTmdbCredential(),
  }));

  ipcMain.handle("catalog-gate:open", (_event, message) => {
    const issue = String(message || "TMDb needs attention before TorWatch can continue.").trim().slice(0, 320);
    requireTmdbSetup(issue);
    return { ok: true };
  });

  ipcMain.handle("setup:repair-tmdb", async (_event, replacement) => {
    const enteredTmdb = String(replacement || "").trim();
    const credentials = resolveSetupCredentials({ tmdbKey: enteredTmdb });
    try {
      await verifyTmdbConnection(credentials);
      if (enteredTmdb) {
        applyTmdbCredential(enteredTmdb);
        runtimeManager.saveCatalogSecrets(getAppConfig());
        persistAppConfig();
      }
      setSetupIssue("");
      publishCatalogState({ status: "ready", issue: "" });
      publishSetupMode();
      const result = await continueAfterTmdbReady({ showStartup: false });
      const setupWindow = getSetupWindow();
      if (result.next === "home" && setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
      return { ok: true, next: result.next };
    } catch (error) {
      const issue = error?.message || "TMDb could not be verified. Try again.";
      if (!tmdbRequiresCredentialRepair(error)) {
        if (enteredTmdb) {
          applyTmdbCredential(enteredTmdb);
          runtimeManager.saveCatalogSecrets(getAppConfig());
          persistAppConfig();
        }
        console.warn("[TMDb] Saved credential without a live availability check:", issue);
        setSetupIssue("");
        publishCatalogState({ status: "ready", issue: "" });
        publishSetupMode();
        const result = await continueAfterTmdbReady({ showStartup: false });
        const setupWindow = getSetupWindow();
        if (result.next === "home" && setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
        return { ok: true, next: result.next, warning: issue };
      }
      setSetupIssue(issue);
      console.warn("[TMDb Gate] Credential verification failed:", issue);
      requireTmdbSetup(issue);
      publishSetupMode();
      return { ok: false, error: issue };
    }
  });

  ipcMain.handle("setup:verify-saved-credentials", async () => {
    const credentials = resolveSetupCredentials({});
    const results = {};

    if (credentials.tmdbAccessToken || credentials.tmdbApiKey) {
      try {
        await verifyTmdbConnection(credentials);
        results.tmdb = { state: "connected", message: "Connected" };
      } catch (error) {
        results.tmdb = {
          state: "failed",
          message: tmdbRequiresCredentialRepair(error) ? "Credential rejected" : "Service unavailable",
          error: error.message,
        };
      }
    }

    if (credentials.openSubApiKey) {
      try {
        await verifyOpenSubtitlesConnection(credentials);
        results.openSubtitles = { state: "connected", message: "Connected" };
      } catch (error) {
        results.openSubtitles = { state: "failed", message: "Needs attention", error: error.message };
      }
    }

    return results;
  });

  ipcMain.handle("setup:choose-data-directory", async () => {
    const result = await dialog.showOpenDialog(getSetupWindow() || getMainWindow(), {
      title: "Choose TorWatch storage folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: runtimeManager.loadSettings().dataDir,
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("setup:install-docker", async () => {
    await shell.openExternal("https://www.docker.com/products/docker-desktop/");
    return { ok: true };
  });

  ipcMain.handle("setup:open-guide", async () => {
    await shell.openExternal(urls.setupGuide);
    return { ok: true };
  });

  ipcMain.handle("setup:open-tmdb-guide", async () => {
    await shell.openExternal(urls.tmdbGuide);
    return { ok: true };
  });

  ipcMain.handle("setup:open-opensubtitles-guide", async () => {
    await shell.openExternal(urls.openSubtitlesGuide);
    return { ok: true };
  });

  ipcMain.handle("subtitles:configure-provider", async (_event, rawAPIKey) => {
    const openSubApiKey = String(rawAPIKey || "").trim();
    if (!openSubApiKey) return { ok: false, error: "Enter your OpenSubtitles API key." };
    try {
      await verifyOpenSubtitlesConnection({ openSubApiKey });
      const response = await fetch(`${vodBase}/subtitles/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: openSubApiKey }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("The subtitle service could not accept the API key.");
      runtimeManager.saveOpenSubtitlesAPIKey(openSubApiKey);
      const refreshStarted = playbackController.refreshSubtitleDiscovery();
      return { ok: true, refreshStarted };
    } catch (error) {
      const message = error?.message === "fetch failed" || error?.name === "TimeoutError"
        ? "OpenSubtitles could not be reached. Check your connection and try again."
        : error?.message || "OpenSubtitles could not be connected.";
      return { ok: false, error: message };
    }
  });

  ipcMain.handle("setup:open-vpn-guide", async () => {
    await shell.openExternal(urls.vpnGuide);
    return { ok: true };
  });

  ipcMain.handle("setup:open-prowlarr", async () => {
    const port = runtimeManager.loadSettings().prowlarrPort;
    await shell.openExternal(`http://127.0.0.1:${port}`);
    return { ok: true };
  });

  ipcMain.handle("setup:open-prowlarr-guide", async () => {
    await shell.openExternal(urls.prowlarrGuide);
    return { ok: true };
  });

  ipcMain.handle("app:open-setup", () => {
    createSetupWindow({ mode: "settings" });
    return { ok: true };
  });

  ipcMain.handle("runtime:get-state", () => getRuntimeState());

  ipcMain.handle("runtime:retry", async () => {
    if (!runtimeManager.isRuntimeConfigured()) {
      return {
        ok: false,
        state: publishRuntimeState({
          status: "setup-required",
          message: "Add your playback connection in Settings before trying again.",
          code: "PLAYBACK_SETUP_REQUIRED",
        }),
      };
    }
    return startApplicationRuntime({ showStartup: false });
  });

  ipcMain.handle("setup:test", async (_event, configuration) => {
    let candidateSaved = false;
    let activeCheck = "storage";
    let tmdbWarning = "";
    try {
      const credentials = resolveSetupCredentials(configuration);

      verifyStorageDirectory(configuration.dataDir);

      activeCheck = "tmdb";
      sendSetupCheck("tmdb", "running", "Checking credential...");
      try {
        await verifyTmdbConnection(credentials);
        sendSetupCheck("tmdb", "passed", "Connected");
      } catch (error) {
        if (tmdbRequiresCredentialRepair(error)) throw error;
        tmdbWarning = error?.message || "TMDb could not be reached to verify the credential.";
        console.warn("[TMDb] Setup is continuing without a live availability check:", tmdbWarning);
        sendSetupCheck("tmdb", "skipped", "Saved; service unavailable");
      }

      activeCheck = "opensubtitles";
      try {
        await verifyOpenSubtitlesConnection(credentials);
      } catch (error) {
        console.warn("[Setup] OpenSubtitles check skipped:", error.message);
        configuration = { ...configuration, openSubApiKey: "", openSubUserToken: "" };
      }

      runtimeManager.saveConfiguration(configuration, { setupComplete: true });
      candidateSaved = true;
      const tmdbKey = String(configuration.tmdbKey || "").trim();
      applyTmdbCredential(tmdbKey);
      persistAppConfig();
      publishCatalogState({ status: "ready", issue: "" });

      if (!runtimeManager.isRuntimeConfigured()) {
        sendSetupCheck("docker", "skipped", "Set up later");
        sendSetupCheck("services", "skipped", "Set up later");
        publishRuntimeState({
          status: "setup-required",
          message: "Browsing is ready. Add your playback connection when you want to watch.",
          code: "PLAYBACK_SETUP_REQUIRED",
        });
        return { ok: true };
      }

      activeCheck = "docker";
      sendSetupCheck("docker", "running", "Checking Docker Desktop...");
      await runtimeManager.ensureDocker((message) => {
        sendStartupStatus(message);
        sendSetupCheck("docker", "running", message);
      });
      sendSetupCheck("docker", "passed", "Ready");

      await runtimeManager.stopBackend();

      activeCheck = "services";
      sendSetupCheck("services", "running", "Starting TorWatch...");
      sendSetupCheck("backend", "waiting", "Starting...");
      await runtimeManager.startBackend((message) => {
        sendStartupStatus(message);
        if (message.includes("Starting TorWatch")) {
          sendSetupCheck("services", "running", message);
        } else if (message.includes("Finishing setup")) {
          sendSetupCheck("services", "passed", "Almost ready");
          sendSetupCheck("backend", "running", "Finishing...");
        }
      }, { allowIncomplete: true });
      sendSetupCheck("services", "passed", "Almost ready");
      sendSetupCheck("backend", "passed", "Ready");

      sendStartupStatus("TorWatch is ready.");
      publishRuntimeState({ status: "ready", message: "Playback is ready.", code: "RUNTIME_READY" });
      return tmdbWarning
        ? { ok: true, warning: `${tmdbWarning} The credential was saved; you can continue and retry TMDb later.` }
        : { ok: true };
    } catch (error) {
      console.error("[Setup] Connection test failed:", error);
      sendSetupCheck(activeCheck, "failed", error.message || "Connection failed");
      if (candidateSaved) {
        publishRuntimeState({
          status: "error",
          message: error.message || "Playback services could not start.",
          code: error.code || "RUNTIME_START_FAILED",
        });
        return {
          ok: true,
          warning: `${error.message || "Playback is not ready."} You can continue and update this later in Settings.`,
          failedCheck: activeCheck,
        };
      }
      return { ok: false, error: error.message || "Connection test failed.", failedCheck: activeCheck };
    }
  });

  ipcMain.handle("setup:complete", async () => {
    if (!runtimeManager.isConfigured() || !hasTmdbCredential()) {
      return { ok: false, error: "Add your TMDb credential before opening TorWatch." };
    }
    const tmdb = await checkSavedTmdbCredential();
    if (!tmdb.ok && tmdb.requiresSetup) {
      return { ok: false, error: tmdb.issue };
    }
    publishCatalogState({ status: "ready", issue: "" });
    getSetupWindow()?.close();
    const mainWindow = getMainWindow();
    if (!mainWindow) createMainWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
    return { ok: true };
  });
}
