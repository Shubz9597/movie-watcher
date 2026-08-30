import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { isPlaybackEndedState, waitForDecodedVideo } from "../electron/ipc/mpv-ipc.js";
import { createPlaybackController } from "../electron/playback/playback-controller.js";
import { progressFromPayload } from "../electron/playback/progress-api.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

test("decoded-video readiness ignores duration and resume time until video is stable", async () => {
  const states = [
    { duration: 1440, time: 825, videoFormat: "" },
    { duration: 1440, time: 825.2, videoFormat: "" },
    { duration: 1440, time: 825.4, videoFormat: "yuv420p" },
    { duration: 1440, time: 825.6, videoFormat: "yuv420p" },
  ];
  let reads = 0;
  let clock = 0;
  const state = await waitForDecodedVideo({
    getState: () => states[Math.min(reads++, states.length - 1)],
  }, {
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    timeoutMs: 2_000,
    pollIntervalMs: 100,
  });

  assert.equal(reads, 4);
  assert.equal(state.videoFormat, "yuv420p");
});

test("decoded-video readiness resets after a transient video sample", async () => {
  const formats = ["yuv420p", "", "nv12", "nv12"];
  let reads = 0;
  let clock = 0;
  await waitForDecodedVideo({
    getState: () => ({ videoFormat: formats[Math.min(reads++, formats.length - 1)] }),
  }, {
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    timeoutMs: 2_000,
    pollIntervalMs: 100,
  });
  assert.equal(reads, 4);
});

test("decoded-video readiness keeps the loader until timeout when no video arrives", async () => {
  let clock = 0;
  await assert.rejects(
    waitForDecodedVideo({ getState: () => ({ duration: 3600, time: 1200, videoFormat: "" }) }, {
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      timeoutMs: 500,
      pollIntervalMs: 250,
    }),
    /video did not become ready/i,
  );
});

test("episode completion follows MPV eof state with a final-frame compatibility fallback", () => {
  assert.equal(isPlaybackEndedState({ eofReached: true, time: 10, duration: 100, paused: false }), true);
  assert.equal(isPlaybackEndedState({ time: 99.5, duration: 100, paused: true }), true);
  assert.equal(isPlaybackEndedState({ time: 99.5, duration: 100, paused: false }), false);
  assert.equal(isPlaybackEndedState({ time: 98, duration: 100, paused: true }), false);
});

test("episode progress carries a validated next-episode continuation", () => {
  const progress = progressFromPayload({
    subjectId: "device-1",
    seriesId: "anilist:52991",
    season: 1,
    episode: 1,
    nextSeason: 1,
    nextEpisode: 2,
  });

  assert.equal(progress.nextSeason, 1);
  assert.equal(progress.nextEpisode, 2);
});

test("episode progress ignores incomplete or self-referencing continuations", () => {
  const incomplete = progressFromPayload({
    subjectId: "device-1",
    seriesId: "anilist:52991",
    season: 1,
    episode: 1,
    nextSeason: 1,
  });
  const sameEpisode = progressFromPayload({
    subjectId: "device-1",
    seriesId: "anilist:52991",
    season: 1,
    episode: 1,
    nextSeason: 1,
    nextEpisode: 1,
  });

  assert.equal(incomplete.nextSeason, null);
  assert.equal(incomplete.nextEpisode, null);
  assert.equal(sameEpisode.nextSeason, null);
  assert.equal(sameEpisode.nextEpisode, null);
});

test("renderer CSP permits anime episode artwork metadata providers", () => {
  const providerOrigins = ["https://api.ani.zip", "https://anime-kitsu.strem.fun"];
  for (const htmlName of ["index.html", "player-controls.html", "setup.html", "startup.html"]) {
    const html = fs.readFileSync(path.resolve(scriptDir, `../src/${htmlName}`), "utf8");
    const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || "";
    const connectSource = policy.match(/connect-src ([^;]+)/)?.[1] || "";
    for (const origin of providerOrigins) {
      assert.match(connectSource, new RegExp(origin.replaceAll(".", "\\.")), `${htmlName} blocks ${origin}`);
    }
  }
});

test("skip-segment IPC publishes arrays that the player can consume", () => {
  const events = [];
  const controller = createPlaybackController({
    getControlsWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => events.push({ channel, payload }) },
    }),
    getMpvHandle: () => null,
    getUserDataPath: () => "C:\\tmp",
    sleep: async () => {},
    vodBase: "http://127.0.0.1:4001",
    resumeToleranceSeconds: 2,
    resumeVerifyTimeoutMs: 1_000,
  });

  controller.resetSkipSegmentLookup({}, { kind: "anime", season: 1, episode: 1 });
  controller.clearSkipSegmentLookup();

  assert.equal(events.length, 2);
  assert.deepEqual(events.map(({ channel }) => channel), ["mpv:skipSegments", "mpv:skipSegments"]);
  assert.ok(events.every(({ payload }) => Array.isArray(payload)));
});

test("secure player preload exposes only the audited IPC channels", async () => {
  const preloadPath = path.resolve(scriptDir, "../electron/preloads/player-preload.cjs");
  const source = fs.readFileSync(preloadPath, "utf8");
  const invocations = [];
  const sends = [];
  const listeners = new Map();
  let exposed;
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      invocations.push({ channel, args });
      return { ok: true };
    },
    send: (channel, ...args) => sends.push({ channel, args }),
    on: (channel, listener) => listeners.set(channel, listener),
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  const sandbox = {
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } },
        ipcRenderer,
      };
    },
    window: { addEventListener: () => {} },
    console,
    Error,
    TypeError,
    Set,
    String,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: preloadPath });

  assert.equal(exposed.name, "playerAPI");
  await exposed.value.invoke("mpv:state");
  assert.equal(invocations[0].channel, "mpv:state");
  assert.throws(() => exposed.value.invoke("config:get"), /not allowed/i);

  exposed.value.send("window:dragEnd");
  assert.equal(sends[0].channel, "window:dragEnd");
  assert.throws(() => exposed.value.send("debug:log"), /not allowed/i);

  const unsubscribe = exposed.value.on("mpv:playbackLoaded", () => {});
  assert.equal(listeners.has("mpv:playbackLoaded"), true);
  unsubscribe();
  assert.equal(listeners.has("mpv:playbackLoaded"), false);
  assert.throws(() => exposed.value.on("runtime:state", () => {}), /not allowed/i);
});
