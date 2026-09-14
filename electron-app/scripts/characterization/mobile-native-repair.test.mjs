// M1.4 repair-pass regression tests: URL hardening, profile selection,
// lifecycle failure/race paths, settings overlay + origin save flow.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PlaybackClientError,
  PlaybackSessionClient,
  resolveAgainstOrigin,
} from "../../src/platform/playback-session-client.ts";
import {
  NativePlaybackController,
} from "../../src/platform/native-playback-controller.ts";
import {
  SettingsOverlayController,
} from "../../src/mobile/settings-overlay-controller.ts";
import {
  applyServerOrigin,
  normalizeOrigin,
  probeOrigin,
} from "../../src/mobile/origin-config.ts";
import {
  connectionFailureMessage,
} from "../../src/lib/connection-diagnostics.ts";
import {
  createNativePlaybackBridge,
  devicePlaybackProfile,
} from "../../src/platform/native-player.ts";

const HEX = "0123456789abcdef0123456789abcdef01234567";
const ORIGIN = "https://server.example:8443";

test("source hygiene: mobile/shared sources and M1.4 docs contain no mojibake", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const roots = [
    join(repoRoot, "electron-app", "src"),
    join(repoRoot, "docs", "mobile-ui"),
  ];
  const milestoneDocs = [
    "HANDOFF.md",
    "plan.md",
    "spec.md",
    "tasks.md",
    join("evidence", "m1.4-native-mobile-foundation.md"),
  ].map((path) => join(repoRoot, "specs", "002-mobile-shared-ui", path));
  const allowedExtensions = new Set([".ts", ".tsx", ".css", ".md"]);
  const corrupted = /Ã|â€|â‚|Â|�|-Å|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;
  const failures = [];
  const scanFile = (path) => {
    const lines = readFileSync(path, "utf8").split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (corrupted.test(line)) failures.push(`${path}:${index + 1}`);
    });
  };
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (allowedExtensions.has(extname(entry.name))) scanFile(child);
    }
  };
  roots.forEach(visit);
  milestoneDocs.forEach(scanFile);
  assert.deepEqual(failures, [], `mojibake found:\n${failures.join("\n")}`);
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ---- 7. URL resolution hardening ---------------------------------------

test("resolve: contract-relative URLs always win; absolute same-origin accepted", () => {
  assert.equal(
    resolveAgainstOrigin("/v2/playback/sessions/x/master.m3u8", ORIGIN),
    ORIGIN + "/v2/playback/sessions/x/master.m3u8",
  );
  assert.equal(
    resolveAgainstOrigin(ORIGIN + "/v2/playback/sessions/x/media", ORIGIN),
    ORIGIN + "/v2/playback/sessions/x/media",
  );
  // Same origin via default-port equivalence.
  assert.equal(resolveAgainstOrigin("https://server.example/v2/x", "https://server.example"), "https://server.example/v2/x");
});

test("resolve: rejects lookalike, cross-origin, protocol-relative, credential and fragment URLs", () => {
  const malicious = [
    "https://server.example:8443.evil.com/v2/x", // suffix lookalike
    "https://evil.example/v2/x", // different host
    "http://server.example:8443/v2/x", // scheme mismatch
    "https://server.example:8444/v2/x", // port mismatch
    "//evil.example/v2/x", // protocol-relative
    "https://user:pass@server.example:8443/v2/x", // credentials
    ORIGIN + "/v2/x#fragment", // fragment
    "not a url at all", // malformed
  ];
  for (const url of malicious) {
    assert.throws(() => resolveAgainstOrigin(url, ORIGIN), PlaybackClientError, `must reject: ${url}`);
  }
});

test("resolve: client.resolve uses the hardened resolution", () => {
  const client = new PlaybackSessionClient({ getOrigin: () => ORIGIN });
  assert.throws(() => client.resolve("//evil.example/x"), PlaybackClientError);
  assert.throws(() => client.resolve(""), PlaybackClientError);
  const emptyOrigin = new PlaybackSessionClient({ getOrigin: () => "" });
  assert.throws(() => emptyOrigin.resolve("/v2/x"), PlaybackClientError);
});

