import { BrowserWindow } from "electron";

export function createSetupBrowserWindow({ iconPath, preloadPath, mode }) {
  const gateMode = mode === "tmdb-gate";
  const window = new BrowserWindow({
    icon: iconPath,
    width: gateMode ? 620 : 820,
    height: gateMode ? 640 : 820,
    minWidth: gateMode ? 520 : 680,
    minHeight: gateMode ? 560 : 720,
    autoHideMenuBar: true,
    backgroundColor: "#0a0a0a",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0a0a",
      symbolColor: "#dadbdf",
      height: 40,
    },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.removeMenu();
  return window;
}
