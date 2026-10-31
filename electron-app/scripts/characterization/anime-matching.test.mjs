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

test("pickFileIndexForEpisode reads dot-separated episode numbers in packs", () => {
  const dir = "[SoM] Dragon Ball Kai (2009) (BD 1080p x264 FLAC) [Dual Audio]/";
  const files = [
    { index: 0, name: `${dir}Extras/NCOP-NCEDs/Dragon Ball Kai NCOP 1 - Dragon Soul.mkv`, length: 2e8 },
    { index: 1, name: `${dir}Dragon.Ball.Kai.2009.001.1080p.BD.Dual-Audio.FLAC2.0.Hi10P.x264-SoM.mkv`, length: 3e9 },
    { index: 2, name: `${dir}Dragon.Ball.Kai.2009.022.1080p.BD.Dual-Audio.FLAC2.0.Hi10P.x264-SoM.mkv`, length: 3e9 },
    { index: 3, name: `${dir}Dragon.Ball.Kai.2009.098.1080p.BD.Dual-Audio.FLAC2.0.Hi10P.x264-SoM.mkv`, length: 3e9 },
  ];
  assert.equal(pickFileIndexForEpisode(files, { season: 1, episode: 22, absolute: 22 }).index, 2);
  assert.equal(pickFileIndexForEpisode(files, { season: 1, episode: 1, absolute: 1 }).index, 1);
  assert.equal(pickFileIndexForEpisode(files, { season: 1, episode: 98, absolute: 98 }).index, 3);
  assert.equal(pickFileIndexForEpisode(files, { season: 1, episode: 99, absolute: 99 }).matched, false);
  assert.equal(matchesEpisode("Show/Season 1/05.mkv", undefined, 5), true);
});

// Real pack layouts that broke the matcher, checked against Torrentio's own
// per-episode file mapping (615/615 across 44 packs after the fix).
test("pickFileIndexForEpisode reads the episode from the file name, not the folder", () => {
  const range = [1, 2, 3].map((n) => ({ index: n, name: `Better.Call.Saul.S02E01-10.1080p.NF.WEB-DL/Better.Call.Saul.S02E0${n}.Title.1080p.mkv`, length: 1e9 + n }));
  assert.equal(pickFileIndexForEpisode(range, { season: 2, episode: 2 }).index, 2, "a S02E01-10 folder does not vouch for every file");
  const dotted = [1, 2].map((n) => ({ index: n, name: `Show.S02.1080p/Show.S02E0${n}.1080p.BluRay.x264.mkv`, length: 1e9 + (2 - n) }));
  assert.equal(pickFileIndexForEpisode(dotted, { season: 2, episode: 2 }).index, 2, "S02E01.1080p is not a range up to 1080");
  const titled = [
    { index: 0, name: "Show - S05E02 - 50% Off.mkv", length: 2e9 },
    { index: 1, name: "Show - S05E04 - Namaste.mkv", length: 1e9 },
  ];
  assert.equal(pickFileIndexForEpisode(titled, { season: 5, episode: 4 }).index, 1, "a title starting with a number is not a range");
});

test("pickFileIndexForEpisode honors episode markers and season folders", () => {
  const files = [1, 2, 3].map((n) => ({ index: n, name: `Show - Season 2 1080p WEBRip/E0${n} Name.mp4`, length: 1e9 }));
  assert.equal(pickFileIndexForEpisode(files, { season: 2, episode: 3 }).index, 3);
  const seasons = [
    { index: 0, name: "Show/Season 1/03.mkv", length: 2e9 },
    { index: 1, name: "Show/Season 2/03.mkv", length: 1e9 },
  ];
  assert.equal(pickFileIndexForEpisode(seasons, { season: 2, episode: 3 }).index, 1, "TV season folders must agree");
});

test("pickFileIndexForEpisode ignores numbers inside episode titles", () => {
  const files = [
    { index: 0, name: "Dragon Ball Kai - S01E20 - Vegeta, Burning With Ambition.mkv", length: 1e9 },
    { index: 1, name: "Dragon Ball Kai - S01E62 - Piccolo's Assault! Android 20 and the Twisted Future!.mkv", length: 2e9 },
    { index: 2, name: "Dragonball Z Kai 62 Piccolo's Assault! Android 20.mkv", length: 2e9 },
    { index: 3, name: "Dragonball Z Kai 20 The Rebellion Against Frieza.mkv", length: 1e9 },
  ];
  assert.equal(pickFileIndexForEpisode(files.slice(0, 2), { season: 1, episode: 20, absolute: 20, anime: true }).index, 0);
  assert.equal(pickFileIndexForEpisode(files.slice(2), { season: 1, episode: 20, absolute: 20, anime: true }).index, 3);
  const special = [
    { index: 0, name: "Kai/Season 1/Dragon Ball Kai - S01E28 - The Ginyu Special Force Has Arrived!.mkv", length: 1e9 },
    { index: 1, name: "Kai/Season 2/Dragon Ball Kai - S02E28 - Super Saiyan 3!!.mkv", length: 2e9 },
  ];
  assert.equal(pickFileIndexForEpisode(special, { season: 1, episode: 28, absolute: 28, anime: true }).index, 0, "\"Special Force\" is an episode, not an extra");
});

