import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EPISODE_FOR_MATCH,
  detectSeasonPack,
  extractEpisodeHints,
  matchesEpisode,
  pad,
  pickFileIndexForEpisode,
  seasonPackContainsEpisode,
} from "../../src/lib/anime-matching.ts";

test("pad zero-fills to the requested width", () => {
  assert.equal(pad(5), "05");
  assert.equal(pad(7, 3), "007");
  assert.equal(pad(12), "12");
});

test("matchesEpisode honors season-episode pairs, loose tokens and absolutes", () => {
  assert.equal(matchesEpisode("Show S01E05 1080p", 1, 5), true);
  assert.equal(matchesEpisode("Show S02E05 1080p", 1, 5), false);
  assert.equal(matchesEpisode("Show - 05 [1080p]", undefined, 5), true);
  assert.equal(matchesEpisode("Show Episode 12", undefined, undefined, 12), true);
  assert.equal(matchesEpisode("[SubsPlease] Show - 05 (1080p)", undefined, undefined, 5), true);
  assert.equal(matchesEpisode("Show S01E05", undefined, 5), true, "season omitted by caller matches any season");
  assert.equal(matchesEpisode("Just a movie name", 1, 5), false);
});

test("matchesEpisode ignores resolution, year, codec and version false positives", () => {
  assert.equal(matchesEpisode("Show 1080p (2023) x265 v2", undefined, 80), false);
  assert.equal(matchesEpisode("Show.2023.1080p.BluRay.x264", undefined, 23), false);
  assert.equal(matchesEpisode("Show AAC 2.0 [AC3 5.1]", undefined, 20), false);
});

test("matchesEpisode without requested episodes accepts everything", () => {
  assert.equal(matchesEpisode("Anything at all"), true);
});

test("extractEpisodeHints separates per-season and generic hints", () => {
  const hints = extractEpisodeHints("Show_S01E01-E03 [1080p]");
  assert.deepEqual([...hints.bySeason.get(1)].sort((a, b) => a - b), [1, 2, 3]);
  const generic = extractEpisodeHints("Show - 07 [1080p]").generic;
  assert.equal(generic.has(7), true);
});

test("detectSeasonPack classifies packs, ranges and season matches", () => {
  const pack = detectSeasonPack("Show S01 Complete Batch", 1);
  assert.equal(pack.isSeasonPack, true);
  assert.equal(pack.seasonMatch, true);
  assert.ok(pack.keywords.includes("complete"));
  assert.ok(pack.keywords.includes("batch"));

  const plain = detectSeasonPack("Show - 05 [1080p]", 1);
  assert.equal(plain.isSeasonPack, false);
  assert.equal(plain.seasonMatch, false);
  assert.equal(plain.reason, undefined);

  const range = detectSeasonPack("[SubsPlease] Show (01-12) (1080p)");
  assert.equal(range.isSeasonPack, true);
  assert.ok(range.keywords.includes("episode-range"));

  assert.equal(MAX_EPISODE_FOR_MATCH, 999);
});

test("seasonPackContainsEpisode keeps named packs but filters mismatched ranges", () => {
  assert.equal(seasonPackContainsEpisode("Show Complete Batch", 1, 5), true);
  assert.equal(seasonPackContainsEpisode("Show S01E01-E12 Batch", 1, 5), true);
  assert.equal(seasonPackContainsEpisode("Show S01E01-E04 Batch", 1, 5), false);
  assert.equal(seasonPackContainsEpisode("Show - 05 [1080p]", 1, 5), false, "not a pack at all");
});

test("pickFileIndexForEpisode selects the best matching video file", () => {
  const files = [
    { index: 0, name: "Show S01E04.mkv", length: 400 * 1024 * 1024 },
    { index: 1, name: "Show S01E05.mkv", length: 500 * 1024 * 1024 },
    { index: 2, name: "Show S01E05 (OVA).mp4", length: 100 * 1024 * 1024 },
  ];
  const picked = pickFileIndexForEpisode(files, { season: 1, episode: 5 });
  assert.equal(picked.index, 1);
  assert.equal(picked.matched, true);
  assert.equal(picked.name, "Show S01E05.mkv");
  assert.ok(picked.score > 0);
});

test("pickFileIndexForEpisode penalizes part files and prefers video extensions", () => {
  const files = [
    { index: 0, name: "Show S01E05 Part 2.mkv", length: 700 * 1024 * 1024 },
    { index: 1, name: "Show S01E05.mkv", length: 400 * 1024 * 1024 },
  ];
  const picked = pickFileIndexForEpisode(files, { season: 1, episode: 5 });
  assert.equal(picked.index, 1, "the -20 part penalty must outweigh the size bonus");
});

test("pickFileIndexForEpisode still matches name tokens when no video extension exists", () => {
  const files = [
    { index: 0, name: "Show - 05.bin", length: 100 },
    { index: 1, name: "Show - 06.bin", length: 900 },
  ];
  const picked = pickFileIndexForEpisode(files, { season: 1, episode: 5 });
  assert.ok(picked, "a candidate is still returned from the full pool");
  assert.equal(picked.index, 0, "episode tokens in the filename win even without a video extension");
  assert.equal(picked.matched, true);
});

test("pickFileIndexForEpisode returns null for empty input", () => {
  assert.equal(pickFileIndexForEpisode([], { season: 1, episode: 5 }), null);
});
