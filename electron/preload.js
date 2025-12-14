const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  playInMpv: (url) => ipcRenderer.invoke("mpv:play", url),
  pauseMpv: (paused) => ipcRenderer.invoke("mpv:pause", paused),
  seekMpv: (seconds, relative = true) => ipcRenderer.invoke("mpv:seek", seconds, relative),
  getMpvState: () => ipcRenderer.invoke("mpv:state"),
  stopMpv: () => ipcRenderer.invoke("mpv:stop"),
  setVolume: (volume) => ipcRenderer.invoke("mpv:setVolume", volume),
  setMute: (mute) => ipcRenderer.invoke("mpv:setMute", mute),
  startStack: () => ipcRenderer.invoke("stack:up"),
});

