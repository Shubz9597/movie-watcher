import assert from "node:assert/strict";
import test from "node:test";

import {
  isTmdbAnime,
  normalizeAnimeTitle,
  selectAniListCatalog,
} from "../../src/lib/anime-catalog.ts";
import {
  cardFromAniList,
  cardFromTmdbMovie,
  cardFromTmdbTv,
  detailFromTmdbMovie,
} from "../../src/lib/adapters/media.ts";

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

test("cardFromTmdbMovie maps TMDB fields to the renderer Card shape", () => {
  const card = cardFromTmdbMovie({
    id: 209867,
    title: "Frieren Movie",
    release_date: "2026-01-15",
    poster_path: "/frieren-poster.jpg",
    backdrop_path: "/frieren-backdrop.jpg",
    overview: "A fantasy journey.",
    vote_average: 8.7,
    popularity: 123.45,
    original_language: "ja",
    genre_ids: [16, 10759],
  });
  assert.equal(card.id, 209867);
  assert.equal(card.title, "Frieren Movie");
  assert.equal(card.year, 2026);
  assert.equal(card.posterPath, "https://image.tmdb.org/t/p/w342/frieren-poster.jpg");
  assert.equal(card.backdropUrl, "https://image.tmdb.org/t/p/w780/frieren-backdrop.jpg");
  assert.equal(card.rating, 8.7);
  assert.equal(card.tmdbRatingPct, 87);
  assert.deepEqual(card.genreIds, [16, 10759]);
  assert.equal(card.sourceProvider, "tmdb");
  assert.equal(card.sourceKind, "movie");
  assert.equal(card.sourceLabel, "TMDB");
});

test("cardFromTmdbTv keeps the TV kind while sharing the TMDB field mapping", () => {
  const card = cardFromTmdbTv({
    id: 209867,
    name: "Frieren",
    first_air_date: "2023-09-29",
    vote_average: 8.6,
    original_language: "ja",
    genre_ids: [16],
  });
  assert.equal(card.title, "Frieren");
  assert.equal(card.year, 2023);
  assert.equal(card.sourceKind, "tv");
  assert.equal(card.tmdbRatingPct, 86);
});

test("cardFromAniList maps AniList titles, artwork and score onto the Card shape", () => {
  const card = cardFromAniList({
    id: 154587,
    idMal: 52991,
    title: { english: "Frieren: Beyond Journey's End", romaji: "Sousou no Frieren", native: "葬送のフリーレン" },
    startDate: { year: 2023, month: 9, day: 29 },
    description: "<br>Journey beyond the end.",
    averageScore: 89,
    popularity: 250000,
    countryOfOrigin: "JP",
    coverImage: { extraLarge: "https://s4.anilist.co/anilist-cover.png", large: "https://s4.anilist.co/large.png" },
    bannerImage: "https://s4.anilist.co/banner.png",
  });
  assert.equal(card.id, 154587);
  assert.equal(card.title, "Frieren: Beyond Journey's End");
  assert.equal(card.year, 2023);
  assert.equal(card.posterPath, "https://s4.anilist.co/large.png");
  assert.equal(card.backdropUrl, "https://s4.anilist.co/banner.png");
  assert.equal(card.rating, 8.9);
  assert.equal(card.tmdbRatingPct, 89);
  assert.equal(card.originalLanguage, "ja");
  assert.deepEqual(card.genreIds, [16]);
  assert.equal(card.sourceProvider, "anilist");
  assert.equal(card.sourceKind, "anime");
  assert.equal(card.sourceLabel, "AniList");
  assert.equal(card.malId, 52991);
});

test("cardFromAniList falls back through the title ladder to the native title", () => {
  const card = cardFromAniList({
    id: 30001,
    title: { romaji: "Choujin X", native: "超人X" },
  });
  assert.equal(card.title, "Choujin X");
});

test("detailFromTmdbMovie maps crew, cast, trailer and external ids to Detail", () => {
  const detail = detailFromTmdbMovie({
    id: 209867,
    title: "Frieren Movie",
    release_date: "2026-01-15",
    overview: "A fantasy journey.",
    poster_path: "/frieren-poster.jpg",
    vote_average: 8.7,
    popularity: 123.45,
    original_language: "ja",
    genres: [{ name: "Animation" }, { name: "Adventure" }],
    runtime: 144,
    credits: {
      cast: [{ name: "Anne Cast", character: "Fern" }],
      crew: [
        { name: "Director One", job: "Director" },
        { name: "Writer One", job: "Writer" },
        { name: "Writer Two", job: "Screenplay" },
        { name: "Producer", job: "Producer" },
      ],
    },
    videos: { results: [{ type: "Trailer", site: "YouTube", key: "abc123" }] },
    external_ids: { imdb_id: "tt28015436" },
    tagline: "The journey continues.",
    status: "Released",
  });
  assert.equal(detail.id, 209867);
  assert.equal(detail.year, 2026);
  assert.deepEqual(detail.genres, ["Animation", "Adventure"]);
  assert.equal(detail.runtime, 144);
  assert.deepEqual(detail.cast, [{ name: "Anne Cast", character: "Fern" }]);
  assert.deepEqual(detail.directors, ["Director One"]);
  assert.deepEqual(detail.writers, ["Writer One", "Writer Two"]);
  assert.equal(detail.trailerKey, "abc123");
  assert.equal(detail.imdbId, "tt28015436");
  assert.equal(detail.tmdbRatingPct, 87);
  assert.equal(detail.tagline, "The journey continues.");
  assert.equal(detail.releaseDate, "2026-01-15");
  assert.equal(detail.status, "Released");
});
