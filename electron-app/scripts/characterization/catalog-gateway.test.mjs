import assert from "node:assert/strict";
import test from "node:test";

import {
  CatalogBffError,
  backendTitleToCard,
  bffSearch,
  bffSection,
  bffSectionPage,
  bffTitleDetail,
  catalogIdForSeriesId,
  continueEnrichmentFromBackend,
} from "../../src/lib/services/catalog-bff.ts";
import { detailFromBackendTitle } from "../../src/lib/adapters/media.ts";
import { createCatalogGateway } from "../../src/lib/services/catalog-gateway.ts";

const bffTitleRow = {
  id: "tmdb:tv:209867",
  type: "anime",
  title: "Frieren: Beyond Journey's End",
  originalTitle: "葬送のフリーレン",
  year: 2023,
  overview: "merged-overview",
  artwork: { poster: "https://poster.png", background: "https://bg.png" },
  providerIds: { tmdb: "tv:209867", anilist: "154587", jikan: "52991" },
  imdbId: "tt28015436",
  mergedFrom: ["tmdb", "anilist", "jikan"],
};

test("backendTitleToCard maps the contract row onto the renderer Card shape", () => {
  const card = backendTitleToCard(bffTitleRow);
  assert.equal(card.id, 154587, "anime navigation keeps its AniList id");
  assert.equal(card.title, "Frieren: Beyond Journey's End");
  assert.equal(card.sourceProvider, "anilist");
  assert.equal(card.sourceKind, "anime");
  assert.equal(card.sourceLabel, "ANILIST");
  assert.equal(card.posterPath, "https://poster.png");
  assert.equal(card.catalogId, "tmdb:tv:209867");
  assert.equal(card.providerIds.anilist, "154587");
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("bff search builds the contracted request and surfaces degraded errors without fallback", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return jsonResponse(503, {
      error: { code: "providers_unavailable", message: "all catalog providers failed", degradedProviders: ["tmdb", "anilist"] },
    });
  };

  await assert.rejects(
    bffSearch("frieren", "all", 24, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof CatalogBffError);
      assert.equal(error.code, "providers_unavailable");
      assert.deepEqual(error.degradedProviders, ["tmdb", "anilist"]);
      return true;
    },
    "bff failures must surface, never fall back to direct provider calls",
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/v2\/catalog\/search\?q=frieren&type=all&limit=24(&clientId=[0-9a-f-]+)?$/);
});

test("section summaries render without any title-detail requests", async () => {
  const requested = [];
  const movie = { ...bffTitleRow, id: "tmdb:movie:100", type: "movie", providerIds: { tmdb: "movie:100" } };
  const fetchImpl = async (url) => {
    requested.push(String(url));
    assert.ok(url.includes("/v2/catalog/sections"));
    return jsonResponse(200, { titleIds: [movie.id, bffTitleRow.id], results: [movie, bffTitleRow] });
  };
  const rows = await bffSection("trending", 1, { fetchImpl }, 'anime');
  assert.deepEqual(rows, [bffTitleRow], "filter the media kind before applying the rail limit");
  assert.equal(requested.length, 1, "one section request, no detail fan-out");
  assert.deepEqual(await bffSection("trending", 1, { fetchImpl }, 'anime', 2), []);
  assert.equal(requested.length, 1, "curated sections do not repeat page one");
});

test("older section responses produce an upgrade error instead of silent empty rails", async () => {
  await assert.rejects(bffSection("trending", 12, { fetchImpl: async () => jsonResponse(200, { titleIds: ['tmdb:1'] }) }),
    (error) => error instanceof CatalogBffError && error.code === 'unsupported_capability');
});

test("gateway reads the server catalog", async () => {
  const fetchRequests = [];
  const fetchImpl = async (url) => {
    fetchRequests.push(String(url));
    if (url.includes("/v2/catalog/search")) {
      return jsonResponse(200, { results: [bffTitleRow] });
    }
    return jsonResponse(404, { error: { code: "title_not_found" } });
  };
  const gateway = createCatalogGateway();

  const result = await gateway.searchMulti("frieren", 1, { fetchImpl });
  assert.equal(result.anime.length, 1, "rows grouped by renderer sourceKind");
  assert.equal(result.movie.length, 0);
  // The first request is the negotiation version check (fail-open on 404);
  // the catalog search follows on the contracted endpoint.
  assert.ok(fetchRequests.some((url) => url.includes("/v1/version")));
  assert.ok(fetchRequests.some((url) => url.includes("/v2/catalog/search?q=frieren")));
});

