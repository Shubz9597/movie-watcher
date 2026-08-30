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

contextBridge.exposeInMainWorld("startupAPI", {
  onStatus: (callback) => ipcRenderer.on("startup:status", (_event, message) => callback(message)),
});