test("pickFileIndexForEpisode keeps to the requested show inside a franchise collection", () => {
  const files = [
    { index: 0, name: "DB/Dragon Ball GT [DVDRip]/[RH] Dragon Ball GT - 03 [D8016271].mkv", length: 9e8 },
    { index: 1, name: "DB/Dragon Ball Super/Season 1/Dragon Ball Super - S01E03 - King Kai's Planet.mkv", length: 2e9 },
    { index: 2, name: "DB/Dragon Ball Kai/Season 1 (Saiyan Saga)/[AnimeRG] Dragon Ball KAI - 003 [1080p].mkv", length: 3e8 },
    { index: 3, name: "DB/Movies/Dragon Ball Z/Dragon Ball Z - 03 - The Tree of Might.mkv", length: 3e9 },
  ];
  const picked = pickFileIndexForEpisode(files, { season: 1, episode: 3, absolute: 3, anime: true, titles: ["Dragon Ball Kai"] });
  assert.equal(picked.index, 2);
});

test("a pack numbered across seasons: the absolute number wins over another season's episode", () => {
  // Dragon Ball Z Kai The Complete Series: Season 2 Episode 2 is "Episode 100";
  // "Episode 2" is Season 1's and is the bigger file (it won before).
  const dir = "Dragon Ball Z Kai The Complete Series (2009–2015)/";
  const files = [
    { index: 55, name: `${dir}Episode 99 Seven Years Later! Starting Today, Gohan Is a High School Student.mkv`, length: 1003150720 },
    { index: 112, name: `${dir}Episode 100 A New Hero, Great Saiyaman, Is Born!.mkv`, length: 1000544087 },
    { index: 140, name: `${dir}Episode 2 The Enemy is Goku's Brother! The Secret of the Mighty Saiyan Warriors.mkv`, length: 1076220552 },
    { index: 21, name: `${dir}Episode 3 A Life or Death Battle! Goku and Piccolo's Desperate Attack!.mkv`, length: 1076758120 },
  ];
  const titles = ["Dragon Ball Z Kai"];
  assert.equal(pickFileIndexForEpisode(files, { season: 2, episode: 2, absolute: 100, anime: true, titles }).index, 112);
  assert.equal(pickFileIndexForEpisode(files, { season: 2, episode: 1, absolute: 99, anime: true, titles }).index, 55);
  assert.equal(pickFileIndexForEpisode(files, { season: 1, episode: 2, absolute: 2, anime: true, titles }).index, 140);
  // A per-season folder vouches for the in-season number.
  const seasonFolders = [
    { index: 0, name: "Show/Season 1/Episode 2.mkv", length: 900 },
    { index: 1, name: "Show/Season 2/Episode 2.mkv", length: 800 },
  ];
  assert.equal(pickFileIndexForEpisode(seasonFolders, { season: 2, episode: 2, absolute: 14 }).index, 1);
});

test("a pack that names its episodes is matched by title: its numbering can be another release's", () => {
  // Dragon Ball Z Kai's complete pack numbers The Final Chapters as the
  // 69-episode international release; the catalog lists the 61 broadcast
  // episodes. S2E27 is "Episode 132"; "Episode 125" is S2E20.
  const dir = "Dragon Ball Z Kai The Complete Series (2009–2015)/";
  const files = [
    { index: 55, name: `${dir}Episode 99 Seven Years Later! Starting Today, Gohan Is a High School Student.mkv`, length: 923340998 },
    { index: 112, name: `${dir}Episode 100 A New Hero, Great Saiyaman, Is Born!.mkv`, length: 922388128 },
    { index: 113, name: `${dir}Episode 101 Videl's Crisis Gohan's Urgent Call-out!.mkv`, length: 920796165 },
    { index: 105, name: `${dir}Episode 104 Gohan the Teacher! Videl's Flying Technique Tutorial.mkv`, length: 920884878 },
    { index: 86, name: `${dir}Episode 125 Turn Into Candy! A Hungry Majin's Bizarre Power!.mkv`, length: 1010070052 },
    { index: 98, name: `${dir}Episode 132 A Time of Trials! Lay Hold of Legendary Powers!.mkv`, length: 904045228 },
    { index: 95, name: `${dir}Episode 133 Hold Majin Buu in Check! Limit - Super Saiyan 3!.mkv`, length: 906352477 },
  ];
  const titles = ["Dragon Ball Z Kai"];
  const pick = (episode, absolute, episodeTitle) => pickFileIndexForEpisode(files, { season: 2, episode, absolute, anime: true, titles, episodeTitle }).index;
  assert.equal(pick(27, 125, "A Time of Trials! Lay Hold of Legendary Powers!"), 98);
  assert.equal(pick(20, 118, "Turn Into Candy! A Hungry Majin's Bizarre Power!"), 86);
  assert.equal(pick(3, 101, "Gohan the Teacher! Videl's Flying Technique Tutorial"), 105);
  assert.equal(pick(2, 100, "A New Hero, Great Saiyaman, is Born!"), 112);
  // No title (or a placeholder one): numbers, as before.
  assert.equal(pick(2, 100, undefined), 112);
  assert.equal(pick(2, 100, "Episode 2"), 112);
  // A title no file carries: numbers decide.
  assert.equal(pick(3, 101, "Something Else Entirely Happens Here"), 113);
});
