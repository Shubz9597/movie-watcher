import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
const { ownTrackSource, fetchOwnTrack, cacheOwnSubtitle, cachedOwnSubtitle } = await import("../../src/lib/own-subtitles.ts");

// A Dragon Ball Z Kai download: the video's own English track, then the
// subtitle files saved with it (listed after the video's tracks).
const tracks = [
  { id: 3, label: "Track 1 - [English]" },
  { id: 4, label: "Signs - [English]" },
  { id: 5, label: "Dub - [English]" },
  { id: 6, label: "Downloaded - [Spanish]" },
];

test("a track's text is the video's Nth stream or a download's file", () => {
  assert.deepEqual(ownTrackSource(tracks, 3), { kind: "video", ordinal: 0 });
  assert.deepEqual(ownTrackSource(tracks, 4), { kind: "video", ordinal: 1 });
  assert.deepEqual(ownTrackSource(tracks, 5), { kind: "file", language: "English" });
  assert.deepEqual(ownTrackSource(tracks, 6), { kind: "file", language: "Spanish" });
  assert.equal(ownTrackSource(tracks, 9), null);
});

test("the server is asked again while it reads the video", async () => {
  const answers = [{ status: "pending" }, { status: "pending" }, { status: "ready", url: "/subtitles/embedded/file?key=k" }];
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url).includes("/file?")) return { ok: true, text: async () => "WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n" };
    return { ok: true, json: async () => answers.shift() };
  };
  const text = await fetchOwnTrack("http://server", { magnet: "magnet:?xt=urn:btih:abc", fileIndex: 59, cat: "anime" }, 0, () => false, async () => {});
  assert.match(text, /Hi/);
  assert.equal(asked.length, 4);
  assert.match(asked[0], /track=0/);
  assert.match(asked[0], /fileIndex=59/);
});

// A Kai download whose server copy was gone: the server's first read of the
// torrent ran out of time, and the phone stopped asking, leaving VLC's style
// until a seek asked again.
test("a failed read or a dropped connection is asked again", async () => {
  const answers = [{ status: "none", reason: "unavailable" }, "throw", { status: "pending" }, { status: "ready", url: "/subtitles/embedded/file?key=k" }];
  const waits = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes("/file?")) return { ok: true, text: async () => "WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n" };
    const answer = answers.shift();
    if (answer === "throw") throw new Error("offline");
    return { ok: true, json: async () => answer };
  };
  const text = await fetchOwnTrack("http://server", { downloadId: "d", clientId: "c" }, 0, () => false, async (ms) => { waits.push(ms); });
  assert.match(text, /Hi/);
  assert.deepEqual(waits, [30000, 30000, 6000]);
});

test("styled tracks are left to the player", async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ status: "none", reason: "styled" }) });
  assert.equal(await fetchOwnTrack("http://server", { downloadId: "d", clientId: "c" }, 1, () => false, async () => {}), null);
});

test("a download keeps the text for offline playback", () => {
  cacheOwnSubtitle("d#0", "WEBVTT");
  assert.equal(cachedOwnSubtitle("d#0"), "WEBVTT");
  assert.equal(cachedOwnSubtitle("d#1"), null);
});
