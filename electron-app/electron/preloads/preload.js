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

contextBridge.exposeInMainWorld("electronAPI", {
  // Debug helper: forward renderer logs to main process terminal
  debugLog: (...args) => ipcRenderer.send("debug:log", args),
  // MPV controls
  playInMpv: (payload) => ipcRenderer.invoke("mpv:play", payload),
  pauseMpv: (paused) => ipcRenderer.invoke("mpv:pause", paused),
  seekMpv: (seconds, relative) => ipcRenderer.invoke("mpv:seek", seconds, relative),
  getMpvState: () => ipcRenderer.invoke("mpv:state"),
  stopMpv: () => ipcRenderer.invoke("mpv:stop"),
  setVolume: (volume) => ipcRenderer.invoke("mpv:setVolume", volume),
  setMute: (mute) => ipcRenderer.invoke("mpv:setMute", mute),
  setAudioDelay: (seconds) => ipcRenderer.invoke("mpv:setAudioDelay", seconds),
  setSubtitleDelay: (seconds) => ipcRenderer.invoke("mpv:setSubtitleDelay", seconds),
  cycleAspect: () => ipcRenderer.invoke("mpv:cycleAspect"),
  isMpvReady: () => ipcRenderer.invoke("mpv:isReady"),
  waitForMpvReady: () => ipcRenderer.invoke("mpv:waitForReady"),
  // MPV embedding and buffer info
  embedMpv: (bounds) => ipcRenderer.invoke("mpv:embed", bounds),
  getBufferInfo: (params) => ipcRenderer.invoke("mpv:bufferInfo", params),
  loadSubtitle: (url) => ipcRenderer.invoke("mpv:loadSub", url),
  setAudioTrack: (index) => ipcRenderer.invoke("mpv:setAudio", index),
  setSubtitleTrack: (index) => ipcRenderer.invoke("mpv:setSub", index),
  onMpvStopped: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("mpv:stopped", listener);
    return () => ipcRenderer.removeListener("mpv:stopped", listener);
  },
  // Window controls
  toggleFullscreen: () => ipcRenderer.invoke("window:toggleFullscreen"),
  // Config management (secure storage)
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (config) => ipcRenderer.invoke("config:set", config),
  openSetup: () => ipcRenderer.invoke("app:open-setup"),
  openTmdbGate: (message) => ipcRenderer.invoke("catalog-gate:open", message),
  openTmdbGuide: () => ipcRenderer.invoke("setup:open-tmdb-guide"),
  getCatalogState: () => ipcRenderer.invoke("catalog:get-state"),
  repairTmdb: (replacement) => ipcRenderer.invoke("setup:repair-tmdb", replacement),
  requestTmdb: (request) => ipcRenderer.invoke("tmdb:request", request),
  onCatalogState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("catalog:state", listener);
    return () => ipcRenderer.removeListener("catalog:state", listener);
  },
  getRuntimeState: () => ipcRenderer.invoke("runtime:get-state"),
  retryRuntime: () => ipcRenderer.invoke("runtime:retry"),
  onRuntimeState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("runtime:state", listener);
    return () => ipcRenderer.removeListener("runtime:state", listener);
  },
  getDiagnosticLogPaths: () => ipcRenderer.invoke("diagnostics:get-paths"),
  openDiagnosticLogs: () => ipcRenderer.invoke("diagnostics:open-folder"),
});



