// M1.4.3 shared playback-session client + native controller contract tests.
// Deterministic: fetch is stubbed; no network, no Capacitor runtime.
import assert from "node:assert/strict";
import test from "node:test";

import {
  PlaybackClientError,
  PlaybackSessionClient,
} from "../../src/platform/playback-session-client.ts";
import {
  NativePlaybackController,
} from "../../src/platform/native-playback-controller.ts";

const HEX = "0123456789abcdef0123456789abcdef01234567";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const SESSION_OK = {
  sessionId: "a".repeat(64),
  mode: "remux",
  reasonCode: "container_incompatible",
  message: "ok",
  playbackUrl: "/v2/playback/sessions/" + "a".repeat(64) + "/master.m3u8",
  media: { container: "mkv", durationSec: 600, width: 1920, height: 1080,
    video: { codec: "h264" }, audio: { codec: "aac", channels: 2 }, bitrateBps: 5_000_000, fileIndex: 0 },
  subtitles: [{ id: "t0", language: "en", label: "Subtitle", url: "/v2/playback/sessions/" + "a".repeat(64) + "/subtitles/t0.vtt", origin: "embedded-sidecar" }],
  expiresAt: "2026-09-12T00:00:00Z",
  profile: "ios-avplayer",
};

function makeClient(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ method: init.method ?? "GET", url: String(url), body: init.body ?? null });
    for (const route of routes) {
      if (route.match(init.method ?? "GET", String(url), init.body)) return route.respond(init);
    }
    return jsonResponse(404, { error: { code: "not_found", message: "no route" } });
  };
  const client = new PlaybackSessionClient({
    getOrigin: () => "https://server.example:8443",
    fetchImpl,
  });
  return { client, calls };
}

test("client: session create sends ONLY the hex source id and resolves against the origin", async () => {
  let posted = null;
  const { client, calls } = makeClient([
    { match: (m, url) => m === "POST" && url.includes("/v2/playback/sessions"), respond: (init) => { posted = JSON.parse(init.body); return jsonResponse(201, SESSION_OK); } },
  ]);
  const session = await client.create({ cat: "movie", sourceId: HEX, fileIndex: 2 });
  assert.equal(session.mode, "remux");
  assert.equal(posted.sourceId, HEX);
  assert.equal(posted.fileIndex, 2);
  assert.equal(posted.profile, "ios-avplayer");
  assert.ok(!JSON.stringify(posted).includes("magnet"), "never send a magnet");
  const requestUrl = calls.find((c) => c.method === "POST").url;
  assert.ok(requestUrl.startsWith("https://server.example:8443/v2/playback/sessions"), requestUrl);
  // Relative URLs resolve against the configured origin only.
  assert.equal(client.resolve(SESSION_OK.playbackUrl), "https://server.example:8443" + SESSION_OK.playbackUrl);
  assert.equal(client.resolve(SESSION_OK.subtitles[0].url), "https://server.example:8443" + SESSION_OK.subtitles[0].url);
});

test("client: fails closed on a magnet-shaped or partial source id", async () => {
  const { client, calls } = makeClient([]);
  await assert.rejects(
    client.create({ cat: "movie", sourceId: "magnet:?xt=urn:btih:" + HEX, fileIndex: 0 }),
    (error) => error instanceof PlaybackClientError && error.kind === "invalid",
  );
  await assert.rejects(
    client.create({ cat: "movie", sourceId: "abc", fileIndex: 0 }),
    (error) => error.kind === "invalid",
  );
  assert.equal(calls.length, 0, "no network call may leave the device");
});

