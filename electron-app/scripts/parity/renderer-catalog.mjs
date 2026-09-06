// Renderer parity harness: consumes the shared golden parity fixture and
// emits the Electron renderer's characterized catalog rows (the P0
// characterization pipeline: adapter transforms + isTmdbAnime rail filter +
// selectAniListCatalog dedupe, per GlobalSearch.tsx / HomePage.tsx).
//
// Usage: node --experimental-strip-types scripts/parity/renderer-catalog.mjs \
//   <parity-fixture.json> <renderer-rows-output.json>
import fs from "node:fs";

import { isTmdbAnime, selectAniListCatalog } from "../../src/lib/anime-catalog.ts";
import { cardFromAniList, cardFromTmdbMovie, cardFromTmdbTv } from "../../src/lib/adapters/media.ts";

const [, , fixturePath, outputPath] = process.argv;
if (!fixturePath || !outputPath) {
  console.error("usage: renderer-catalog.mjs <fixture.json> <output.json>");
  process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function comparableCard(card) {
  return {
    provider: card.sourceProvider,
    id: card.id,
    title: card.title,
    year: card.year ?? null,
    originalLanguage: card.originalLanguage ?? null,
    genreIds: card.genreIds ?? [],
    sourceKind: card.sourceKind ?? null,
  };
}

const tmdb = { movies: [], tv: [], droppedAnimeCards: [] };
for (const item of fixture.providers.tmdb.results) {
  const card = item.media_type === "movie" ? cardFromTmdbMovie(item) : cardFromTmdbTv(item);
  if (isTmdbAnime(card)) {
    tmdb.droppedAnimeCards.push(comparableCard(card));
  } else if (item.media_type === "movie") {
    tmdb.movies.push(comparableCard(card));
  } else {
    tmdb.tv.push(comparableCard(card));
  }
}

const anilistAnime = selectAniListCatalog(
  (fixture.providers.anilist.data.Page.media || []).map(cardFromAniList),
).map(comparableCard);

// The renderer search pipeline does not aggregate Jikan results into rails
// (jikan-service is used for enrichment only) — recorded, not synthesized.

const output = {
  scenario: fixture.scenario,
  pipeline: "GlobalSearch/HomePage characterization: cardFromTmdb* -> isTmdbAnime rail filter; cardFromAniList -> selectAniListCatalog dedupe",
  tmdb,
  anilist: { anime: anilistAnime },
  jikan: { anime: [] },
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(`renderer rows written: ${outputPath}`);
