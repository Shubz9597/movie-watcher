// Batch torrents: when an episode ends, playback continues with the next
// queued episode from the same pack.
import assert from "node:assert/strict";
import test from "node:test";

const { advancePackParams } = await import("../../src/lib/pack-advance.ts");

const base = {
  magnet: "magnet:?xt=urn:btih:abc",
  cat: "anime",
  title: "Frieren",
  season: "1",
  episode: "4",
  absoluteEpisode: "4",
  fileIndex: "3",
  seriesId: "anilist:154587",
  packQueue: "1:5:5,1:6:6",
  nextSeason: "1",
  nextEpisode: "5",
  nextEpisodeRoute: "#title?kind=anime&id=154587&season=1&episode=5",
};

test("advances to the next queued episode of the same pack", () => {
  const next = advancePackParams(base);
  assert.equal(next.magnet, base.magnet);
  assert.equal(next.episode, "5");
  assert.equal(next.absoluteEpisode, "5");
  assert.equal(next.resolveEpisodeFile, "1");
  assert.equal("fileIndex" in next, false, "the next file is resolved, not reused");
  assert.equal(next.packQueue, "1:6:6");
  assert.equal(next.nextEpisode, "6");
  assert.equal(next.nextEpisodeRoute, "#title?kind=anime&id=154587&season=1&episode=6");
  assert.equal(next.packFallbackRoute, base.nextEpisodeRoute, "falls back to choosing a source for episode 5");
  assert.equal(next.seriesId, base.seriesId);
});

test("the last queued episode ends the chain", () => {
  const next = advancePackParams({ ...base, packQueue: "1:6:6" });
  assert.equal(next.episode, "6");
  assert.equal("packQueue" in next, false);
  assert.equal("nextEpisode" in next, false);
  assert.equal("nextEpisodeRoute" in next, false);
});

test("no pack queue or no magnet: no auto-advance", () => {
  assert.equal(advancePackParams({ ...base, packQueue: "" }), null);
  assert.equal(advancePackParams({ ...base, magnet: "" }), null);
});
