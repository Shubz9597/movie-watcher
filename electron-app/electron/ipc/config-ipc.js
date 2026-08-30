export function registerConfigIpc(ipcMain, { getPublicConfig, saveConfig }) {
  ipcMain.handle("config:get", () => getPublicConfig());

  ipcMain.handle("config:set", (_event, config) => {
    try {
      saveConfig(config);
      return { ok: true };
    } catch (err) {
      console.error("[Config] Failed to save config:", err);
      return { ok: false, error: err.message };
    }
  });
}
