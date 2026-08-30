export function registerDiagnosticsIpc(ipcMain, { diagnosticLog, shell }) {
  ipcMain.on("diagnostics:renderer-exception", (event, details) => {
    diagnosticLog.write(
      "error",
      `renderer:${event.sender.getType()}:${event.sender.id}`,
      details?.type || "renderer exception",
      details,
    );
  });

  ipcMain.handle("diagnostics:get-paths", () => diagnosticLog.paths);
  ipcMain.handle("diagnostics:open-folder", async () => {
    const error = await shell.openPath(diagnosticLog.paths.directory);
    return error ? { ok: false, error } : { ok: true };
  });
}