test("gateway catalog errors propagate", async () => {
  const gateway = createCatalogGateway();
  const fetchImpl = async () => jsonResponse(503, { error: { code: "providers_unavailable", message: "down", degradedProviders: ["tmdb"] } });

  await assert.rejects(
    gateway.getTrendingAnime(1, 12, { fetchImpl }),
    (error) => error instanceof CatalogBffError && error.code === "providers_unavailable",
  );
});

test('catalog lists expose cards and pagination', async () => {
  const gateway = createCatalogGateway();
  const titles = [
    { id: 'tmdb:movie:100', type: 'movie', title: 'Movie', year: 2024, artwork: { poster: 'https://image.tmdb.org/t/p/w342/movie.jpg' }, providerIds: { tmdb: 'movie:100' } },
    { id: 'tmdb:tv:200', type: 'series', title: 'Series', year: 2023, artwork: { poster: 'https://image.tmdb.org/t/p/w342/tv.jpg' }, providerIds: { tmdb: 'tv:200' } },
    { ...bffTitleRow, title: 'Anime' },
  ];
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (url.includes('/v1/version')) return jsonResponse(404, {});
    assert.ok(url.includes('/sections') || url.includes('/search'));
    return jsonResponse(200, { results: url.includes('/search') ? [titles[2]] : titles });
  };
  const cases = [
    ['getMovies', [1, 'popular'], [100, 'Movie', 2024, 'movie']],
    ['getTvShows', [1, 'trending'], [200, 'Series', 2023, 'tv']],
    ['getTrendingAnime', [1, 25], [154587, 'Anime', 2023, 'anime']],
    ['getAnimeList', [1, 25], [154587, 'Anime', 2023, 'anime']],
    ['searchAnime', ['Anime', 1, 24], [154587, 'Anime', 2023, 'anime']],
  ];
  for (const [name, args, expected] of cases) {
    const page = await gateway[name](...args, { fetchImpl });
    assert.equal(page.items.length, 1, name);
    const card = page.items[0];
    assert.deepEqual([card.id, card.title, card.year, card.sourceKind], expected, name);
    assert.equal(card.catalogId, titles.find((row) => row.title === card.title).id);
  }
  assert.ok(requests.some((url) => url.includes('kind=popular')));
  assert.ok(!requests.some((url) => url.includes('/titles/')));
});
test("bffTitleDetail maps detail enrichment onto the renderer Detail shape", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    return jsonResponse(200, {
      id: "tmdb:tv:209867",
      type: "series",
      title: "Frieren",
      year: 2023,
      overview: "overview",
      artwork: { poster: "https://poster.png" },
      providerIds: { tmdb: "tv:209867", imdb: "tt28015436" },
      imdbId: "tt28015436",
      runtime: 24,
      genres: ["Animation", "Adventure"],
      ratings: { imdb: { rating: 8.9, votes: 1000 } },
      seasons: [
        { number: 1, name: "Season 1", episodeCount: 28, airDate: "2023-09-29" },
        { number: 2, name: "Season 2", episodeCount: 12 },
      ],
    });
  };
  const detail = detailFromBackendTitle(await bffTitleDetail("tmdb:tv:209867", { fetchImpl }));
  assert.match(requests[0], /\/v2\/catalog\/titles\/tmdb:tv:209867/);
  assert.equal(detail.id, 209867);
  assert.equal(detail.title, "Frieren");
  assert.equal(detail.runtime, 24);
  assert.equal(detail.imdbId, "tt28015436");
  assert.equal(detail.imdbRating, 8.9);
  assert.equal(detail.imdbVotes, 1000);
  assert.deepEqual(detail.genres, ["Animation", "Adventure"]);
  assert.equal(detail.totalEpisodes, 40, "season episode counts sum");
  assert.equal(detail.trailerKey, null, "fields the contract lacks stay unknown");
  assert.equal(detail.cast.length, 0);
});

