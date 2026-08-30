import path from "path";

import { applyAspectModeTo } from "../playback/aspect-modes.js";
import {
  ASPECT_MODES,
  PLAYER_WINDOW_CHROME_HEIGHT,
  VIDEO_HOST_OVERSCAN,
} from "../playback/constants.js";
import { attachMpvWindow, readNativeWindowId } from "../playback/native-window.js";
import { createControlsBrowserWindow } from "./controls-window.js";

export function createPlayerSurfaceController({
  appDirectory,
  controlsDevUrl,
  controlsFilePath,
  controlsPreloadPath,
  getMainWindow,
  getMpvSession,
  sleep,
}) {
  let controlsWindow = null;
  let windowDrag = null;
  let videoHostRect = null;
  let aspectModeIndex = 0;

  function getContentScreenBounds() {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (typeof mainWindow.getContentBounds === "function") {
        return mainWindow.getContentBounds();
      }
      return mainWindow.getBounds();
    }
    return { x: 100, y: 100, width: 1280, height: 720 };
  }

  function isFullscreen() {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isFullScreen() || mainWindow.isKiosk();
  }

  function getPlayerSurfaceScreenBounds() {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { x: 100, y: 100, width: 1280, height: 720 };
    }

    // In fullscreen, the display-sized outer bounds are the canonical player
    // surface. On Windows, getContentBounds() can briefly retain the decorated
    // frame inset while kiosk mode is being applied, which shifts the transparent
    // HUD down and exposes a strip of video above the top scrim.
    return isFullscreen()
      ? mainWindow.getBounds()
      : getContentScreenBounds();
  }

  function getPlayerViewportScreenBounds() {
    const bounds = getPlayerSurfaceScreenBounds();
    if (isFullscreen()) return bounds;
    return {
      x: bounds.x,
      y: bounds.y + PLAYER_WINDOW_CHROME_HEIGHT,
      width: bounds.width,
      height: Math.max(1, bounds.height - PLAYER_WINDOW_CHROME_HEIGHT),
    };
  }

  function getVideoHostRect() {
    const mainWindow = getMainWindow();
    if (videoHostRect) return videoHostRect;
    if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.getContentSize === "function") {
      const [width, height] = mainWindow.getContentSize();
      // Native child windows can expose a one-pixel line after Windows DPI or
      // maximize rounding. Overscan behind the content edge so black slivers
      // cannot appear at the top or bottom of the player.
      if (isFullscreen()) {
        return {
          x: -VIDEO_HOST_OVERSCAN,
          y: -VIDEO_HOST_OVERSCAN,
          width: width + VIDEO_HOST_OVERSCAN * 2,
          height: height + VIDEO_HOST_OVERSCAN * 2,
        };
      }
      return {
        x: -VIDEO_HOST_OVERSCAN,
        y: PLAYER_WINDOW_CHROME_HEIGHT,
        width: width + VIDEO_HOST_OVERSCAN * 2,
        height: Math.max(1, height - PLAYER_WINDOW_CHROME_HEIGHT + VIDEO_HOST_OVERSCAN),
      };
    }
    const bounds = getContentScreenBounds();
    const chromeHeight = isFullscreen() ? 0 : PLAYER_WINDOW_CHROME_HEIGHT;
    return {
      x: -VIDEO_HOST_OVERSCAN,
      y: chromeHeight || -VIDEO_HOST_OVERSCAN,
      width: bounds.width + VIDEO_HOST_OVERSCAN * 2,
      height: Math.max(1, bounds.height - chromeHeight + VIDEO_HOST_OVERSCAN),
    };
  }

  function getControlsBounds() {
    const contentBounds = getPlayerSurfaceScreenBounds();
    // The transparent controls window should match the visible content exactly;
    // only the native video surface needs overscan.
    if (!videoHostRect) return getPlayerViewportScreenBounds();
    return {
      x: contentBounds.x + videoHostRect.x,
      y: contentBounds.y + videoHostRect.y,
      width: videoHostRect.width,
      height: videoHostRect.height,
    };
  }

  function syncControlsWindowBounds() {
    if (!controlsWindow || controlsWindow.isDestroyed()) return;

    // Electron 44 constrains an ordinary owned window to the Windows work area,
    // even when its parent is in kiosk mode. Put the HUD into kiosk with the
    // player so it can cover the taskbar-sized strip at the bottom, then apply
    // the canonical player bounds. Leaving playback reverses both transitions.
    if (process.platform === "win32") {
      const targetKiosk = isFullscreen();
      if (controlsWindow.isKiosk() !== targetKiosk) {
        controlsWindow.setKiosk(targetKiosk);
      }
    }
    controlsWindow.setBounds(getControlsBounds());
  }

  function syncWindows() {
    getMpvSession().resizeVideoHost(getVideoHostRect());
    syncControlsWindowBounds();
  }

  function scheduleSync() {
    for (const delay of [0, 100, 300]) {
      setTimeout(() => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) syncWindows();
      }, delay);
    }
  }

  function sendFullscreenState(fullscreen) {
    if (controlsWindow && !controlsWindow.isDestroyed() && !controlsWindow.webContents.isLoading()) {
      controlsWindow.webContents.send("mpv:fullscreen", Boolean(fullscreen));
    }
  }

  function restoreKeyboardFocus() {
    if (!controlsWindow || controlsWindow.isDestroyed() || !controlsWindow.isVisible()) return;
    for (const delay of [0, 120]) {
      setTimeout(() => {
        if (!controlsWindow || controlsWindow.isDestroyed() || !controlsWindow.isVisible()) return;
        controlsWindow.moveTop();
        controlsWindow.focus();
      }, delay);
    }
  }

  async function setFullscreen(fullscreen) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: "Main window not available" };
    }

    const target = Boolean(fullscreen);
    if (target) windowDrag = null;
    if (isFullscreen() === target) {
      scheduleSync();
      sendFullscreenState(target);
      restoreKeyboardFocus();
      return { ok: true, fullscreen: target };
    }

    // Chromium fullscreen can occasionally leave a maximized, decorated window
    // on Windows even though the request completed. Kiosk mode uses the native
    // borderless display path, so the title bar and taskbar are guaranteed to be
    // outside the playback surface. F/Escape still leave it through our handlers.
    if (process.platform === "win32") {
      mainWindow.setKiosk(target);
    } else {
      mainWindow.setFullScreen(target);
    }

    // Wait for the native window transition and verify the resulting state. The
    // fallback also covers window managers that decline regular fullscreen.
    const deadline = Date.now() + 1200;
    while (isFullscreen() !== target && Date.now() < deadline) {
      await sleep(25);
    }
    if (target && !isFullscreen()) {
      mainWindow.setKiosk(true);
    } else if (!target && isFullscreen()) {
      mainWindow.setKiosk(false);
      mainWindow.setFullScreen(false);
    }

    const actual = isFullscreen();
    scheduleSync();
    sendFullscreenState(actual);
    restoreKeyboardFocus();
    return actual === target
      ? { ok: true, fullscreen: actual }
      : { ok: false, fullscreen: actual, error: "Window manager did not apply fullscreen" };
  }

  function toggleFullscreen() {
    return setFullscreen(!isFullscreen());
  }

  function notifyStopped(reason = "stopped") {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mpv:stopped", { reason });
    }
  }

  function handleMainWindowClosed() {
    windowDrag = null;
    getMpvSession().destroyVideoHost();
  }

  function bindMainWindow() {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    mainWindow.on("resize", scheduleSync);
    mainWindow.on("move", scheduleSync);
    mainWindow.on("maximize", scheduleSync);
    mainWindow.on("unmaximize", scheduleSync);
    mainWindow.on("enter-full-screen", scheduleSync);
    mainWindow.on("leave-full-screen", scheduleSync);

    // Keep F11/Escape recoverable even when the player overlay is closed and
    // focus has returned to the main renderer.
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      if (input.key === "F11") {
        event.preventDefault();
        void toggleFullscreen();
      } else if (input.key === "Escape" && isFullscreen()) {
        event.preventDefault();
        void setFullscreen(false);
      }
    });
  }

  function ensureControlsWindow() {
    const mainWindow = getMainWindow();
    if (controlsWindow && !controlsWindow.isDestroyed()) return controlsWindow;
    if (!mainWindow || mainWindow.isDestroyed()) return null;

    controlsWindow = createControlsBrowserWindow({
      parent: mainWindow,
      bounds: getControlsBounds(),
      preloadPath: controlsPreloadPath,
    });
    controlsWindow.on("closed", () => { controlsWindow = null; });
    controlsWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isAutoRepeat) return;
      if (input.key === "F11") {
        event.preventDefault();
        void toggleFullscreen();
      } else if (input.key === "Escape" && isFullscreen()) {
        event.preventDefault();
        void setFullscreen(false);
      }
    });

    const loadControls = controlsDevUrl
      ? controlsWindow.loadURL(controlsDevUrl)
      : controlsWindow.loadFile(controlsFilePath || path.join(appDirectory, "dist", "player-controls.html"));
    loadControls.catch((err) => {
      console.error("[MPV] Failed to load player controls:", err);
    });
    return controlsWindow;
  }

  async function showLoadingOverlay(playbackIdentity, payload) {
    const nextControlsWindow = ensureControlsWindow();
    if (!nextControlsWindow || nextControlsWindow.isDestroyed()) {
      throw new Error("Player loading overlay is unavailable");
    }

    if (nextControlsWindow.webContents.isLoading()) {
      await new Promise((resolve) => {
        nextControlsWindow.webContents.once("did-finish-load", resolve);
      });
    }
    if (nextControlsWindow.isDestroyed()) {
      throw new Error("Player loading overlay closed during startup");
    }

    const metadata = payload && typeof payload === "object" ? payload : {};
    syncControlsWindowBounds();
    nextControlsWindow.webContents.send("mpv:identity", playbackIdentity);
    nextControlsWindow.webContents.send("mpv:fullscreen", isFullscreen());
    nextControlsWindow.webContents.send("mpv:loadingMeta", {
      title: playbackIdentity.title,
      kind: playbackIdentity.kind,
      year: metadata.year ? Number(metadata.year) : undefined,
      posterUrl: metadata.posterUrl || undefined,
      season: playbackIdentity.season,
      episode: playbackIdentity.episode,
      episodeCode: playbackIdentity.episodeCode,
      episodeLabel: playbackIdentity.episodeLabel,
    });
    nextControlsWindow.webContents.send("mpv:loadingState", {
      status: "connecting",
      percentage: 0,
      failed: false,
    });
    nextControlsWindow.show();
    nextControlsWindow.moveTop();
    nextControlsWindow.focus();
    scheduleSync();
  }

  function showLoadingError(message) {
    return sendControls("mpv:loadingState", {
      status: String(message || "Playback could not be started."),
      percentage: 0,
      failed: true,
    });
  }

  function showControlsOverlay() {
    if (!controlsWindow || controlsWindow.isDestroyed()) return false;
    syncControlsWindowBounds();
    controlsWindow.webContents.send("mpv:fullscreen", isFullscreen());
    controlsWindow.show();
    controlsWindow.moveTop();
    controlsWindow.focus();
    scheduleSync();
    return true;
  }

  function hideControlsOverlay() {
    windowDrag = null;
    if (!controlsWindow || controlsWindow.isDestroyed()) return false;
    controlsWindow.hide();
    return true;
  }

  function sendControls(channel, ...args) {
    if (!controlsWindow || controlsWindow.isDestroyed()) return false;
    controlsWindow.webContents.send(channel, ...args);
    return true;
  }

  function moveControlsTop() {
    if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.moveTop();
  }

  function clearVideoHostRect() {
    videoHostRect = null;
  }

  function setVideoHostRect(bounds) {
    videoHostRect = {
      x: Math.max(0, Number(bounds?.x || 0)),
      y: Math.max(0, Number(bounds?.y || 0)),
      width: Math.max(1, Number(bounds?.width || 1280)),
      height: Math.max(1, Number(bounds?.height || 720)),
    };
    syncWindows();
  }

  function ensureVideoHostParent(handle) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return false;

    const mpvSession = getMpvSession();
    const currentParentWid = readNativeWindowId(mainWindow);
    if (currentParentWid === mpvSession.hostParentWid) return false;

    console.log("[MPV] Main native handle changed; recreating video host");
    const wid = mpvSession.recreateVideoHost(currentParentWid, getVideoHostRect());
    attachMpvWindow(handle, wid);
    return true;
  }

  function resetAspectMode() {
    aspectModeIndex = 0;
    return ASPECT_MODES[aspectModeIndex];
  }

  function applyCurrentAspectMode(handle = getMpvSession().handle) {
    return applyAspectModeTo(handle, ASPECT_MODES[aspectModeIndex]);
  }

  function resetAndApplyAspectMode(handle = getMpvSession().handle) {
    resetAspectMode();
    return applyCurrentAspectMode(handle);
  }

  function cycleAspectMode() {
    aspectModeIndex = (aspectModeIndex + 1) % ASPECT_MODES.length;
    return applyCurrentAspectMode();
  }

  function restoreMainWindowAfterStop({ title = "TorWatch", reason = "stopped" } = {}) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.setTitle(title);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.moveTop();
    notifyStopped(reason);
    return true;
  }

  function isControlsSender(event) {
    return Boolean(
      controlsWindow
      && !controlsWindow.isDestroyed()
      && event.sender === controlsWindow.webContents
    );
  }

  function readScreenPoint(point) {
    const screenX = Number(point?.screenX);
    const screenY = Number(point?.screenY);
    return Number.isFinite(screenX) && Number.isFinite(screenY) ? { screenX, screenY } : null;
  }

  function handleDragStart(event, point) {
    const mainWindow = getMainWindow();
    if (!isControlsSender(event) || !mainWindow || mainWindow.isDestroyed() || isFullscreen()) return;
    const cursor = readScreenPoint(point);
    if (!cursor) return;

    // Match native title-bar behavior: pulling a maximized player restores it
    // beneath the cursor, then continues the same drag in the restored window.
    if (mainWindow.isMaximized()) {
      const maximizedBounds = mainWindow.getBounds();
      const horizontalRatio = Math.min(1, Math.max(0, (cursor.screenX - maximizedBounds.x) / maximizedBounds.width));
      const titleOffset = Math.min(32, Math.max(0, cursor.screenY - maximizedBounds.y));
      mainWindow.unmaximize();
      const restoredBounds = mainWindow.getBounds();
      mainWindow.setPosition(
        Math.round(cursor.screenX - restoredBounds.width * horizontalRatio),
        Math.round(cursor.screenY - titleOffset)
      );
    }

    const bounds = mainWindow.getBounds();
    windowDrag = {
      senderId: event.sender.id,
      offsetX: cursor.screenX - bounds.x,
      offsetY: cursor.screenY - bounds.y,
    };
  }

  function handleDragMove(event, point) {
    const mainWindow = getMainWindow();
    if (!windowDrag || windowDrag.senderId !== event.sender.id || !isControlsSender(event)) return;
    if (!mainWindow || mainWindow.isDestroyed() || isFullscreen()) {
      windowDrag = null;
      return;
    }
    const cursor = readScreenPoint(point);
    if (!cursor) return;
    mainWindow.setPosition(
      Math.round(cursor.screenX - windowDrag.offsetX),
      Math.round(cursor.screenY - windowDrag.offsetY)
    );
  }

  function handleDragEnd(event) {
    if (windowDrag?.senderId === event.sender.id) windowDrag = null;
  }

  function registerDragIpc(ipcMain) {
    ipcMain.on("window:dragStart", handleDragStart);
    ipcMain.on("window:dragMove", handleDragMove);
    ipcMain.on("window:dragEnd", handleDragEnd);
  }

  return {
    applyCurrentAspectMode,
    bindMainWindow,
    clearVideoHostRect,
    cycleAspectMode,
    ensureVideoHostParent,
    get controlsWindow() { return controlsWindow; },
    get currentAspectMode() { return ASPECT_MODES[aspectModeIndex]; },
    getVideoHostRect,
    hideControlsOverlay,
    handleMainWindowClosed,
    isFullscreen,
    moveControlsTop,
    registerDragIpc,
    resetAndApplyAspectMode,
    resetAspectMode,
    restoreMainWindowAfterStop,
    sendControls,
    setFullscreen,
    setVideoHostRect,
    showControlsOverlay,
    showLoadingError,
    showLoadingOverlay,
    syncWindows,
    toggleFullscreen,
  };
}
