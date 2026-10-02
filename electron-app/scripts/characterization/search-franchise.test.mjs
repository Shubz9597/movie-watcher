import assert from "node:assert/strict";
import test from "node:test";

const { organizeSearchResults, resultLabel } = await import("../../src/lib/search-franchise.ts");

const ds = (id, title, year, extra = {}) => ({ id, title, year, ...extra });

test("franchise entries group with the main series first and extras collapsed", () => {
  const ranked = [
    ds(1, "Demon Slayer", 2003, { sourceProvider: "tmdb", sourceKind: "movie", format: "movie" }),
    ds(2, "Demon Slayer: Kimetsu no Yaiba Infinity Castle", 2025, { sourceProvider: "tmdb", sourceKind: "movie", format: "movie" }),
    ds(3, "Demon Slayer: Kimetsu no Yaiba", 2019, { sourceProvider: "tmdb", sourceKind: "anime", format: "tv" }),
    ds(4, "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train", 2020, { sourceProvider: "tmdb", sourceKind: "movie", format: "movie" }),
    ds(5, "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train", 2020, { sourceProvider: "anilist", sourceKind: "anime", format: "movie" }),
    ds(6, "Demon Slayer: Kimetsu no Yaiba Swordsmith Village Arc", 2023, { sourceProvider: "anilist", sourceKind: "anime", format: "tv", popularity: 376151 }),
    ds(9, "Demon Slayer: Kimetsu no Yaiba Entertainment District Arc", 2021, { sourceProvider: "anilist", sourceKind: "anime", format: "tv", popularity: 487489 }),
    ds(7, "Demon Slayer: Kimetsu no Yaiba Hashira Training Arc", 2024, { sourceProvider: "anilist", sourceKind: "anime", format: "tv", popularity: 200 }),
    ds(8, "Demon Slayer: Kimetsu no Yaiba Infinity Castle Part 2", undefined, { sourceProvider: "anilist", sourceKind: "anime", format: "movie" }),
  ];
  const entries = organizeSearchResults(ranked);
  const items = entries.filter((entry) => entry.kind === "item").map((entry) => entry.item.id);
  assert.equal(items[0], 1, "unrelated 2003 film stays its own result");
  assert.equal(items[1], 3, "the original series leads even when later arcs are more popular");
  assert.ok(!items.includes(4), "cross-provider duplicate collapses to the AniList entry");
  const more = entries.find((entry) => entry.kind === "more");
  assert.ok(more && more.hidden > 0 && more.name === "Demon Slayer", "long franchises collapse behind Show more");
  const expanded = organizeSearchResults(ranked, new Set([more.groupKey]));
  assert.equal(expanded.filter((entry) => entry.kind === "item").at(-1).item.id, 8, "unreleased entries sort last");
});

test("labels name kind and format", () => {
  assert.equal(resultLabel({ sourceProvider: "anilist", format: "movie" }), "Anime movie");
  assert.equal(resultLabel({ sourceProvider: "anilist", format: "tv" }), "Anime series");
  assert.equal(resultLabel({ sourceProvider: "tmdb", sourceKind: "tv", format: "tv" }), "Series");
  assert.equal(resultLabel({ sourceProvider: "tmdb", sourceKind: "movie", format: "movie" }), "Movie");
});
