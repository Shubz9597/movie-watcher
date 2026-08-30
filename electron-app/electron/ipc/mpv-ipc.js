import { buildPlaybackIdentity } from "../playback/playback-identity.js";

export async function waitForDecodedVideo(handle, {
  assertActive = () => {},
  sleep,
  timeoutMs = 75_000,
  pollIntervalMs = 250,
  now = Date.now,
} = {}) {
  if (typeof sleep !== "function") throw new TypeError("waitForDecodedVideo requires a sleep function");

  const deadline = now() + timeoutMs;
  let consecutiveVideoSamples = 0;
  while (now() < deadline) {
    assertActive();
    const state = handle.getState();
    const hasVideo = typeof state?.videoFormat === "string" && state.videoFormat.trim().length > 0;
    consecutiveVideoSamples = hasVideo ? consecutiveVideoSamples + 1 : 0;

    // MPV can publish duration and the requested resume position before the
    // first video frame has been decoded. Releasing the loader on either of
    // those values exposes a blank native host until the decoder catches up.
    // A stable video format is the first state we expose to the renderer.
    if (consecutiveVideoSamples >= 2) return state;
    await sleep(pollIntervalMs);
  }
  throw new Error("The video did not become ready. Choose another source.");
}

export function isPlaybackEndedState(state) {
  if (state?.eofReached === true) return true;

  // Older native bindings do not expose eof-reached. With keep-open enabled,
  // MPV pauses on the final frame, so retain a narrow compatibility fallback.
  const time = Number(state?.time);
  const duration = Number(state?.duration);
  return state?.paused === true
    && Number.isFinite(time)
    && Number.isFinite(duration)
    && duration > 0
    && time >= duration - 0.75;
}