test("client: truthful error mapping for 404/422/503/network", async () => {
  const { client: c404 } = makeClient([
    { match: (m) => m === "POST", respond: () => jsonResponse(404, { error: { code: "not_found" } }) },
  ]);
  await assert.rejects(c404.create({ cat: "movie", sourceId: HEX }), (e) => e.kind === "unsupported-server");

  const { client: c422 } = makeClient([
    { match: (m) => m === "POST", respond: () => jsonResponse(422, { error: { code: "media_inspection_failed", message: "cannot inspect" } }) },
  ]);
  await assert.rejects(c422.create({ cat: "movie", sourceId: HEX }), (e) => e.kind === "planning" && e.reasonCode === "media_inspection_failed");

  const { client: c503 } = makeClient([
    { match: (m) => m === "POST", respond: () => jsonResponse(503, { error: { code: "transcode_capacity_exhausted", message: "busy" } }) },
  ]);
  await assert.rejects(c503.create({ cat: "movie", sourceId: HEX }), (e) => e.kind === "capacity");

  const offline = new PlaybackSessionClient({ getOrigin: () => "https://x", fetchImpl: async () => { throw new TypeError("offline"); } });
  assert.equal(await offline.capability(), "unreachable");
  await assert.rejects(offline.create({ cat: "movie", sourceId: HEX }), (e) => e.kind === "network");

  const older = makeClient([
    { match: (m) => m === "GET", respond: () => jsonResponse(200, { capabilities: ["catalog.bff.v2"] }) },
  ]);
  assert.equal(await older.client.capability(), "absent");
  const modern = makeClient([
    { match: (m) => m === "GET", respond: () => jsonResponse(200, { capabilities: ["playback.compat.v1"] }) },
  ]);
  assert.equal(await modern.client.capability(), "available");
});

// Native controller: session lifecycle, exactly-once terminal, stale guards.
function fakeBridge() {
  const listeners = { time: new Set(), state: new Set() };
  const calls = { play: [], seeks: [], dismissed: 0 };
  return {
    calls,
    emitTime: (u) => listeners.time.forEach((f) => f(u)),
    emitState: (u) => listeners.state.forEach((f) => f(u)),
    bridge: {
      play: async (input) => { calls.play.push(input); },
      seek: async (pos) => { calls.seeks.push(pos); },
      onTime: (cb) => { listeners.time.add(cb); return () => listeners.time.delete(cb); },
      onState: (cb) => { listeners.state.add(cb); return () => listeners.state.delete(cb); },
      dismiss: async () => { calls.dismissed++; },
    },
  };
}

function stubServer() {
  const deletes = [];
  const heartbeats = [];
  const routes = [
    { match: (m, url) => m === "POST" && url.includes("/v2/playback/sessions"), respond: () => jsonResponse(201, SESSION_OK) },
    { match: (m) => m === "DELETE", respond: () => { deletes.push("deleted"); return new Response(null, { status: 204 }); } },
    { match: (m, url) => url.includes("/v1/session/heartbeat"), respond: (init) => { heartbeats.push(JSON.parse(init.body)); return jsonResponse(200, {}); } },
    { match: (m, url) => url.includes("/v1/resume"), respond: () => jsonResponse(200, { found: true, position_s: 120 }) },
  ];
  const { client, calls } = makeClient(routes);
  return { client, deletes, heartbeats, calls };
}

test("controller: start hands only opaque URLs to the bridge and seeks to confirmed resume", async () => {
  const { client } = stubServer();
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client, bridge: fb.bridge });

  await controller.start({
    url: "magnet:?xt=urn:btih:" + HEX, magnet: "magnet:?xt:unused", title: "Movie",
    cat: "movie", fileIndex: 1, subjectId: "phone-1", seriesId: "tmdb:movie:42",
    season: 0, episode: 0, sourceName: "Some Source", nextSeason: null, nextEpisode: null,
  });
  assert.equal(fb.calls.play.length, 1);
  const input = fb.calls.play[0];
  assert.ok(input.url.startsWith("https://server.example:8443/v2/playback/sessions/"), "playback URL resolved to origin");
  assert.ok(input.url.endsWith("/master.m3u8"), "plan taken from the session (HLS), not extension-guessed");
  assert.equal(input.subtitles.length, 1);
  assert.ok(input.subtitles[0].url.startsWith("https://server.example:8443/"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fb.calls.seeks, [120], "confirmed resume seeks after attach");
  controller.stop();
});