// ---- 3. Platform-explicit profile selection -----------------------------

test("profile: ios-vlc on ios, android-vlc on android, explicit detection", () => {
  const originalWindow = globalThis.window;
  try {
    globalThis.window = { Capacitor: { getPlatform: () => "ios" } };
    assert.equal(devicePlaybackProfile(), "ios-vlc");
    globalThis.window = { Capacitor: { getPlatform: () => "android" } };
    assert.equal(devicePlaybackProfile(), "android-vlc");
    globalThis.window = { Capacitor: { getPlatform: () => "web" } };
    assert.equal(devicePlaybackProfile(), "ios-vlc", "non-native falls back to the shared baseline");
  } finally {
    globalThis.window = originalWindow;
  }
});

// ---- 6. Playback-session lifecycle failure/race paths -------------------

test("interactive layer: seekBy/toggle/tracks/delays/loadSubtitle are playId-guarded passthroughs", async () => {
  const recorded = [];
  const timeListeners = new Set();
  const trackListeners = new Set();
  const stateListeners = new Set();
  const bridge = {
    play: async (input) => { recorded.push(["play", input.playId]); },
    seek: async (positionSec, playId) => { recorded.push(["seek", positionSec, playId]); },
    seekBy: async (deltaSeconds, playId) => { recorded.push(["seekBy", deltaSeconds, playId]); },
    togglePlayback: async (playId) => { recorded.push(["toggle", playId]); },
    selectAudioTrack: async (trackId, playId) => { recorded.push(["audio", trackId, playId]); },
    selectSubtitleTrack: async (trackId, playId) => { recorded.push(["sub", trackId, playId]); },
    setSubtitleDelay: async (seconds, playId) => { recorded.push(["subDelay", seconds, playId]); },
    setAudioDelay: async (seconds, playId) => { recorded.push(["audioDelay", seconds, playId]); },
    loadSubtitle: async (input) => { recorded.push(["loadSub", input.url, input.playId]); return 7; },
    onTime: (cb) => { timeListeners.add(cb); return () => timeListeners.delete(cb); },
    onState: (cb) => { stateListeners.add(cb); return () => stateListeners.delete(cb); },
    onTracks: (cb) => { trackListeners.add(cb); return () => trackListeners.delete(cb); },
    dismiss: async () => {},
    dispose: async () => {},
  };
  const controller = new NativePlaybackController({ client: stubServer().client, bridge });

  // Before any playback: every interactive call is a silent no-op.
  controller.seekBy(-10);
  controller.togglePlayback();
  controller.selectAudioTrack(1);
  controller.selectSubtitleTrack(null);
  controller.setSubtitleDelay(0.5);
  controller.setAudioDelay(-0.2);
  await assert.rejects(controller.loadSubtitle({ url: ORIGIN + "/sub.vtt" }), /Start playback/);
  assert.deepEqual(recorded, []);

  const session = await controller.start({
    url: ORIGIN + "/m", magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, title: "Movie",
    cat: "movie", season: 0, episode: 0,
  });
  assert.ok(session.sessionId);

  controller.seekTo(90);
  controller.seekBy(-10);
  controller.togglePlayback();
  controller.selectAudioTrack(2);
  controller.selectSubtitleTrack(3);
  controller.selectSubtitleTrack(null);
  controller.setSubtitleDelay(1.5);
  controller.setAudioDelay(-0.3);
  const trackId = await controller.loadSubtitle({ url: ORIGIN + "/sub.vtt", label: "English" });
  assert.equal(trackId, 7, "native track id is returned when reported");

  // Tracks subscription reports current inventory AND streams updates.
  let received = [];
  const detach = controller.subscribeTracks((update) => received.push(update));
  trackListeners.forEach((cb) => cb({ audio: [{ id: 2, label: "AC3 5.1" }], subtitles: [{ id: 3, label: "English" }] }));
  assert.equal(received[received.length - 1].audio[0].label, "AC3 5.1");
  detach();

  try {
    await controller.stop();
  } finally {
    // After teardown: interactive calls are no-ops again.
    const count = recorded.length;
    controller.seekBy(10);
    assert.equal(recorded.length, count, "no interactive calls after teardown");
  }
});

