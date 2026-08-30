import crypto from "crypto";
import { pathToFileURL } from "url";

import { downloadSubtitleForMpv } from "./subtitle-cache.js";
import { fetchResumePosition, postProgress, progressFromPayload } from "./progress-api.js";
import { getSkipSegments } from "./skip-segments.js";
import { resolveStreamUrl } from "./stream-url.js";

export function createPlaybackController({
  getControlsWindow,
  getMpvHandle,
  getUserDataPath,
  sleep,
  vodBase,
  resumeToleranceSeconds,
  resumeVerifyTimeoutMs,
}) {
  let currentStreamUrl = null;
  let currentMagnet = null;
  let currentPlaybackCat = "movie";
  let currentPlaybackFileIndex = null;
  let currentSubtitleFileIndex = null;
  let currentSubtitlePayload = null;
  let currentSubtitleRequest = 0;
  let currentSubtitleSelection = 0;
  let currentSubtitleLoadAbortController = null;
  let currentSkipSegmentContext = null;
  let currentSkipSegmentLookup = null;
  let currentSkipSegmentAbortController = null;
  let currentSkipSegmentGeneration = 0;
  let bufferPollInterval = null;
  let bufferPollAbortController = null;
  let progressHeartbeatInterval = null;
  let progressSavePromise = null;
  let currentProgress = null;
  let progressSession = 0;
  let pendingResume = null;
  let backendPlaybackStateQueue = Promise.resolve();

  function controlsWindow() {
    const window = getControlsWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  function sendControls(channel, payload) {
    controlsWindow()?.webContents.send(channel, payload);
  }

  function notifyBackendPlaybackState(state) {
    const magnet = currentMagnet;
    const cat = currentPlaybackCat;
    const fileIndex = currentPlaybackFileIndex;
    if (!magnet) return Promise.resolve(false);

    const url = new URL(`${vodBase}/buffer/state`);
    url.searchParams.set("magnet", magnet);
    url.searchParams.set("cat", cat);
    if (fileIndex !== null) {
      url.searchParams.set("fileIndex", String(fileIndex));
    }
    url.searchParams.set("state", state);

    const send = async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) {
          console.warn(`[MPV] Backend rejected ${state} state with HTTP ${response.status}`);
          return false;
        }
        return true;
      } catch (err) {
        console.warn(`[MPV] Failed to notify backend of ${state} state:`, err.message);
        return false;
      } finally {
        clearTimeout(timeout);
      }
    };

    backendPlaybackStateQueue = backendPlaybackStateQueue.then(send, send);
    return backendPlaybackStateQueue;
  }

  async function saveCurrentProgress({ waitForPending = false } = {}) {
    if (waitForPending && progressSavePromise) {
      try { await progressSavePromise; } catch {}
    } else if (progressSavePromise) {
      return progressSavePromise;
    }

    const mpvHandle = getMpvHandle();
    if (!currentProgress || !mpvHandle) return undefined;
    let state;
    try {
      state = mpvHandle.getState();
    } catch {
      return undefined;
    }
    const position = Number(state?.time || 0);
    const duration = Number(state?.duration || 0);
    if (!Number.isFinite(position) || !Number.isFinite(duration) || position <= 0 || duration <= 0) return undefined;

    if (pendingResume?.session === progressSession) {
      if (position < pendingResume.position - resumeToleranceSeconds) return undefined;
      pendingResume = null;
    }

    const progress = { ...currentProgress };
    const request = postProgress(vodBase, progress, position, duration)
      .catch((err) => console.warn("[Progress] Heartbeat failed:", err.message))
      .finally(() => {
        if (progressSavePromise === request) progressSavePromise = null;
      });
    progressSavePromise = request;
    return request;
  }

  function clearProgressHeartbeat() {
    if (progressHeartbeatInterval) {
      clearInterval(progressHeartbeatInterval);
      progressHeartbeatInterval = null;
    }
  }

  async function prepareProgress(payload) {
    clearProgressHeartbeat();
    await saveCurrentProgress({ waitForPending: true });
    currentProgress = progressFromPayload(payload);
    const session = ++progressSession;
    const resumePosition = await fetchResumePosition(vodBase, currentProgress);
    pendingResume = currentProgress && resumePosition > 0 ? { session, position: resumePosition } : null;
    return { currentProgress, resumePosition, session };
  }

  async function applyResumeAndTrack(session, resumePosition) {
    if (session !== progressSession || !currentProgress) return;
    clearProgressHeartbeat();
    progressHeartbeatInterval = setInterval(() => {
      void saveCurrentProgress();
    }, 10000);

    if (resumePosition <= 0) return;

    const deadline = Date.now() + resumeVerifyTimeoutMs;
    let nextFallbackSeekAt = 0;
    let lastSeekError = null;
    while (Date.now() < deadline && session === progressSession) {
      try {
        const mpvHandle = getMpvHandle();
        const state = mpvHandle?.getState();
        const position = Number(state?.time || 0);
        if (Number.isFinite(position) && position >= resumePosition - resumeToleranceSeconds) {
          if (pendingResume?.session === session) pendingResume = null;
          console.log(`[Progress] Resume verified at ${position.toFixed(1)}s (target ${resumePosition}s)`);
          return;
        }

        if (Date.now() >= nextFallbackSeekAt && Number(state?.duration || 0) > resumePosition) {
          mpvHandle.seek(resumePosition, false);
          nextFallbackSeekAt = Date.now() + 2000;
        }
      } catch (err) {
        lastSeekError = err;
      }
      await sleep(250);
    }

    if (session === progressSession) {
      const detail = lastSeekError?.message ? ` Last seek error: ${lastSeekError.message}` : "";
      console.warn(`[Progress] Could not verify resume at ${resumePosition}s within ${resumeVerifyTimeoutMs / 1000}s.${detail}`);
    }
  }

  function resetProgress() {
    currentProgress = null;
    pendingResume = null;
    progressSession += 1;
  }

  function setPlaybackSource({ cat, fileIndex, magnet, url }) {
    currentPlaybackCat = cat || "movie";
    const parsedPlaybackFileIndex = Number(fileIndex);
    currentPlaybackFileIndex = fileIndex !== undefined && fileIndex !== null && Number.isInteger(parsedPlaybackFileIndex) && parsedPlaybackFileIndex >= 0
      ? parsedPlaybackFileIndex
      : null;
    currentSubtitleFileIndex = currentPlaybackFileIndex;

    if (magnet) {
      currentMagnet = magnet;
      console.log("[MPV] Stored source URL for backend API calls:", magnet.substring(0, 50) + (magnet.length > 50 ? "..." : ""));
    } else if (url) {
      currentMagnet = url;
      console.log("[MPV] Using URL as source for backend API calls");
    } else {
      currentMagnet = null;
      console.warn("[MPV] No source URL available - backend API calls will fail");
    }

    return {
      currentMagnet,
      currentPlaybackCat,
      currentPlaybackFileIndex,
    };
  }

  function resolveCurrentStream({ url, cat, fileIndex }) {
    const streamUrl = resolveStreamUrl(vodBase, currentMagnet || url, cat || "movie", fileIndex);
    currentStreamUrl = streamUrl;
    return streamUrl;
  }

  function clearSourceAfterFailedStart() {
    stopBufferPolling();
    currentStreamUrl = null;
    currentMagnet = null;
    currentPlaybackFileIndex = null;
    currentSubtitleFileIndex = null;
  }

  function resetSkipSegmentLookup(payload, playbackIdentity) {
    currentSkipSegmentGeneration += 1;
    currentSkipSegmentAbortController?.abort();
    currentSkipSegmentAbortController = null;
    currentSkipSegmentLookup = null;
    currentSkipSegmentContext = {
      kind: playbackIdentity.kind,
      malId: Number(payload?.malId) || undefined,
      tmdbId: Number(payload?.tmdbId) || undefined,
      imdbId: String(payload?.imdbId || "").trim() || undefined,
      season: playbackIdentity.season,
      episode: playbackIdentity.episode,
      absoluteEpisode: Number(payload?.absoluteEpisode) || undefined,
    };
    sendControls("mpv:skipSegments", []);
  }

  function clearSkipSegmentLookup() {
    currentSkipSegmentGeneration += 1;
    currentSkipSegmentAbortController?.abort();
    currentSkipSegmentAbortController = null;
    currentSkipSegmentLookup = null;
    currentSkipSegmentContext = null;
    sendControls("mpv:skipSegments", []);
  }

  function maybeLoadSkipSegments(durationSeconds) {
    if (currentSkipSegmentLookup || !currentSkipSegmentContext) return;
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) return;

    const context = { ...currentSkipSegmentContext, durationSeconds: duration };
    const generation = currentSkipSegmentGeneration;
    const controller = new AbortController();
    currentSkipSegmentAbortController = controller;
    currentSkipSegmentLookup = getSkipSegments(context, { signal: controller.signal })
      .then((segments) => {
        if (generation !== currentSkipSegmentGeneration || controller.signal.aborted) return;
        const identity = context.kind === "anime"
          ? `MAL ${context.malId} episode ${context.episode}`
          : `TMDb/IMDb episode S${context.season}E${context.episode}`;
        console.log(
          `[SkipSegments] ${identity}: ${segments.length > 0 ? segments.map((segment) => segment.type).join(", ") : "no segments found"}`,
        );
        sendControls("mpv:skipSegments", segments);
      })
      .finally(() => {
        if (generation !== currentSkipSegmentGeneration) return;
        currentSkipSegmentAbortController = null;
      });
  }

  function sendSubtitleState(payload) {
    sendControls("mpv:subtitleTracks", payload);
  }

  function cancelSubtitleLoad() {
    currentSubtitleSelection += 1;
    currentSubtitleLoadAbortController?.abort();
    currentSubtitleLoadAbortController = null;
  }

  async function fetchSubtitleTracks(payload, requestId) {
    sendSubtitleState({ status: "loading", source: "none", tracks: [] });
    try {
      if (!currentMagnet) throw new Error("Playback source is unavailable");

      const endpoint = new URL(`${vodBase}/subtitles/list`);
      endpoint.searchParams.set("magnet", currentMagnet);
      endpoint.searchParams.set("cat", currentPlaybackCat);
      if (Number.isInteger(currentSubtitleFileIndex) && currentSubtitleFileIndex >= 0) {
        endpoint.searchParams.set("fileIndex", String(currentSubtitleFileIndex));
      }

      const values = {
        imdbId: payload?.imdbId,
        tmdbId: payload?.tmdbId,
        title: payload?.title,
        year: payload?.year,
        season: payload?.season,
        episode: payload?.episode,
      };
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== null && String(value).trim() !== "" && Number(value) !== 0) {
          endpoint.searchParams.set(key, String(value));
        }
      }
      endpoint.searchParams.set("langs", "en");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetch(endpoint, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Subtitle service returned ${response.status}`);

      const data = await response.json();
      if (requestId !== currentSubtitleRequest) return;
      const tracks = Array.isArray(data?.tracks)
        ? data.tracks.map((track) => ({
            ...track,
            url: new URL(String(track.url || ""), vodBase).toString(),
          })).filter((track) => track.url.startsWith(`${vodBase}/subtitles/`))
        : [];
      sendSubtitleState({
        status: "ready",
        source: data?.source || "none",
        tracks,
        message: data?.message || "",
        fallbackUsed: data?.fallbackUsed === true,
        providerConfigured: data?.providerConfigured !== false,
      });
    } catch (err) {
      if (requestId !== currentSubtitleRequest) return;
      const message = err?.name === "AbortError"
        ? "Subtitle lookup timed out."
        : err.message || "Subtitle lookup failed.";
      console.warn("[Subtitles] Lookup failed:", message);
      sendSubtitleState({ status: "error", source: "none", tracks: [], message });
    }
  }

  function beginSubtitleDiscovery(payload) {
    currentSubtitlePayload = payload && typeof payload === "object" ? { ...payload } : {};
    cancelSubtitleLoad();
    const subtitleRequest = ++currentSubtitleRequest;
    void fetchSubtitleTracks(currentSubtitlePayload, subtitleRequest);
  }

  function refreshSubtitleDiscovery() {
    if (!currentSubtitlePayload || !currentMagnet) return false;
    beginSubtitleDiscovery(currentSubtitlePayload);
    return true;
  }

  async function loadSubtitle(request) {
    const selection = ++currentSubtitleSelection;
    currentSubtitleLoadAbortController?.abort();
    const controller = new AbortController();
    currentSubtitleLoadAbortController = controller;
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const mpvHandle = getMpvHandle();
      if (!mpvHandle) return { ok: false, error: "MPV not ready" };
      const rawUrl = typeof request === "object" ? request?.url : request;
      const format = typeof request === "object" ? request?.format : "vtt";
      const subtitleUrl = new URL(String(rawUrl || ""));
      if (subtitleUrl.origin !== new URL(vodBase).origin || !subtitleUrl.pathname.startsWith("/subtitles/")) {
        return { ok: false, error: "Only backend subtitle URLs are allowed" };
      }
      const downloaded = await downloadSubtitleForMpv({
        subtitleUrl: subtitleUrl.toString(),
        format,
        signal: controller.signal,
        userDataPath: getUserDataPath(),
      });
      if (selection !== currentSubtitleSelection) return { ok: false, cancelled: true };
      mpvHandle.loadSubtitle(pathToFileURL(downloaded.filePath).toString());
      mpvHandle.setSubtitleDelay(0);
      return { ok: true, cached: downloaded.cached, subtitleDelay: 0 };
    } catch (err) {
      if (err?.name === "AbortError" || selection !== currentSubtitleSelection) {
        return { ok: false, cancelled: true };
      }
      return { ok: false, error: err.message };
    } finally {
      clearTimeout(timeout);
      if (currentSubtitleLoadAbortController === controller) currentSubtitleLoadAbortController = null;
    }
  }

  function stopBufferPolling() {
    if (bufferPollInterval) {
      clearInterval(bufferPollInterval);
      bufferPollInterval = null;
    }
    bufferPollAbortController?.abort();
    bufferPollAbortController = null;
  }

  function startBufferPolling({ cat }) {
    stopBufferPolling();
    bufferPollInterval = setInterval(async () => {
      if (!controlsWindow() || !currentMagnet) {
        stopBufferPolling();
        return;
      }
      if (bufferPollAbortController) return;

      const controller = new AbortController();
      bufferPollAbortController = controller;
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const bufferQuery = new URLSearchParams({
          magnet: currentMagnet,
          cat: cat || "movie",
        });
        if (currentPlaybackFileIndex !== null) {
          bufferQuery.set("fileIndex", String(currentPlaybackFileIndex));
        }
        const bufferResult = await fetch(`${vodBase}/buffer/info?${bufferQuery.toString()}`, {
          signal: controller.signal,
        });

        if (bufferResult.ok) {
          const bufferData = await bufferResult.json();
          const contiguousAhead = bufferData.contiguousAhead || 0;
          const targetBytes = bufferData.targetBytes || 0;
          const fileLength = bufferData.fileLength || 0;
          let percentage = 0;
          let status = "connecting";

          if (targetBytes > 0 && fileLength > 0) {
            percentage = Math.min(100, (contiguousAhead / targetBytes) * 100);
            status = percentage >= 100 ? "ready" : percentage >= 10 ? "buffering" : "connecting";
          } else if (targetBytes > 0) {
            percentage = Math.min(100, (contiguousAhead / targetBytes) * 100);
            status = percentage >= 100 ? "ready" : percentage >= 10 ? "buffering" : "connecting";
          }

          sendControls("mpv:loadingState", { status, percentage });
          sendControls("mpv:torrentHealth", {
            ...bufferData,
            sourceId: bufferData.infoHash || crypto.createHash("sha256").update(currentMagnet).digest("hex").slice(0, 40),
            status,
            bufferPercentage: percentage,
            pollingError: false,
            polledAt: Date.now(),
            sampledAt: Date.now(),
          });
        } else {
          sendControls("mpv:torrentHealth", {
            pollingError: true,
            polledAt: Date.now(),
          });
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          console.error("[MPV] Buffer polling error:", err);
        }
        sendControls("mpv:torrentHealth", {
          pollingError: true,
          polledAt: Date.now(),
        });
      } finally {
        clearTimeout(timeout);
        if (bufferPollAbortController === controller) {
          bufferPollAbortController = null;
        }
      }
    }, 1000);
  }

  async function getBufferInfo(params) {
    let magnet = currentMagnet;
    let cat = "movie";
    let fileIndex = "0";

    if (!magnet && currentStreamUrl) {
      try {
        const url = new URL(currentStreamUrl);
        magnet = url.searchParams.get("magnet");
        cat = url.searchParams.get("cat") || "movie";
        fileIndex = url.searchParams.get("fileIndex") || "0";
      } catch (err) {
        console.warn("[MPV] Could not parse stream URL:", err.message);
      }
    }

    if (!magnet) {
      console.error("[MPV] No magnet URI available for buffer info");
      return { ok: false, error: "No magnet URI available" };
    }

    const bufferUrl = new URL(`${vodBase}/buffer/info`);
    bufferUrl.searchParams.set("magnet", magnet);
    bufferUrl.searchParams.set("cat", cat);
    bufferUrl.searchParams.set("fileIndex", fileIndex);
    bufferUrl.searchParams.set("sse", params?.sse ? "1" : "0");

    console.log("[MPV] Requesting buffer info:", bufferUrl.toString());
    const response = await fetch(bufferUrl.toString());
    if (!response.ok) {
      console.error("[MPV] Buffer info request failed:", response.status, response.statusText);
      return { ok: false, error: `HTTP ${response.status}` };
    }

    if (params?.sse) {
      const text = await response.text();
      return { ok: true, data: text };
    }
    const data = await response.json();
    return { ok: true, data };
  }

  function retireAsyncWork() {
    currentSubtitleRequest += 1;
    cancelSubtitleLoad();
    stopBufferPolling();
  }

  function resetAfterStop() {
    currentStreamUrl = null;
    currentMagnet = null;
    currentPlaybackCat = "movie";
    currentPlaybackFileIndex = null;
    currentSubtitleFileIndex = null;
    currentSubtitlePayload = null;
    currentSubtitleRequest += 1;
    stopBufferPolling();
  }

  return {
    applyResumeAndTrack,
    beginSubtitleDiscovery,
    cancelSubtitleLoad,
    clearProgressHeartbeat,
    clearSkipSegmentLookup,
    clearSourceAfterFailedStart,
    getBufferInfo,
    get currentProgress() { return currentProgress; },
    get currentSource() {
      return {
        magnet: currentMagnet,
        cat: currentPlaybackCat,
        fileIndex: currentPlaybackFileIndex,
      };
    },
    loadSubtitle,
    maybeLoadSkipSegments,
    notifyBackendPlaybackState,
    prepareProgress,
    resetAfterStop,
    resetProgress,
    refreshSubtitleDiscovery,
    resetSkipSegmentLookup,
    resolveCurrentStream,
    retireAsyncWork,
    saveCurrentProgress,
    setPlaybackSource,
    startBufferPolling,
    stopBufferPolling,
  };
}
