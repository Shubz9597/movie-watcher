import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { placeByTitle, refileDownloads } from "../../src/mobile/refile-downloads.ts";

// Dragon Ball Z Kai's complete pack (167 files, The Final Chapters numbered
// as the 69-episode international release) and the catalog (98 + 61).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/kai-complete-pack.json", import.meta.url), "utf8"));
const catalog = fixture.catalog;
const file = (n) => fixture.packFiles[String(n)];

test("a pack file goes to the catalog episode it names, or to Extras", () => {
  assert.deepEqual(pick(placeByTitle(file(125), catalog)), { season: 2, episode: 20, extra: false });
  assert.deepEqual(pick(placeByTitle(file(132), catalog)), { season: 2, episode: 27, extra: false });
  assert.deepEqual(pick(placeByTitle(file(99), catalog)), { season: 2, episode: 1, extra: false });
  assert.deepEqual(pick(placeByTitle(file(5), catalog)), { season: 1, episode: 5, extra: false });
  // International-only: Extras, by the pack's number.
  assert.deepEqual(pick(placeByTitle(file(101), catalog)), { season: 0, episode: 1101, extra: true });
  assert.deepEqual(pick(placeByTitle(file(165), catalog)), { season: 0, episode: 1165, extra: true });
  // A file without a title is left alone.
  assert.equal(placeByTitle("Dragon Ball Z Kai - 012.mkv", catalog), null);
});

function pick(place) {
  return place && { season: place.season, episode: place.episode, extra: place.extra };
}

test("Season 2 downloaded by number (labels 1-61 = pack 99-159) is refiled, watched marks follow", async () => {
  // Watched to the end up to label 27 (pack 125); the rest unwatched.
  const items = Array.from({ length: 61 }, (_, i) => ({
    downloadId: `job-${i + 1}`, seriesId: "tmdb:tv:61709", season: 2, episode: i + 1, origin: "https://home",
    title: "Dragon Ball Z Kai", posterUrl: "", subtitleLabel: `S2 E${i + 1}`, state: "ready", reason: "",
    receivedBytes: 1, totalBytes: 1, instanceId: "x",
    ...(i + 1 <= 27 ? { positionS: 1380, durationS: 1386 } : {}),
  }));
  const relocated = new Map();
  const watched = [];
  const resent = [];
  let checked = new Set();
  const moves = await refileDownloads({
    native: {
      list: async () => ({ items }),
      relocate: async (move) => { relocated.set(move.downloadId, move); },
    },
    sourceFileName: async (item) => file(98 + item.episode),
    episodes: async () => catalog,
    resendProgress: (ids) => resent.push(...ids),
    setWatched: async (seriesId, list, value) => { watched.push({ value, list: list.map((e) => `${e.season}x${e.episode}`) }); },
    saveMeta: async () => {},
    checked: { read: () => checked, write: (ids) => { checked = ids; } },
  });
  // Labels 1-2 were right; 3 onwards moved (extras or back by up to 7).
  assert.equal(relocated.has("job-1"), false);
  assert.equal(relocated.has("job-2"), false);
  assert.deepEqual(relocated.get("job-27"), { downloadId: "job-27", seriesId: "tmdb:tv:61709", season: 2, episode: 20, subtitleLabel: "S2 E20" });
  assert.deepEqual(relocated.get("job-3"), { downloadId: "job-3", seriesId: "tmdb:tv:61709", season: 0, episode: 1101, subtitleLabel: "Extra · 101" });
  const extras = moves.filter((move) => move.extra).map((move) => move.to.episode - 1000);
  assert.deepEqual(extras, [101, 102, 103, 106, 108, 111, 113]);
  // Every catalog episode 1-54 is filed exactly once; 55-61 are not downloaded.
  const filed = new Set(items.map((item) => relocated.get(item.downloadId) ?? item).filter((p) => p.season === 2).map((p) => p.episode));
  assert.deepEqual([...filed].sort((a, b) => a - b), Array.from({ length: 54 }, (_, i) => i + 1));
  // Watched: what was really seen (catalog 1-20) is marked; labels 21-27,
  // marked before but not seen, are cleared.
  const cleared = watched.filter((w) => !w.value).flatMap((w) => w.list);
  const marked = watched.filter((w) => w.value).flatMap((w) => w.list);
  assert.deepEqual(cleared.sort(), ["2x21", "2x22", "2x23", "2x24", "2x25", "2x26", "2x27"].sort());
  assert.ok(marked.includes("2x20") && marked.includes("2x3") && !marked.includes("2x21"));
  // Checked once: a second start does nothing.
  assert.equal(checked.size, 61);
  relocated.clear();
  const again = await refileDownloads({
    native: { list: async () => ({ items }), relocate: async (move) => { relocated.set(move.downloadId, move); } },
    sourceFileName: async () => { throw new Error("not asked again"); },
    episodes: async () => catalog, resendProgress: () => {}, setWatched: async () => {}, saveMeta: async () => {},
    checked: { read: () => checked, write: (ids) => { checked = ids; } },
  });
  assert.equal(again.length, 0);
});

test("unreachable server: nothing moves and the download is checked next start", async () => {
  let checked = new Set();
  const moves = await refileDownloads({
    native: { list: async () => ({ items: [{ downloadId: "a", seriesId: "tmdb:tv:61709", season: 2, episode: 27 }] }), relocate: async () => { throw new Error("no"); } },
    sourceFileName: async () => null,
    episodes: async () => catalog, resendProgress: () => {}, setWatched: async () => {}, saveMeta: async () => {},
    checked: { read: () => checked, write: (ids) => { checked = ids; } },
  });
  assert.equal(moves.length, 0);
  assert.equal(checked.has("a"), false);
});
