const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  playInMpv: (payload) => ipcRenderer.invoke("mpv:play", payload),
  pauseMpv: (paused) => ipcRenderer.invoke("mpv:pause", paused),
  seekMpv: (seconds, relative = true) => ipcRenderer.invoke("mpv:seek", seconds, relative),
  getMpvState: () => ipcRenderer.invoke("mpv:state"),
  stopMpv: () => ipcRenderer.invoke("mpv:stop"),
  setVolume: (volume) => ipcRenderer.invoke("mpv:setVolume", volume),
  setMute: (mute) => ipcRenderer.invoke("mpv:setMute", mute),
  toggleFullscreen: () => ipcRenderer.invoke("window:toggleFullscreen"),
  startStack: () => ipcRenderer.invoke("stack:up"),
  isMpvReady: () => ipcRenderer.invoke("mpv:isReady"),
  waitForMpvReady: async () => {
    while (true) {
      const res = await ipcRenderer.invoke("mpv:isReady");
      if (res?.ready) return true;
      await new Promise(r => setTimeout(r, 100));
    }
  },
});
