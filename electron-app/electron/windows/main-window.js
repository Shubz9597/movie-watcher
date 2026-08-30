import { BrowserWindow } from "electron";

export function createMainBrowserWindow({ iconPath, preloadPath }) {
  const window = new BrowserWindow({
    icon: iconPath,
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 600,
    x: 100,
    y: 100,
    show: true,
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

  // Keep the native MPV child and transparent HUD aligned to the same origin.
  window.removeMenu();
  return window;
}