test('native start observes events emitted before play resolves', async () => {
  const fake = fakeBridge();
  fake.bridge.play = async (input) => {
    fake.emitState({ state: 'playing', playId: input.playId });
    fake.emitTime({ currentTime: 12, duration: 100, playId: input.playId });
  };
  const controller = new NativePlaybackController({ client: stubServer().client, bridge: fake.bridge });
  const states = [];
  const times = [];
  controller.subscribeState((state) => states.push(state));
  controller.subscribeTime((time) => times.push(time));
  try {
    await controller.start({ magnet: `magnet:?xt=urn:btih:${HEX}`, cat: 'movie' });
    assert.deepEqual(states, ['playing']);
    assert.equal(times[0].currentTime, 12);
  } finally { await controller.dispose(); }
});

test('subtitle download failures propagate and late completion cannot select a replacement', async () => {
  const fake = fakeBridge();
  fake.bridge.loadSubtitle = async () => { throw new Error('download failed'); };
  const controller = new NativePlaybackController({ client: stubServer().client, bridge: fake.bridge });
  try {
    await controller.start({ magnet: `magnet:?xt=urn:btih:${HEX}`, cat: 'movie' });
    await assert.rejects(controller.loadSubtitle({ url: ORIGIN + '/sub.vtt' }), /download failed/);
    let finish;
    fake.bridge.loadSubtitle = () => new Promise((resolve) => { finish = resolve; });
    const pending = controller.loadSubtitle({ url: ORIGIN + '/sub.vtt' });
    const rejected = assert.rejects(pending, /Playback changed/);
    await controller.stop();
    finish(7);
    await rejected;
  } finally { await controller.dispose(); }
});

function fakeBridge() {
  const timeListeners = new Set();
  const stateListeners = new Set();
  const bufferingListeners = new Set();
  const calls = { play: [], seeks: [], dismissed: [], disposed: 0 };
  return {
    calls,
    timeListeners,
    stateListeners,
    emitTime: (u) => timeListeners.forEach((f) => f(u)),
    emitState: (u) => stateListeners.forEach((f) => f(u)),
    emitBuffering: (u) => bufferingListeners.forEach((f) => f(u)),
    bridge: {
      play: async (input) => { calls.play.push(input); },
      seek: async (pos) => { calls.seeks.push(pos); },
      onTime: (cb) => { timeListeners.add(cb); return () => timeListeners.delete(cb); },
      onState: (cb) => { stateListeners.add(cb); return () => stateListeners.delete(cb); },
      onBuffering: (cb) => { bufferingListeners.add(cb); return () => bufferingListeners.delete(cb); },
      dismiss: async (playId) => { calls.dismissed.push(playId); },
      dispose: async () => { calls.disposed++; },
    },
  };
}

function stubServer(options = {}) {
  const deletes = [];
  const heartbeats = [];
  const routes = [
    { match: (m, url) => m === "POST" && url.includes("/v2/playback/sessions"), respond: () => jsonResponse(201, options.session ?? {
      sessionId: "a".repeat(64), mode: "remux", reasonCode: "container_incompatible", message: "ok",
      playbackUrl: "/v2/playback/sessions/" + "a".repeat(64) + "/master.m3u8",
      subtitles: [], expiresAt: "2026-09-12T00:00:00Z", profile: "ios-avplayer",
    }) },
    { match: (m) => m === "DELETE", respond: () => { deletes.push("deleted"); return new Response(null, { status: 204 }); } },
    { match: (m, url) => url.includes("/v1/session/heartbeat"), respond: (init) => { heartbeats.push(JSON.parse(init.body)); return jsonResponse(200, {}); } },
    { match: (m, url) => url.includes("/v1/resume"), respond: () => jsonResponse(200, { found: false }) },
  ];
  const client = new PlaybackSessionClient({
    getOrigin: () => ORIGIN,
    fetchImpl: async (url, init = {}) => {
      const method = init.method ?? "GET";
      const u = String(url);
      for (const route of routes) {
        if (route.match(method, u, init.body)) return route.respond(init);
      }
      return jsonResponse(404, { error: { code: "not_found" } });
    },
  });
  return { client, deletes, heartbeats };
}

