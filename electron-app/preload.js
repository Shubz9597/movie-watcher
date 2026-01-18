const { contextBridge, ipcRenderer } = require("electron");

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
  isMpvReady: () => ipcRenderer.invoke("mpv:isReady"),
  waitForMpvReady: () => ipcRenderer.invoke("mpv:waitForReady"),
  // MPV embedding and buffer info
  embedMpv: (bounds) => ipcRenderer.invoke("mpv:embed", bounds),
  getBufferInfo: (params) => ipcRenderer.invoke("mpv:bufferInfo", params),
  loadSubtitle: (url) => ipcRenderer.invoke("mpv:loadSub", url),
  setAudioTrack: (index) => ipcRenderer.invoke("mpv:setAudio", index),
  setSubtitleTrack: (index) => ipcRenderer.invoke("mpv:setSub", index),
  // Window controls
  toggleFullscreen: () => ipcRenderer.invoke("window:toggleFullscreen"),
  // Config management (secure storage)
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (config) => ipcRenderer.invoke("config:set", config),
});