test("continue enrichment mapping keeps provider ids and covers seriesId shapes", () => {
  // M3.1.1: the media qualifier is PRESERVED — the catalog id is exactly the
  // qualified progress vocabulary, so enrichment addresses the requested
  // media type instead of the ambiguous legacy alias.
  assert.equal(catalogIdForSeriesId("tmdb:movie:123"), "tmdb:movie:123");
  assert.equal(catalogIdForSeriesId("tmdb:tv:456"), "tmdb:tv:456");
  assert.equal(catalogIdForSeriesId("anilist:154587"), "anilist:154587");
  assert.equal(catalogIdForSeriesId("mal:52991"), "jikan:52991");
  assert.equal(catalogIdForSeriesId("bogus"), null);
  assert.equal(catalogIdForSeriesId("tmdb:movie:notanumber"), null);

  const enrichment = continueEnrichmentFromBackend({
    id: "anilist:154587",
    type: "anime",
    title: "Frieren",
    year: 2023,
    artwork: { poster: "https://poster.png" },
    providerIds: { anilist: "154587", jikan: "52991" },
  });
  assert.deepEqual(enrichment, { title: "Frieren", posterPath: "https://poster.png", year: 2023, anilistId: 154587, malId: 52991 });
  assert.equal(continueEnrichmentFromBackend({ id: "tmdb:1", type: "movie", title: "" }), null, "empty title is not an enrichment");
});

test("paged and genre section requests use the additive contract parameters", async () => {
  const requests = [];
  const rows = [{ id: "tmdb:100", type: "movie", title: "Movie", providerIds: { tmdb: "100" } }];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    // The server only returns page/totalPages for paged or genre requests.
    const isPlain = url.includes("kind=trending");
    return jsonResponse(200, isPlain
      ? { titleIds: ["tmdb:100"], results: rows }
      : { titleIds: ["tmdb:100"], results: rows, page: 3, totalPages: 42 });
  };
  const paged = await bffSectionPage("popular", 3, { fetchImpl }, "movie");
  assert.match(requests[0], /\/v2\/catalog\/sections\?kind=popular&page=3$/);
  assert.equal(paged.totalPages, 42);
  assert.deepEqual(paged.titles, rows);

  const genre = await bffSectionPage("popular", 1, { fetchImpl }, "movie", 28);
  assert.match(requests[1], /\/v2\/catalog\/sections\?kind=popular&genre=28&type=movie$/);
  assert.equal(genre.totalPages, 42);

  const animeGenre = await bffSectionPage("popular", 1, { fetchImpl }, "anime", "Slice of Life");
  assert.match(requests[2], /\/v2\/catalog\/sections\?kind=popular&genre=Slice\+of\+Life&type=anime$/);
  assert.equal(animeGenre.totalPages, 42);

  const plain = await bffSectionPage("trending", 1, { fetchImpl });
  assert.match(requests[3], /\/v2\/catalog\/sections\?kind=trending$/);
  assert.equal(plain.totalPages, undefined, "page one without genre keeps the original response shape");
});

test("gateway exposes genre rails and pages", async () => {
  const requests = [];
  const rows = [
    { id: "tmdb:100", type: "movie", title: "Movie", providerIds: { tmdb: "100" } },
    { id: "tmdb:200", type: "series", title: "Series", providerIds: { tmdb: "200" } },
  ];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (url.includes("/v1/version")) return jsonResponse(404, {});
    return jsonResponse(200, { titleIds: rows.map((r) => r.id), results: rows, page: 2, totalPages: 5 });
  };
  const gateway = createCatalogGateway();

  const genrePage = await gateway.getTitlesByGenre("movie", 28, 2, { fetchImpl });
  assert.ok(requests.some((url) => url.includes("kind=popular&page=2&genre=28&type=movie")));
  assert.equal(genrePage.items.length, 1, "media kind filtered client-side");
  assert.equal(genrePage.items[0].id, 100);
  assert.equal(genrePage.totalPages, 5, "bff pagination is no longer capped at one page");

  const movies = await gateway.getMovies(2, "popular", { fetchImpl });
  assert.equal(movies.totalPages, 5);

  const anime = await gateway.getAnimeByGenre("Slice of Life", 2, 25, { fetchImpl });
  assert.ok(requests.some((url) => url.includes("kind=popular&page=2&genre=Slice+of+Life&type=anime")));
  assert.equal(anime.items.length, 0, "non-anime rows cannot leak into the anime genre page");
});