const REQUEST = {
  url: "magnet:?xt=urn:btih:" + HEX, title: "Movie", cat: "movie",
  subjectId: "phone-1", seriesId: "tmdb:movie:42", season: 0, episode: 0,
};

test('late controls receive playing, time and completed buffering without toggling pause', async () => {
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: stubServer().client, bridge: fb.bridge });
  try {
    await controller.start(REQUEST);
    fb.emitBuffering({ active: true });
    fb.emitTime({ currentTime: 3600, duration: 10000 });
    // A playing event alone must settle the loader, even if VLC never
    // follows it with a distinct buffering completion callback.
    fb.emitState({ state: 'playing' });
    const states = [], buffers = [], times = [];
    controller.subscribeState(value => states.push(value));
    controller.subscribeBuffering(value => buffers.push(value));
    controller.subscribeTime(value => times.push(value));
    assert.deepEqual(states, ['playing']);
    assert.equal(buffers.at(-1).active, false);
    assert.equal(times.at(-1).currentTime, 3600);
  } finally { await controller.dispose(); }
});

test('resume buffering clears from sustained clock movement, not seek jumps or stationary ticks', async () => {
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: stubServer().client, bridge: fb.bridge });
  let buffer;
  controller.subscribeBuffering(value => { buffer = value; });
  try {
    await controller.start(REQUEST);
    fb.emitState({ state: 'playing' });
    fb.emitBuffering({ active: true });
    for (const currentTime of [0, 3600, 3600, 3600]) {
      fb.emitTime({ currentTime, duration: 10000 });
      assert.equal(buffer.active, true);
    }
    fb.emitTime({ currentTime: 3600.5, duration: 10000 });
    assert.equal(buffer.active, true);
    // Repeated buffering callbacks must not erase evidence of advancing video.
    fb.emitBuffering({ active: true });
    fb.emitTime({ currentTime: 3601, duration: 10000 });
    assert.equal(buffer.active, false);
    // Recovery does not suppress a subsequent real stall.
    fb.emitBuffering({ active: true });
    for (let i = 0; i < 5; i++) fb.emitTime({ currentTime: 3601, duration: 10000 });
    assert.equal(buffer.active, true);
  } finally { await controller.dispose(); }
});

test('paused seeking cannot masquerade as resumed playback; native completion remains authoritative', async () => {
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: stubServer().client, bridge: fb.bridge });
  let buffer;
  controller.subscribeBuffering(value => { buffer = value; });
  try {
    await controller.start(REQUEST);
    fb.emitState({ state: 'paused' });
    fb.emitBuffering({ active: true, progress: 25 });
    for (const currentTime of [100, 100.5, 101, 101.5]) fb.emitTime({ currentTime, duration: 1000 });
    assert.equal(buffer.active, true);
    fb.emitBuffering({ active: false, progress: 100 });
    assert.equal(buffer.active, false);
  } finally { await controller.dispose(); }
});

test('buffering progress stays unknown on iOS and invalid progress never reaches the loader', async () => {
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: stubServer().client, bridge: fb.bridge });
  let buffer;
  controller.subscribeBuffering(value => { buffer = value; });
  try {
    await controller.start(REQUEST);
    for (const progress of [undefined, NaN, Infinity]) {
      fb.emitBuffering({ active: true, progress });
      assert.equal(buffer.progress, undefined);
      assert.equal(buffer.active, true);
    }
    fb.emitBuffering({ active: true, progress: 43.5 });
    assert.equal(buffer.progress, 43.5);
  } finally { await controller.dispose(); }
});

