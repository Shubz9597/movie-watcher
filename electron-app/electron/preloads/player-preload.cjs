const { contextBridge, ipcRenderer } = require("electron");

const INVOKE_CHANNELS = new Set([
  "mpv:stop",
  "mpv:pause",
  "mpv:seek",
  "mpv:state",
  "mpv:setVolume",
  "mpv:setMute",
  "mpv:setAudioDelay",
  "mpv:setSubtitleDelay",
  "mpv:cycleAspect",
  "mpv:loadSub",
  "mpv:setSub",
  "subtitles:configure-provider",
  "setup:open-opensubtitles-guide",
  "window:toggleFullscreen",
]);

const SEND_CHANNELS = new Set([
  "window:dragStart",
  "window:dragMove",
  "window:dragEnd",
]);

const RECEIVE_CHANNELS = new Set([
  "mpv:fullscreen",
  "mpv:title",
  "mpv:identity",
  "mpv:skipSegments",
  "mpv:loadingMeta",
  "mpv:loadingState",
  "mpv:playbackLoaded",
  "mpv:torrentHealth",
  "mpv:subtitleTracks",
]);

function serializeThrown(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack, code: value.code };
  }
  return { message: String(value) };
}

function assertAllowed(channels, channel) {
  if (channels.has(channel)) return;
  throw new Error(`Player IPC channel is not allowed: ${channel}`);
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

contextBridge.exposeInMainWorld("playerAPI", {
  invoke(channel, ...args) {
    assertAllowed(INVOKE_CHANNELS, channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, ...args) {
    assertAllowed(SEND_CHANNELS, channel);
    ipcRenderer.send(channel, ...args);
  },
  on(channel, callback) {
    assertAllowed(RECEIVE_CHANNELS, channel);
    if (typeof callback !== "function") throw new TypeError("Player IPC listener must be a function");
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
