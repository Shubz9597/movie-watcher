import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
globalThis.window ??= { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} };
globalThis.CustomEvent ??= class { constructor(type) { this.type = type; } };

const { moveEntriesToShows } = await import("../../src/mobile/show-migration.ts");

// Dragon Ball Z Kai's AniList entries are seasons 1 and 2 of the show
// tmdb:tv:61709 (Stremio's seasons); One Piece's entry spans every season.
const series = {
  "anilist:6033": { id: "tmdb:tv:61709", season: 1 },
  "anilist:20635": { id: "tmdb:tv:61709", season: 2 },
  "anilist:21": { id: "tmdb:tv:37854", season: 1, absolute: true },
};
const detail = async (id) => ({ id, type: "anime", title: "", series: series[id] });

test("downloads, queue and show choices move to the show", async () => {
  const relocated = [];
  const native = {
    list: async () => ({ items: [
      { downloadId: "d36", seriesId: "anilist:6033", season: 1, episode: 36 },
      { downloadId: "f3", seriesId: "anilist:20635", season: 1, episode: 3 },
      { downloadId: "op", seriesId: "anilist:21", season: 1, episode: 1000 },
      { downloadId: "sev", seriesId: "tmdb:tv:95396", season: 1, episode: 2 },
    ] }),
    relocate: async (request) => { relocated.push(request); },
  };
  store.set("torwatch_pending_downloads_v1", JSON.stringify([
    { jobId: "q", seriesId: "anilist:20635", season: 1, episode: 4, subtitleLabel: "S1 E4" },
  ]));
  store.set("torwatch_show_playback_v1", JSON.stringify({
    "anilist:6033": { audioLanguage: "en", subtitle: "dub" },
    "tmdb:tv:95396": { subtitle: "regular" },
  }));

  await moveEntriesToShows({ native, detail });

  assert.deepEqual(relocated, [
    { downloadId: "d36", seriesId: "tmdb:tv:61709", season: 1, episode: 36, subtitleLabel: "S1 E36" },
    { downloadId: "f3", seriesId: "tmdb:tv:61709", season: 2, episode: 3, subtitleLabel: "S2 E3" },
  ], "One Piece (spans seasons) and shows stay as they are");
  const queued = JSON.parse(store.get("torwatch_pending_downloads_v1"));
  assert.equal(queued[0].seriesId, "tmdb:tv:61709");
  assert.equal(queued[0].season, 2);
  assert.equal(queued[0].subtitleLabel, "S2 E4");
  const prefs = JSON.parse(store.get("torwatch_show_playback_v1"));
  assert.deepEqual(prefs["tmdb:tv:61709"], { audioLanguage: "en", subtitle: "dub" });
  assert.equal(prefs["anilist:6033"], undefined);
  assert.deepEqual(prefs["tmdb:tv:95396"], { subtitle: "regular" });
});

test("offline, nothing moves and nothing fails", async () => {
  const native = { list: async () => ({ items: [{ downloadId: "d1", seriesId: "anilist:6033", season: 1, episode: 1 }] }), relocate: async () => { throw new Error("must not move"); } };
  await moveEntriesToShows({ native, detail: async () => { throw new Error("offline"); } });
});