export function registerMpvIpc(ipcMain, {
  getMainWindow,
  mpvSession,
  playbackController,
  playerSurface,
  sleep,
  vodBase,
}) {
  let mpvPlayPromise = null;
  let mpvPlayAbortController = null;
  let mpvStopPromise = null;
  let mpvLifecycleGeneration = 0;
  let currentPlaybackIdentity = null;
  let playbackEndedDispatched = false;

  function notifyBackendPlaybackState(state) {
    return playbackController.notifyBackendPlaybackState(state);
  }

  async function saveCurrentProgress({ waitForPending = false } = {}) {
    return playbackController.saveCurrentProgress({ waitForPending });
  }

  function clearProgressHeartbeat() {
    playbackController.clearProgressHeartbeat();
  }

  async function applyResumeAndTrack(session, resumePosition) {
    return playbackController.applyResumeAndTrack(session, resumePosition);
  }

  function resetSkipSegmentLookup(payload, playbackIdentity) {
    playbackController.resetSkipSegmentLookup(payload, playbackIdentity);
  }

  function clearSkipSegmentLookup() {
    playbackController.clearSkipSegmentLookup();
  }

  function maybeLoadSkipSegments(durationSeconds) {
    playbackController.maybeLoadSkipSegments(durationSeconds);
  }

  function cancelSubtitleLoad() {
    playbackController.cancelSubtitleLoad();
  }

  function assertPlaybackRequestActive(generation, signal) {
    if (!signal?.aborted && generation === mpvLifecycleGeneration) return;
    const error = new Error("Playback start was cancelled");
    error.name = "AbortError";
    throw error;
  }

  async function acquirePlaybackSession(generation, signal) {
    return mpvSession.acquireSession({
      assertActive: () => assertPlaybackRequestActive(generation, signal),
    });
  }

  async function waitForTorrentMetadata(magnet, cat = "movie", fileIndex = null, signal = null) {
    if (!magnet?.startsWith("magnet:")) {
      throw new Error("Playback requires a literal magnet URI");
    }

    const filesUrl = new URL(`${vodBase}/files`);
    filesUrl.searchParams.set("magnet", magnet);
    filesUrl.searchParams.set("cat", cat);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), 35_000);

    try {
      const response = await fetch(filesUrl, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).trim();
        if (response.status === 504) {
          throw new Error("No reachable peers returned torrent metadata. Choose another source.");
        }
        throw new Error(detail || `Torrent metadata request failed (HTTP ${response.status})`);
      }

      const files = await response.json();
      if (!Array.isArray(files) || files.length === 0) {
        throw new Error("The torrent did not provide any playable files. Choose another source.");
      }
      if (Number.isInteger(fileIndex) && fileIndex >= 0 && !files.some((file) => file?.index === fileIndex)) {
        throw new Error("The selected episode is not present in this torrent. Choose another source.");
      }
    } catch (err) {
      if (err?.name === "AbortError") {
        if (signal?.aborted) throw new Error("Playback stopped");
        throw new Error("Torrent metadata discovery timed out. Choose another source.");
      }
      if (err instanceof TypeError) {
        throw new Error("TorWatch service is not responding. Restart TorWatch and try again.");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async function shutdownPlayback() {
    mpvLifecycleGeneration += 1;
    const backendStopPromise = notifyBackendPlaybackState("stop");
    mpvPlayAbortController?.abort();
    clearProgressHeartbeat();
    cancelSubtitleLoad();
    await saveCurrentProgress({ waitForPending: true });
    playbackController.resetProgress();
    mpvSession.shutdown();
    mpvSession.destroyVideoHost();
    await backendStopPromise;
  }

  function stopPlayback(reason = "stopped") {
    if (mpvStopPromise) return mpvStopPromise;

    mpvStopPromise = (async () => {
      try {
        console.log(`[MPV] Stop handler called (${reason})`);

        mpvLifecycleGeneration += 1;
        clearSkipSegmentLookup();
        const backendStopPromise = notifyBackendPlaybackState("stop");
        mpvPlayAbortController?.abort();

        // If close arrives while a session is still being created, let that
        // work settle first and then tear down the single resulting host.
        if (mpvPlayPromise) await mpvPlayPromise;
        else if (mpvSession.initPromise) await mpvSession.initPromise;

        clearProgressHeartbeat();
        cancelSubtitleLoad();
        await saveCurrentProgress({ waitForPending: true });
        playbackController.resetProgress();

        // Stop and fully destroy the MPV session. Merely hiding the host is not
        // reliable: force-window/keep-open can repaint a black native child over
        // Chromium after returning to the home screen.
        if (mpvSession.handle) {
          mpvSession.shutdown({ stop: true });
          console.log("[MPV] Video session destroyed");
        } else {
          console.log("[MPV] Stop ignored - MPV not initialized");
        }
        await backendStopPromise;

        if (playerSurface.hideControlsOverlay()) {
          console.log("[MPV] Controls overlay hidden");
        }

        // Destroy the host as well so no native surface can remain above the app.
        if (mpvSession.wid) {
          mpvSession.destroyVideoHost();
          console.log("[MPV] Native video host destroyed");
        }

        playbackController.resetAfterStop();
        playerSurface.resetAspectMode();
        playerSurface.clearVideoHostRect();

        // Always restore the normal application window before navigating away
        // from the player. Otherwise the home UI is left trapped in fullscreen.
        await playerSurface.setFullscreen(false);

        if (playerSurface.restoreMainWindowAfterStop({ reason })) {
          console.log("[MPV] Main window shown and focused");
        }

        return { ok: true };
      } catch (err) {
        console.error("[MPV] Stop error:", err);
        return { ok: false, error: err.message };
      } finally {
        currentPlaybackIdentity = null;
        mpvStopPromise = null;
      }
    })();

    return mpvStopPromise;
  }

  ipcMain.handle("mpv:play", async (_event, payload) => {
    // Opening another title immediately after closing the player used to race
    // teardown and attempt to use the handle that was being destroyed.
    if (mpvStopPromise) await mpvStopPromise;

    // Prevent duplicate play calls from racing and leaving windows hidden.
    if (mpvPlayPromise) return mpvPlayPromise;

    const playGeneration = ++mpvLifecycleGeneration;
    const playPromise = (async () => {
      const playAbortController = new AbortController();
      mpvPlayAbortController = playAbortController;
      try {
        console.log("[MPV] play handler called with payload:", payload);

        let url, title, cat, fileIndex, magnet;
        if (typeof payload === "string") {
          url = payload;
          title = "Playing";
          cat = "movie";
          fileIndex = null;
          magnet = null;
        } else if (payload && typeof payload === "object") {
          url = payload.url;
          title = payload.title;
          cat = payload.cat;
          fileIndex = payload.fileIndex;
          magnet = payload.magnet || null;
        } else {
          console.error("[MPV] Invalid payload:", payload);
          return { ok: false, error: "Invalid payload: expected object with url, title, cat, fileIndex" };
        }

        if (!url) {
          console.error("[MPV] No URL provided in payload");
          return { ok: false, error: "URL is required" };
        }

        console.log("[MPV] Extracted parameters:", { url, title, cat, fileIndex, magnet: magnet ? "provided" : "not provided" });
        const playbackIdentity = buildPlaybackIdentity(title, payload);
        currentPlaybackIdentity = playbackIdentity;
        playbackEndedDispatched = false;
        resetSkipSegmentLookup(payload, playbackIdentity);

        // Retire asynchronous work from the previous item before the shared
        // controls window is reset for this one.
        playbackController.retireAsyncWork();

        // Cover the renderer before progress lookup, metadata discovery,
        // fullscreen transition, and native-host creation.
        await playerSurface.showLoadingOverlay(playbackIdentity, payload);
        assertPlaybackRequestActive(playGeneration, playAbortController.signal);

        const { currentProgress, resumePosition, session } = await playbackController.prepareProgress(payload);
        const source = playbackController.setPlaybackSource({ cat, fileIndex, magnet, url });

        // Do not report playback as started until the torrent has supplied its
        // metadata. MPV load is asynchronous and otherwise hides the backend's
        // 504, leaving the controls overlay stuck on "Finding peers" forever.
        await waitForTorrentMetadata(source.currentMagnet || url, source.currentPlaybackCat, source.currentPlaybackFileIndex, playAbortController.signal);
        assertPlaybackRequestActive(playGeneration, playAbortController.signal);

        // Acquire a complete matching handle/host pair. Never read the mutable
        // global handle directly after an await: close/open and fullscreen work
        // can replace the globally published session while a start is pending.
        let playbackSession = await acquirePlaybackSession(playGeneration, playAbortController.signal);

        const streamUrl = playbackController.resolveCurrentStream({ url, cat, fileIndex });
        assertPlaybackRequestActive(playGeneration, playAbortController.signal);
        console.log("[MPV] Resolved stream URL:", streamUrl);
        playerSurface.clearVideoHostRect();

        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          await playerSurface.setFullscreen(true);
          assertPlaybackRequestActive(playGeneration, playAbortController.signal);
          playbackSession = await acquirePlaybackSession(playGeneration, playAbortController.signal);

          playerSurface.ensureVideoHostParent(playbackSession.handle);

          mainWindow.setTitle(`TorWatch - ${playbackIdentity.title}${playbackIdentity.episodeCode ? ` · ${playbackIdentity.episodeCode}` : ""}`);
          playerSurface.syncWindows();
          mpvSession.showVideoHost();
          playerSurface.moveControlsTop();
          await sleep(100);
          assertPlaybackRequestActive(playGeneration, playAbortController.signal);
          playbackSession = await acquirePlaybackSession(playGeneration, playAbortController.signal);
          mpvSession.showVideoHost(playbackSession.wid, true);
          playerSurface.moveControlsTop();
          console.log("[MPV] Native video host shown inside main window");
        }

        const playbackHandle = playbackSession.handle;
        console.log("[MPV] Loading video URL...");
        playbackHandle.load(streamUrl, resumePosition > 0 ? resumePosition : undefined);
        playbackHandle.setAudioDelay(0);
        playbackHandle.setSubtitleDelay(0);
        playerSurface.resetAndApplyAspectMode(playbackHandle);

        const controlsAvailable = playerSurface.showControlsOverlay();
        if (controlsAvailable) {
          playbackController.startBufferPolling({ cat });
          console.log("[MPV] Loading overlay shown while video prepares");
        }

        playbackHandle.pause(false);
        await waitForDecodedVideo(playbackHandle, {
          assertActive: () => assertPlaybackRequestActive(playGeneration, playAbortController.signal),
          sleep,
        });
        assertPlaybackRequestActive(playGeneration, playAbortController.signal);
        mpvSession.showVideoHost(playbackSession.wid, true);
        playerSurface.moveControlsTop();
        playerSurface.sendControls("mpv:playbackLoaded");
        console.log("[MPV] Video decoded and ready");

        if (currentProgress) {
          void applyResumeAndTrack(session, resumePosition);
        }

        if (controlsAvailable) {
          playbackController.beginSubtitleDiscovery(payload);
          console.log("[MPV] Playback controls shown");
        }

        return { ok: true, streamUrl, resumedFrom: resumePosition };
      } catch (err) {
        const cancelled = playAbortController.signal.aborted || playGeneration !== mpvLifecycleGeneration || err?.name === "AbortError";
        if (cancelled) console.log("[MPV] Playback start cancelled");
        else {
          console.error("[MPV] Play error:", err);
          playerSurface.showLoadingError(err?.message || "Playback could not be started.");
        }
        if (playGeneration === mpvLifecycleGeneration) {
          playbackController.clearSourceAfterFailedStart();
        }
        return { ok: false, error: err.message || String(err) };
      } finally {
        if (mpvPlayAbortController === playAbortController) mpvPlayAbortController = null;
      }
    })();

    mpvPlayPromise = playPromise;
    try {
      return await playPromise;
    } finally {
      if (mpvPlayPromise === playPromise) mpvPlayPromise = null;
    }
  });

  ipcMain.handle("mpv:pause", async (_event, paused) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      handle.pause(Boolean(paused));
      await notifyBackendPlaybackState(paused ? "pause" : "play");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:seek", async (_event, seconds, relative) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      handle.seek(Number(seconds), Boolean(relative));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:state", async () => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      const state = handle.getState();
      maybeLoadSkipSegments(state?.duration);
      if (
        !playbackEndedDispatched
        && Number(currentPlaybackIdentity?.episode) > 0
        && isPlaybackEndedState(state)
      ) {
        playbackEndedDispatched = true;
        console.log("[MPV] Episode reached end of file; opening the next episode source list");
        setImmediate(() => { void stopPlayback("ended"); });
      }
      if (state && typeof state.volume === "number") {
        state.volume = state.volume / 100;
      }
      return { ok: true, state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:stop", async () => stopPlayback("stopped"));

  ipcMain.handle("window:toggleFullscreen", async () => {
    try {
      return await playerSurface.toggleFullscreen();
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:setVolume", async (_event, volume) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      const mpvVolume = Math.max(0, Math.min(100, Number(volume) * 100));
      handle.setVolume(mpvVolume);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:setMute", async (_event, mute) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      handle.setMute(Boolean(mute));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  function normalizeSyncDelay(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) {
      throw new Error("Sync delay must be a finite number");
    }
    return Math.round(Math.max(-30, Math.min(30, value)) * 10) / 10;
  }

  ipcMain.handle("mpv:setAudioDelay", async (_event, seconds) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      const value = normalizeSyncDelay(seconds);
      handle.setAudioDelay(value);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:setSubtitleDelay", async (_event, seconds) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      const value = normalizeSyncDelay(seconds);
      handle.setSubtitleDelay(value);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:cycleAspect", async () => {
    try {
      if (!mpvSession.handle) return { ok: false, error: "MPV not ready" };
      const mode = playerSurface.cycleAspectMode();
      return { ok: true, mode: mode.id, label: mode.label };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:isReady", () => {
    return {
      ok: true,
      ready: !mpvStopPromise && mpvSession.initialized && mpvSession.handle !== null && mpvSession.wid !== null,
    };
  });

  ipcMain.handle("mpv:waitForReady", async () => {
    if (mpvStopPromise) await mpvStopPromise;
    if (mpvSession.initialized && mpvSession.handle !== null && mpvSession.wid !== null) {
      return { ok: true, ready: true };
    }
    const ready = await mpvSession.ensureInitialized();
    return { ok: true, ready };
  });

  ipcMain.handle("mpv:embed", async (_event, bounds) => {
    try {
      if (!mpvSession.wid) {
        return { ok: false, error: "MPV video host not initialized" };
      }

      const mainWindow = getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        playerSurface.setVideoHostRect(bounds);
        mpvSession.showVideoHost();
        await sleep(100);

        return { ok: true };
      }

      return { ok: false, error: "Main window not available" };
    } catch (err) {
      console.error("[MPV] Embed error:", err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("mpv:bufferInfo", async (_event, params) => {
    try {
      return await playbackController.getBufferInfo(params);
    } catch (err) {
      console.error("[MPV] Buffer info error:", err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle("mpv:loadSub", async (_event, request) => {
    return playbackController.loadSubtitle(request);
  });

  ipcMain.handle("mpv:setAudio", async (_event, index) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      handle.setAudioTrack(Number(index));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("mpv:setSub", async (_event, index) => {
    try {
      const { handle } = mpvSession;
      if (!handle) return { ok: false, error: "MPV not ready" };
      cancelSubtitleLoad();
      handle.setSubtitleTrack(Number(index));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  return {
    shutdownPlayback,
  };
}
