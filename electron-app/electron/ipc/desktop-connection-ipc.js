import { probeDesktopServer } from "../config/desktop-connection.js";

export function registerDesktopConnectionIpc(ipcMain, {
  store, activeConnection, vodBase, hasLegacySetup, restart, openGuide,
  probe = probeDesktopServer,
}) {
  let saving = false;
  ipcMain.on("desktop:get-origin", (event) => { event.returnValue = vodBase; });
  ipcMain.on("desktop:get-profile", (event) => {
    event.returnValue = { subjectId: activeConnection?.progressSubjectId || '', clientId: store.getClientId() };
  });
  ipcMain.handle("desktop:get-connection", () => ({
    connection: activeConnection,
    hasLegacySetup,
  }));
  ipcMain.handle("desktop:probe-server", async (_event, candidate) => {
    try { return { ok: true, connection: await probe(candidate) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("desktop:connect-server", async (_event, candidate) => {
    if (saving) return { ok: false, error: "A server connection is already being saved." };
    saving = true;
    try {
      // No settings change on an unreachable or incompatible candidate.
      const checked = await probe(candidate);
      const connection = store.save(checked);
      // Relaunch recreates main-process playback and renderer caches together.
      restart();
      return { ok: true, connection };
    } catch (error) {
      saving = false;
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("desktop:open-server-guide", openGuide);
  // Keep using the built-in services of an earlier version (remembered, so
  // they start on later launches without this screen).
  ipcMain.handle("desktop:use-builtin-services", () => {
    if (!hasLegacySetup) return { ok: false, error: "No built-in services are set up on this computer." };
    try { store.chooseBuiltInServices(); return { ok: true }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}