test('replacement resets cached playback state and rejects stale buffering and clock events', async () => {
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: stubServer().client, bridge: fb.bridge });
  let buffer;
  controller.subscribeBuffering(value => { buffer = value; });
  try {
    await controller.start(REQUEST);
    const oldId = fb.calls.play.at(-1).playId;
    fb.emitState({ state: 'playing', playId: oldId });
    fb.emitTime({ currentTime: 50, duration: 100, playId: oldId });
    await controller.start(REQUEST);
    const times = [], states = [];
    controller.subscribeTime(value => times.push(value));
    controller.subscribeState(value => states.push(value));
    fb.emitBuffering({ active: false, playId: oldId });
    fb.emitState({ state: 'playing', playId: oldId });
    for (const currentTime of [50, 50.5, 51]) fb.emitTime({ currentTime, duration: 100, playId: oldId });
    assert.equal(buffer.active, true);
    assert.deepEqual(times, []);
    assert.deepEqual(states, []);
  } finally { await controller.dispose(); }
});

test("preparation: native loading opens before planning and Close releases a late session", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const order = [];
  let completePlan;
  const create = server.client.create.bind(server.client);
  fb.bridge.prepare = async () => { order.push('prepare'); };
  server.client.create = async (request) => {
    order.push('plan');
    await new Promise(resolve => { completePlan = resolve; });
    return create(request);
  };
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge });
  const stopped = [];
  controller.onStopped(event => stopped.push(event));
  const starting = controller.start(REQUEST);
  const rejected = assert.rejects(starting, /replaced|cancelled/i);
  await waitFor(() => completePlan, 'planning starts');
  assert.deepEqual(order, ['prepare', 'plan']);
  fb.emitState({ state: 'stopped' });
  await waitFor(() => stopped.length === 1, 'loading can be closed');
  completePlan();
  await rejected;
  assert.equal(fb.calls.play.length, 0);
  assert.equal(fb.calls.dismissed.length, 1);
  assert.equal(server.deletes.length, 1);
  assert.equal(server.heartbeats.length, 0);
  await controller.dispose();
});

test("preparation: inspection errors stay in the native stage and can be closed", async () => {
  const server = stubServer({ session: {
    sessionId: 'b'.repeat(64), mode: 'unsupported', reasonCode: 'media_inspection_failed',
    message: 'Cannot inspect this source.', playbackUrl: '', subtitles: [], expiresAt: 'x', profile: 'ios-avplayer',
  } });
  const fb = fakeBridge();
  const errors = [];
  fb.bridge.prepare = async () => {};
  fb.bridge.showError = async (message) => errors.push(message);
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge });
  await assert.rejects(controller.start(REQUEST), e => e.kind === 'planning');
  assert.deepEqual(errors, ['Cannot inspect this source.']);
  assert.equal(fb.calls.dismissed.length, 0, 'error remains visible in native stage');
  await controller.stop();
  assert.equal(fb.calls.dismissed.length, 1);
  assert.equal(server.deletes.length, 1, 'unsupported session deleted only once');
  await controller.dispose();
});

test("preparation: a new source never inherits progress from the preceding video", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  fb.bridge.prepare = async () => {};
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge });
  await controller.start(REQUEST);
  fb.emitTime({ currentTime: 120, duration: 3600 });
  server.client.create = async () => { throw new PlaybackClientError('network', 'Server unavailable.'); };
  fb.bridge.showError = async () => {};
  await assert.rejects(controller.start({ ...REQUEST, seriesId: 'tmdb:movie:99' }));
  await controller.stop();
  assert.ok(server.heartbeats.length > 0);
  assert.ok(server.heartbeats.every(row => row.seriesId === REQUEST.seriesId));
  await controller.dispose();
});

test("lifecycle: unsupported plan DELETES the newly created session", async () => {
  const server = stubServer({ session: {
    sessionId: "b".repeat(64), mode: "unsupported", reasonCode: "media_inspection_failed", message: "cannot inspect",
    playbackUrl: "", subtitles: [], expiresAt: "x", profile: "ios-avplayer",
  } });
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge });
  await assert.rejects(
    controller.start(REQUEST),
    (e) => e instanceof PlaybackClientError && e.kind === "planning",
  );
  assert.equal(fb.calls.play.length, 0, "nothing handed to the native player");
  assert.equal(server.deletes.length, 1, "the new unsupported session was released");
});