test("origin switch aborts and stale-guards bff requests", async () => {
  const { setBackendOrigin, subscribeOrigin } = await import("../../src/lib/connection-service.ts");
  const events = [];
  const unsubscribe = subscribeOrigin((origin) => events.push(origin));
  try {
    setBackendOrigin("http://origin-a:4001");
    assert.equal(events.at(-1), "http://origin-a:4001");
    // A fetch that resolves only after the switch must be discarded with a
    // truthful origin_changed error, never applied to the new origin.
    let resolveLate;
    const fetchImpl = async () => new Promise((resolve) => { resolveLate = resolve; });
    // Real path (no deps.fetchImpl) is what the guards protect; emulate the
    // shared client by calling without deps and flipping the origin while
    // the request is pending. Use a pending global fetch instead.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => new Promise((resolve) => { resolveLate = resolve; });
    const pending = bffSearch("frieren", "all", 24);
    setBackendOrigin("http://origin-b:4001");
    resolveLate(new Response(JSON.stringify({ results: [bffTitleRow] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await assert.rejects(
      pending,
      (error) => error instanceof CatalogBffError && error.code === "origin_changed",
      "late old-origin responses must not update new-origin state",
    );
    globalThis.fetch = originalFetch;
  } finally {
    unsubscribe();
    setBackendOrigin("http://localhost:4001");
  }
});

test("fixture adapter is explicit and scenario-driven", async () => {
  const { FixtureConnection, FixtureStorage, fixtureFetch } = await import("../../src/platform/fixtures.ts");
  const ok = new FixtureConnection("ok");
  const ready = await ok.check();
  assert.equal(ready.status, "ready");
  const unreachable = await new FixtureConnection("unreachable").check();
  assert.equal(unreachable.status, "unreachable");
  const incompatible = await new FixtureConnection("incompatible").check();
  assert.equal(incompatible.status, "incompatible");

  const rows = await (await fixtureFetch("ok")("/v2/catalog/search?q=x")).json();
  assert.equal(rows.results.length, 3);
  const animeOnly = await (await fixtureFetch("ok")("/v2/catalog/search?q=x&type=anime")).json();
  assert.equal(animeOnly.results.length, 1, "type filter is honored");
  const detail = await (await fixtureFetch("ok")("/v2/catalog/titles/anilist:154587")).json();
  assert.equal(detail.title, "Frieren: Beyond Journey's End");
  assert.ok(detail.seasons[0].episodeCount > 0);
  const episodes = await (await fixtureFetch("ok")("/v2/catalog/titles/anilist:154587/episodes?season=1")).json();
  assert.equal(episodes.episodes.length, 28);

  const storage = new FixtureStorage();
  assert.match(storage.getClientId(), /^[0-9a-f-]+$/);
  storage.setPreference("k", "v");
  assert.equal(storage.getPreference("k"), "v");
});

test("M3.1.1 qualified identity trace: qualified ids survive the card, catalogId and enrichment mapping", () => {
  // A series row whose numeric TMDb id collides with a movie: the server
  // now emits the media-qualified canonical id (tmdb:tv:123) and the
  // media-qualified provider id ("tv:123"). The card keeps the numeric id
  // for display/navigation, its media kind, AND the opaque qualified
  // catalogId. The client never re-derives the ambiguous numeric form.
  const seriesRow = {
    id: "tmdb:tv:123",
    type: "series",
    title: "Collision Series",
    year: 2021,
    providerIds: { tmdb: "tv:123" },
  };
  const card = backendTitleToCard(seriesRow);
  assert.equal(card.id, 123, "numeric display id survives the qualified id");
  assert.equal(card.sourceKind, "tv");
  assert.equal(card.catalogId, "tmdb:tv:123", "opaque catalog id stays media-qualified");
  assert.equal(card.providerIds.tmdb, "tv:123");

  // The progress vocabulary was ALWAYS media-qualified ("tmdb:movie:N" /
  // "tmdb:tv:N" / "mal:N" / "anilist:N"), so watch progress never needs
  // rekeying. RESOLVED (M3.1.1): the bff enrichment helper now preserves the
  // qualifier — enrichment detail lookups address exactly the requested
  // media type and never collapse to the lossy `tmdb:123` alias.
  assert.equal(catalogIdForSeriesId("tmdb:tv:123"), "tmdb:tv:123", "qualifier preserved");
  assert.equal(catalogIdForSeriesId("tmdb:movie:123"), "tmdb:movie:123", "qualifier preserved");

  // RESOLVED (M3.1.1): TitlePage's bff loader requests detail by the
  // media-qualified id built from the route's explicit media namespace
  // (kind / mediaKind), and gateway.getTvSeason requests `tmdb:tv:<n>`
  // — verified by the detail-request tests above and the bffTitleDetail
  // URL assertion. The unqualified alias remains a read-only legacy form.
});
