import assert from "node:assert/strict";
import test from "node:test";

import {
  isTmdbAnime,
  normalizeAnimeTitle,
  selectAniListCatalog,
} from "../../src/lib/anime-catalog.ts";

test("normalizeAnimeTitle collapses season and part markers to a stable key", () => {
  assert.equal(normalizeAnimeTitle("Frieren: Beyond Journey's End"), "frieren beyond journey s end");
  assert.equal(normalizeAnimeTitle("Frieren: Beyond Journey's End — Season 1 Part 2"), "frieren beyond journey s end");
  assert.equal(normalizeAnimeTitle("Re:Zero − Starting Life in Another World"), "re zero starting life in another world");
  assert.equal(normalizeAnimeTitle("  One-Punch Man Season 2  "), "one punch man");
});

test("isTmdbAnime requires TMDB source, Japanese language and the Animation genre", () => {
  assert.equal(
    isTmdbAnime({ sourceProvider: "tmdb", originalLanguage: "ja", genreIds: [16, 10759] }),
    true,
  );
  assert.equal(
    isTmdbAnime({ sourceProvider: "tmdb", originalLanguage: "ja", genreIds: [28] }),
    false,
  );
  assert.equal(
    isTmdbAnime({ sourceProvider: "tmdb", originalLanguage: "en", genreIds: [16] }),
    false,
  );
  assert.equal(
    isTmdbAnime({ sourceProvider: "anilist", originalLanguage: "ja", genreIds: [16] }),
    false,
  );
});

test("selectAniListCatalog dedupes by id, keeps first occurrence and order", () => {
  const items = [
    { id: 154587, title: "Frieren" },
    { id: 21, title: "One Piece" },
    { id: 154587, title: "Frieren duplicate" },
    { id: 16498, title: "Sugar Apple Fairy Tale" },
  ];
  assert.deepEqual(selectAniListCatalog(items).map((item) => item.id), [154587, 21, 16498]);
  assert.deepEqual(selectAniListCatalog(items, 2).map((item) => item.id), [154587, 21]);
});