test("controller: time events flow to heartbeats; terminal ended fires exactly once and deletes the session", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge, heartbeatMs: 15 });
  const terminals = [];
  controller.onStopped((event) => terminals.push(event));

  await controller.start({
    url: "magnet:?xt=urn:btih:" + HEX, title: "Movie", cat: "movie",
    subjectId: "phone-1", seriesId: "tmdb:movie:42", season: 0, episode: 0,
  });
  fb.emitTime({ currentTime: 42.4, duration: 600 });
  await new Promise((r) => setTimeout(r, 60)); // let at least one heartbeat tick
  fb.emitState({ state: "ended" });
  await new Promise((r) => setTimeout(r, 40));
  fb.emitState({ state: "ended" }); // late duplicate
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(terminals.length, 1, "exactly one terminal event");
  assert.equal(terminals[0].reason, "ended");
  assert.ok(server.heartbeats.length >= 1, "heartbeats flowed");
  assert.equal(server.heartbeats[0].position_s, 42);
  assert.equal(server.heartbeats[0].subjectId, "phone-1");
  assert.ok(!JSON.stringify(server.heartbeats).includes("magnet"), "heartbeats never carry magnets");
  assert.equal(fb.calls.dismissed, 1, "dismissed exactly once");
  assert.equal(server.deletes.length, 1, "session deleted exactly once on ended");
});

test("controller: superseding start does NOT emit a terminal event for the old session", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge });
  const terminals = [];
  controller.onStopped((event) => terminals.push(event));

  await controller.start({ url: "magnet:?xt=urn:btih:" + HEX, title: "A", cat: "movie", subjectId: "s", seriesId: "tmdb:movie:1", season: 0, episode: 0 });
  const firstPlayCount = fb.calls.play.length;
  await controller.start({ url: "magnet:?xt=urn:btih:" + HEX, title: "B", cat: "movie", subjectId: "s", seriesId: "tmdb:movie:1", season: 0, episode: 0 });
  assert.equal(fb.calls.play.length, firstPlayCount + 1);
  assert.equal(terminals.filter((t) => t.reason === "stopped").length, 0, "supersede is silent");
  // The superseded session was still cleaned up server-side.
  assert.ok(server.deletes.length >= 1);
  await controller.stop();
  assert.equal(terminals.filter((t) => t.reason === "stopped").length, 1, "explicit stop fires once");
});

test("controller: stale time events from a replaced session never write progress", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge, heartbeatMs: 10 });
  await controller.start({ url: "magnet:?xt=urn:btih:" + HEX, title: "A", cat: "movie", subjectId: "s", seriesId: "tmdb:movie:1", season: 0, episode: 0 });
  const heartbeatCount = server.heartbeats.length;
  await controller.stop();
  fb.emitTime({ currentTime: 999, duration: 600 }); // stale listener event
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(server.heartbeats.length <= heartbeatCount + 1, "no post-stop heartbeat wrote stale progress");
});

test("controller: native-UI dismissal ('stopped' state) terminates once and deletes the session", async () => {
  const server = stubServer();
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client: server.client, bridge: fb.bridge });
  const terminals = [];
  controller.onStopped((event) => terminals.push(event));

  await controller.start({ url: "magnet:?xt=urn:btih:" + HEX, title: "A", cat: "movie", subjectId: "s", seriesId: "tmdb:movie:1", season: 0, episode: 0 });
  fb.emitState({ state: "stopped" }); // user pressed Done / back in the native UI
  await new Promise((r) => setTimeout(r, 40));
  fb.emitState({ state: "stopped" }); // duplicate from the dying surface
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(terminals.length, 1, "exactly one terminal event");
  assert.equal(terminals[0].reason, "stopped");
  assert.equal(server.deletes.length, 1, "server session deleted exactly once");
  assert.equal(fb.calls.dismissed, 1);
});

test("controller: unsupported plan surfaces a truthful typed error", async () => {
  const unsupportedSession = { ...SESSION_OK, mode: "unsupported", reasonCode: "media_inspection_failed", message: "cannot inspect" };
  const { client } = makeClient([
    { match: (m) => m === "POST", respond: () => jsonResponse(201, unsupportedSession) },
  ]);
  const fb = fakeBridge();
  const controller = new NativePlaybackController({ client, bridge: fb.bridge });
  await assert.rejects(
    controller.start({ url: "magnet:?xt=urn:btih:" + HEX, title: "X", cat: "movie" }),
    (e) => e instanceof PlaybackClientError && e.kind === "planning" && /cannot inspect/.test(e.message),
  );
  assert.equal(fb.calls.play.length, 0, "nothing is handed to the native player");
});
