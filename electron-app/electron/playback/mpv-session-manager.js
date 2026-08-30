import fs from "fs";
import path from "path";
import { createRequire } from "module";

import { applyAspectModeTo } from "./aspect-modes.js";
import { attachMpvWindow, readNativeWindowId } from "./native-window.js";

export function createMpvSessionManager({
  appDirectory,
  getAspectMode,
  getMainWindow,
  getVideoHostRect,
  resourcesPath,
  sleep,
}) {
  let native = null;
  let handle = null;
  let wid = null;
  let hostParentWid = null;
  let initialized = false;
  let initializationError = null;
  let initPromise = null;

  async function loadNative() {
    const resourceMpvDir = resourcesPath ? path.join(resourcesPath, "mpv-embed") : null;
    const possiblePaths = [
      path.join(appDirectory, "..", "native", "mpv-embed", "index.js"),
      resourceMpvDir ? path.join(resourceMpvDir, "index.js") : null,
      path.join(appDirectory, "..", "native", "mpv-embed", "index.aspect.node"),
      resourceMpvDir ? path.join(resourceMpvDir, "index.aspect.node") : null,
      path.join(appDirectory, "..", "native", "mpv-embed", "index.win32-x64-msvc.node"),
      path.join(appDirectory, "..", "native", "mpv-embed", "index.linux-x64-gnu.node"),
      path.join(appDirectory, "..", "native", "mpv-embed", "index.linux-x64-musl.node"),
      path.join(appDirectory, "..", "native", "mpv-embed", "index.linux-arm64-gnu.node"),
      path.join(appDirectory, "..", "native", "mpv-embed", "index.linux-arm64-musl.node"),
      path.join(appDirectory, "..", "native", "mpv-embed", "index.node"),
      resourceMpvDir ? path.join(resourceMpvDir, "index.win32-x64-msvc.node") : null,
      resourceMpvDir ? path.join(resourceMpvDir, "index.linux-x64-gnu.node") : null,
      resourceMpvDir ? path.join(resourceMpvDir, "index.linux-x64-musl.node") : null,
      resourceMpvDir ? path.join(resourceMpvDir, "index.linux-arm64-gnu.node") : null,
      resourceMpvDir ? path.join(resourceMpvDir, "index.linux-arm64-musl.node") : null,
      path.join(appDirectory, "mpv-embed.node"),
      resourcesPath ? path.join(resourcesPath, "mpv-embed.node") : null,
      resourceMpvDir ? path.join(resourceMpvDir, "index.node") : null,
    ];

    const require = createRequire(import.meta.url);
    for (const mpvPath of possiblePaths.filter(Boolean)) {
      if (fs.existsSync(mpvPath)) {
        try {
          native = require(mpvPath);
          console.log("[MPV] Native module loaded from:", mpvPath);
          return true;
        } catch (err) {
          console.warn("[MPV] Failed to load from", mpvPath, err.message);
        }
      }
    }
    console.error("[MPV] Native module not found!");
    return false;
  }

  function discardCurrentSession() {
    const staleHandle = handle;
    const staleWid = wid;
    handle = null;
    wid = null;
    hostParentWid = null;
    initialized = false;

    if (staleHandle) {
      try { staleHandle.shutdown(); } catch (err) {
        console.warn("[MPV] Failed to discard stale handle:", err.message);
      }
    }
    if (staleWid && native?.destroyVideoHost) {
      try { native.destroyVideoHost(staleWid); } catch (err) {
        console.warn("[MPV] Failed to discard stale video host:", err.message);
      }
    }
  }

  async function initialize() {
    if (initPromise) return initPromise;

    if (!handle || !wid) initialized = false;
    if (initialized) return true;
    if (!native && !(await loadNative())) return false;

    initPromise = (async () => {
      let nextHandle = null;
      let nextWid = null;
      let nextParentWid = null;
      try {
        discardCurrentSession();

        const mainWindow = getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
          throw new Error("Main window is not ready");
        }
        if (!native.createVideoHost) {
          throw new Error("Native MPV module does not expose createVideoHost; rebuild native/mpv-embed");
        }

        nextHandle = native.MpvHandle.create();
        console.log("[MPV] Handle created");
        nextParentWid = readNativeWindowId(mainWindow);
        const hostRect = getVideoHostRect();
        nextWid = native.createVideoHost(
          nextParentWid,
          hostRect.x,
          hostRect.y,
          hostRect.width,
          hostRect.height,
        );
        console.log("[MPV] Native video host created:", nextWid, "parent:", nextParentWid);

        attachMpvWindow(nextHandle, nextWid);
        console.log("[MPV] Native window id attached");

        if (typeof nextHandle.setOptionString === "function") {
          nextHandle.setOptionString("panscan", "1.0");
        }
        nextHandle.init({});
        applyAspectModeTo(nextHandle, getAspectMode());
        native.showVideoHost?.(nextWid, false);

        handle = nextHandle;
        wid = nextWid;
        hostParentWid = nextParentWid;
        initialized = true;
        initializationError = null;
        console.log("[MPV] Initialization complete");
        return true;
      } catch (err) {
        initializationError = err?.message || String(err);
        console.error("[MPV] Initialization failed:", err);
        if (nextHandle) {
          try {
            nextHandle.shutdown();
          } catch (shutdownErr) {
            console.warn("[MPV] Failed to clean up handle after init error:", shutdownErr.message);
          }
        }
        if (nextWid && native?.destroyVideoHost) {
          try {
            native.destroyVideoHost(nextWid);
          } catch (destroyErr) {
            console.warn("[MPV] Failed to clean up video host after init error:", destroyErr.message);
          }
        }
        wid = null;
        hostParentWid = null;
        handle = null;
        initialized = false;
        return false;
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  }

  async function ensureInitialized(attempts = 2) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (initialized && handle && wid) return true;
      if (await initialize()) return true;
      if (attempt < attempts) {
        console.warn(`[MPV] Initialization attempt ${attempt} failed; retrying`);
        await sleep(150);
      }
    }
    return false;
  }

  async function acquireSession({ attempts = 2, assertActive }) {
    assertActive?.();
    if (!initialized || !handle || !wid) {
      console.log("[MPV] MPV session unavailable, initializing now...");
      const ready = await ensureInitialized(attempts);
      assertActive?.();
      if (!ready || !initialized || !handle || !wid) {
        const detail = initializationError ? `: ${initializationError}` : "";
        throw new Error(`Video player could not start${detail}`);
      }
      console.log("[MPV] MPV initialized successfully");
    }
    return { handle, wid };
  }

  function resizeVideoHost(rect) {
    if (!wid || !native?.resizeVideoHost) return;
    try {
      native.resizeVideoHost(wid, rect.x, rect.y, rect.width, rect.height);
    } catch (err) {
      console.warn("[MPV] Failed to resize native video host:", err.message);
    }
  }

  function showVideoHost(targetWid = wid, visible = true) {
    native?.showVideoHost?.(targetWid, visible);
  }

  function destroyVideoHost(targetWid = wid) {
    if (!targetWid || !native?.destroyVideoHost) return;
    try {
      native.destroyVideoHost(targetWid);
    } catch (err) {
      console.warn("[MPV] Failed to destroy native video host:", err.message);
    }
    if (targetWid === wid) {
      wid = null;
      hostParentWid = null;
      initialized = false;
    }
  }

  function recreateVideoHost(parentWid, rect) {
    if (!native?.createVideoHost) {
      throw new Error("Native MPV module does not expose createVideoHost; rebuild native/mpv-embed");
    }
    destroyVideoHost(wid);
    hostParentWid = parentWid;
    wid = native.createVideoHost(parentWid, rect.x, rect.y, rect.width, rect.height);
    return wid;
  }

  function shutdown({ stop = false } = {}) {
    if (handle) {
      try {
        if (stop && initialized) handle.stop();
      } catch (err) {
        console.warn("[MPV] Error stopping MPV:", err.message);
      }
      try {
        handle.shutdown();
      } catch (err) {
        console.warn("[MPV] Error shutting down MPV:", err.message);
      }
    }
    handle = null;
    initialized = false;
  }

  function clearSession() {
    handle = null;
    wid = null;
    hostParentWid = null;
    initialized = false;
  }

  return {
    acquireSession,
    clearSession,
    destroyVideoHost,
    ensureInitialized,
    get handle() { return handle; },
    get hostParentWid() { return hostParentWid; },
    get initialized() { return initialized; },
    get initPromise() { return initPromise; },
    get native() { return native; },
    get wid() { return wid; },
    recreateVideoHost,
    resizeVideoHost,
    showVideoHost,
    shutdown,
  };
}
