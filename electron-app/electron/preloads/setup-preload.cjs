const { contextBridge, ipcRenderer } = require("electron");

function serializeThrown(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, code: value.code };
  }
  return { message: String(value) };
}

window.addEventListener("error", (event) => {
  ipcRenderer.send("diagnostics:renderer-exception", {
    type: "uncaught_exception",
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno,
    error: serializeThrown(event.error),
  });
});

window.addEventListener("unhandledrejection", (event) => {
  ipcRenderer.send("diagnostics:renderer-exception", {
    type: "unhandled_rejection",
    error: serializeThrown(event.reason),
  });
});

contextBridge.exposeInMainWorld("setupAPI", {
  getDefaults: () => ipcRenderer.invoke("setup:get-defaults"),
  getMode: () => ipcRenderer.invoke("setup:get-mode"),
  verifySavedCredentials: () => ipcRenderer.invoke("setup:verify-saved-credentials"),
  repairTmdb: (replacement) => ipcRenderer.invoke("setup:repair-tmdb", replacement),
  chooseDataDirectory: () => ipcRenderer.invoke("setup:choose-data-directory"),
  test: (configuration) => ipcRenderer.invoke("setup:test", configuration),
  complete: () => ipcRenderer.invoke("setup:complete"),
  installDocker: () => ipcRenderer.invoke("setup:install-docker"),
  openGuide: () => ipcRenderer.invoke("setup:open-guide"),
  openTmdbGuide: () => ipcRenderer.invoke("setup:open-tmdb-guide"),
  openOpenSubtitlesGuide: () => ipcRenderer.invoke("setup:open-opensubtitles-guide"),
  openVpnGuide: () => ipcRenderer.invoke("setup:open-vpn-guide"),
  openProwlarr: () => ipcRenderer.invoke("setup:open-prowlarr"),
  openProwlarrGuide: () => ipcRenderer.invoke("setup:open-prowlarr-guide"),
  onStatus: (callback) => ipcRenderer.on("setup:status", (_event, message) => callback(message)),
  onCheck: (callback) => ipcRenderer.on("setup:check", (_event, result) => callback(result)),
  onMode: (callback) => ipcRenderer.on("setup:mode", (_event, state) => callback(state)),
});