test("lifecycle: bridge.play rejection deletes the session and dismisses native state", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  fb.bridge.play = async () => { throw new Error("native present failed"); };
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge });
  await assert.rejects(controller.start(REQUEST), (e) => e.kind === "network");
  assert.equal(server.deletes.length, 1, "session released after a failed native start");
  assert.equal(fb.calls.dismissed.length, 1, "only the failed play is dismissed");
  assert.match(fb.calls.dismissed[0], /^\d+$/u);
});

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function deferredStarts(fb) {
  const starts = new Map();
  fb.bridge.play = (input) => {
    fb.calls.play.push(input);
    return new Promise((resolve, reject) => starts.set(input.playId, { resolve, reject }));
  };
  return starts;
}

test("lifecycle: stale bridge resolution cannot clear or dismiss its replacement", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const starts = deferredStarts(fb);
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge, heartbeatMs: 60_000 });
  const first = controller.start(REQUEST);
  await waitFor(() => starts.has("2"), "start A reached native bridge");
  const second = controller.start({ ...REQUEST, title: "Replacement" });
  await waitFor(() => starts.has("4"), "start B reached native bridge");
  starts.get("4").resolve();
  await second;
  starts.get("2").resolve();
  await first;

  assert.equal(fb.calls.dismissed.includes("4"), false, "late A resolution never dismisses B");
  fb.emitTime({ currentTime: 44, duration: 600, playId: "4" });
  fb.emitState({ state: "paused", playId: "4" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(server.heartbeats.some((body) => body.position_s === 44), "B remains active after A resolves");
  await controller.stop();
});

test("lifecycle: stale bridge rejection cannot clear or dismiss its replacement", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const starts = deferredStarts(fb);
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge, heartbeatMs: 60_000 });
  const first = controller.start(REQUEST);
  await waitFor(() => starts.has("2"), "start A reached native bridge");
  const second = controller.start({ ...REQUEST, title: "Replacement" });
  await waitFor(() => starts.has("4"), "start B reached native bridge");
  starts.get("4").resolve();
  await second;
  starts.get("2").reject(new Error("late native failure"));
  await assert.rejects(first, (error) => error instanceof PlaybackClientError && error.message.includes("replaced"));

  assert.equal(fb.calls.dismissed.includes("4"), false, "late A rejection never dismisses B");
  fb.emitTime({ currentTime: 55, duration: 600, playId: "4" });
  fb.emitState({ state: "paused", playId: "4" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(server.heartbeats.some((body) => body.position_s === 55), "B remains active after A rejects");
  await controller.stop();
});

test("native bridge: listener registration gates play and dispose removes handles", async () => {
  const callbacks = {};
  const listenerResolvers = [];
  const removed = [];
  let played = false;
  const plugin = {
    addListener: (name, callback) => {
      callbacks[name] = callback;
      return new Promise((resolve) => listenerResolvers.push(() => resolve({
        remove: async () => { removed.push(name); },
      })));
    },
    play: async () => { played = true; },
    seek: async () => {},
    dismiss: async () => {},
  };
  const nativeBridge = createNativePlaybackBridge(plugin);
  const starting = nativeBridge.play({ url: ORIGIN + "/media", title: "Movie", subtitles: [], playId: "p1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(played, false, "native play waits until both event listeners exist");
  listenerResolvers.forEach((resolve) => resolve());
  await starting;
  assert.equal(played, true);
  await nativeBridge.dispose();
  assert.deepEqual(removed.sort(), ["buffering", "playbackState", "timeUpdate", "tracksUpdate"]);
  await assert.rejects(
    nativeBridge.play({ url: ORIGIN + "/media", title: "Movie", subtitles: [], playId: "p2" }),
    /disposed/,
  );
});

test("native bridge: partial listener-registration failure still removes successful handles", async () => {
  let removed = 0;
  const plugin = {
    addListener: (name) => name === "timeUpdate"
      ? Promise.resolve({ remove: async () => { removed++; } })
      : Promise.reject(new Error("listener unavailable")),
    play: async () => assert.fail("play must not run without both native listeners"),
    seek: async () => {},
    dismiss: async () => {},
  };
  const nativeBridge = createNativePlaybackBridge(plugin);
  await assert.rejects(
    nativeBridge.play({ url: ORIGIN + "/media", title: "Movie", subtitles: [], playId: "p1" }),
    /listener unavailable/,
  );
  await nativeBridge.dispose();
  assert.equal(removed, 1, "the successfully registered listener is not leaked");
});

test("lifecycle: pause triggers an immediate bounded progress write", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge, heartbeatMs: 60_000 });
  await controller.start(REQUEST);
  fb.emitTime({ currentTime: 33, duration: 600 });
  fb.emitState({ state: "paused" });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(server.heartbeats.some((h) => h.position_s === 33), "pause flushed progress immediately");
  await controller.stop();
});

