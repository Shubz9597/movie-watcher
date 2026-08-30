import { BrowserWindow } from "electron";

export function createStartupBrowserWindow({ iconPath, preloadPath }) {
  return new BrowserWindow({
    icon: iconPath,
    width: 410,
    height: 250,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}