test("lifecycle: events tagged with a foreign playId are dropped (replacement safety)", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge, heartbeatMs: 60_000 });
  const terminals = [];
  controller.onStopped((event) => terminals.push(event));
  await controller.start(REQUEST);
  const currentPlayId = fb.calls.play[0].playId;
  assert.ok(currentPlayId, "bridge.play receives the replacement-safety playId");
  // An old player's dying events (different playId) must be ignored.
  fb.emitTime({ currentTime: 999, duration: 600, playId: "dead-session" });
  fb.emitState({ state: "stopped", playId: "dead-session" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(terminals.length, 0, "foreign-playId terminal dropped");
  // Current-playId events still flow.
  fb.emitTime({ currentTime: 10, duration: 600, playId: currentPlayId });
  fb.emitState({ state: "paused", playId: currentPlayId });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(server.heartbeats.some((h) => h.position_s === 10), "current-playId pause flush works");
  await controller.stop();
});

// ---- 4/5. Settings overlay controller + origin save flow ----------------

test("settings overlay: open -> close -> repeated open cycles stay idempotent", () => {
  const target = new EventTarget();
  const controller = new SettingsOverlayController(target);
  const states = [];
  controller.subscribe((open) => states.push(open));

  const open = () => target.dispatchEvent(new CustomEvent("torwatch:open-settings"));
  open(); // app -> settings
  assert.equal(controller.isOpen(), true);
  open(); // repeated open while open: no duplicate state change
  controller.close(); // settings -> app
  assert.equal(controller.isOpen(), false);
  open(); // settings again
  assert.equal(controller.isOpen(), true);
  controller.close();
  controller.dispose();

  assert.deepEqual(states, [true, false, true, false], "only real transitions emit");
  target.dispatchEvent(new CustomEvent("torwatch:open-settings"));
  assert.equal(controller.isOpen(), false, "disposed controller ignores events");
});

function settingsFixtures() {
  const saved = { value: null };
  const connection = {
    loadOrigin: async () => saved.value ?? "https://previous.example",
    saveOrigin: async (origin) => { saved.value = origin; },
  };
  const storage = { getPreference: () => saved.value };
  return { connection, storage, saved };
}

test("settings save: unreachable server is NEVER persisted and never closes", async () => {
  const { connection, storage, saved } = settingsFixtures();
  let closed = false;
  const outcome = await applyServerOrigin({
    connection, storage,
    fetchImpl: async () => { throw new TypeError("offline"); },
    origin: "https://server.example:8443",
    onOriginApplied: () => { closed = true; },
  });
  assert.equal(outcome.result, "blocked-unreachable");
  assert.equal(saved.value, null, "nothing persisted");
  assert.equal(closed, false, "settings stay open");
});

test("settings save: reachable WITHOUT playback saves truthfully and separately", async () => {
  const { connection, storage, saved } = settingsFixtures();
  const outcome = await applyServerOrigin({
    connection, storage,
    fetchImpl: async (url) =>
      String(url).includes("/readyz") ? jsonResponse(200, { status: "ok" })
      : jsonResponse(200, { capabilities: ["catalog.bff.v2"] }),
    origin: "https://server.example:8443",
  });
  assert.equal(outcome.result, "saved-without-playback");
  assert.equal(saved.value, "https://server.example:8443", "canonical saveOrigin applied");
});

test("settings save: localStorage durability failure surfaces as blocked", async () => {
  const active = { value: "https://previous.example" };
  const saves = [];
  const brokenStorage = { getPreference: () => "https://previous.example" }; // never reflects the new save
  const outcome = await applyServerOrigin({
    connection: {
      loadOrigin: async () => active.value,
      saveOrigin: async (origin) => { active.value = origin; saves.push(origin); },
    },
    storage: brokenStorage,
    fetchImpl: async (url) =>
      String(url).includes("/readyz") ? jsonResponse(200, { status: "ok" })
      : jsonResponse(200, { capabilities: ["playback.compat.v1"] }),
    origin: "https://server.example:8443",
  });
  assert.equal(outcome.result, "blocked-persist-failed");
  assert.equal(active.value, "https://previous.example", "failed persistence restores runtime origin");
  assert.deepEqual(saves, ["https://server.example:8443", "https://previous.example"]);
});

test("settings save: probe runs BEFORE persist for a reachable playback-capable server", async () => {
  const order = [];
  const { storage, saved } = settingsFixtures();
  const outcome = await applyServerOrigin({
    connection: {
      loadOrigin: async () => "https://previous.example",
      saveOrigin: async (origin) => { saved.value = origin; order.push("save"); },
    },
    storage,
    fetchImpl: async (url) => {
      order.push(String(url).includes("/readyz") ? "readyz" : "version");
      return String(url).includes("/readyz") ? jsonResponse(200, { status: "ok" })
        : jsonResponse(200, { capabilities: ["playback.compat.v1"] });
    },
    origin: "https://server.example:8443",
  });
  assert.equal(outcome.result, "saved");
  assert.deepEqual(order, ["readyz", "version", "save"], "probe precedes persist");
});

test("normalizeOrigin: rejects credentials, paths, fragments; normalizes host case and trailing slashes", () => {
  assert.equal(normalizeOrigin("https://Server.Example:8443/"), "https://server.example:8443");
  assert.equal(normalizeOrigin("  http://localhost:4001  "), "http://localhost:4001");
  assert.equal(normalizeOrigin("https://user:pass@server.example"), null);
  assert.equal(normalizeOrigin("https://server.example/path"), null);
  assert.equal(normalizeOrigin("https://server.example#frag"), null);
  assert.equal(normalizeOrigin("ftp://server.example"), null);
  assert.equal(normalizeOrigin(""), null);
});

test("probeOrigin: unreachable and incompatible remain separate states", async () => {
  const offline = await probeOrigin(async () => { throw new TypeError("down"); }, ORIGIN);
  assert.equal(offline.kind, "unreachable");
  assert.doesNotMatch(offline.message, /TypeError|down/u, "opaque WKWebView errors never leak into the UI");
  assert.match(offline.message, /same private network|Firewall/u, "failure gives an actionable recovery path");
  const incompatible = await probeOrigin(async (url) =>
    String(url).includes("/readyz") ? jsonResponse(200, { status: "ok" }) : jsonResponse(404, {}),
    ORIGIN);
  assert.equal(incompatible.kind, "incompatible");
});

test("probeOrigin: a hung WKWebView fetch becomes a bounded, friendly timeout", async () => {
  const result = await probeOrigin(() => new Promise(() => {}), ORIGIN, 5);
  assert.equal(result.kind, "unreachable");
  assert.match(result.message, /timed out/u);
  assert.doesNotMatch(result.message, /TypeError|AbortError/u);
});

test("connection diagnostics never expose opaque platform error bodies", () => {
  const message = connectionFailureMessage(new TypeError("Load failed"), "http://192.168.1.50:4001");
  assert.match(message, /192\.168\.1\.50:4001/u);
  assert.doesNotMatch(message, /TypeError|Load failed/u);
});
