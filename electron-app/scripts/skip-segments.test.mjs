import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSkipSegmentCache,
  getSkipSegments,
  normalizeAniSkipResponse,
  normalizeTheIntroDBResponse,
} from "../electron/playback/skip-segments.js";

test.beforeEach(() => clearSkipSegmentCache());

test("normalizes AniSkip segments and adjusts small release-duration differences", () => {
  const payload = {
    found: true,
    results: [
      { skipType: "op", episodeLength: 1440, interval: { startTime: 90, endTime: 150 } },
      { skipType: "ed", episodeLength: 1440, interval: { startTime: 1320, endTime: 1410 } },
    ],
  };

  assert.deepEqual(normalizeAniSkipResponse(payload, 1445), [
    { type: "intro", start: 95, end: 155, provider: "aniskip" },
    { type: "credits", start: 1325, end: 1415, provider: "aniskip" },
  ]);
});

test("does not shift AniSkip timestamps for a clearly mismatched runtime", () => {
  const payload = {
    found: true,
    results: [
      { skipType: "recap", episodeLength: 1440, interval: { startTime: 0, endTime: 45 } },
    ],
  };

  assert.deepEqual(normalizeAniSkipResponse(payload, 3600), [
    { type: "recap", start: 0, end: 45, provider: "aniskip" },
  ]);
});

test("normalizes TheIntroDB millisecond ranges and caps open credits at duration", () => {
  const payload = {
    recap: [{ start_ms: 0, end_ms: 42000 }],
    intro: [{ start_ms: 65000, end_ms: 148500 }],
    credits: [{ start_ms: 2500000, end_ms: null }],
  };

  assert.deepEqual(normalizeTheIntroDBResponse(payload, 2700), [
    { type: "recap", start: 0, end: 42, provider: "theintrodb" },
    { type: "intro", start: 65, end: 148.5, provider: "theintrodb" },
    { type: "credits", start: 2500, end: 2700, provider: "theintrodb" },
  ]);
});

test("builds AniSkip requests with the MAL and absolute episode IDs and caches results", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        found: true,
        results: [
          { skipType: "op", episodeLength: 1420, interval: { startTime: 80, endTime: 170 } },
          { skipType: "ed", episodeLength: 1420, interval: { startTime: 1300, endTime: 1390 } },
        ],
      }),
    };
  };
  const context = {
    kind: "anime",
    malId: 16498,
    season: 1,
    episode: 1,
    absoluteEpisode: 4,
    durationSeconds: 1420,
  };

  const first = await getSkipSegments(context, { fetchImpl });
  const second = await getSkipSegments(context, { fetchImpl });

  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.match(url.pathname, /\/16498\/4$/);
  assert.deepEqual(url.searchParams.getAll("types"), ["op", "ed", "recap"]);
  assert.equal(url.searchParams.get("episodeLength"), "1420");
  assert.deepEqual(second, first);
});

test("retries AniSkip without a duration when its matched-runtime lookup fails", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const episodeLength = new URL(url).searchParams.get("episodeLength");
    if (episodeLength !== "0") {
      return { ok: false, status: 500 };
    }
    return {
      ok: true,
      json: async () => ({
        found: true,
        results: [
          { skipType: "op", episodeLength: 1560, interval: { startTime: 3, endTime: 93 } },
          { skipType: "ed", episodeLength: 1560, interval: { startTime: 1460, endTime: 1560 } },
        ],
      }),
    };
  };

  const segments = await getSkipSegments({
    kind: "anime",
    malId: 52991,
    episode: 1,
    durationSeconds: 1560,
  }, { fetchImpl });

  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[0]).searchParams.get("episodeLength"), "1560");
  assert.equal(new URL(urls[1]).searchParams.get("episodeLength"), "0");
  assert.deepEqual(segments.map(({ type }) => type), ["intro", "credits"]);
});

test("fills a missing standard opening from AniSkip's separate mixed filters", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    const mixed = parsed.searchParams.getAll("types").includes("mixed-op");
    return {
      ok: true,
      json: async () => ({
        found: true,
        results: mixed
          ? [{ skipType: "mixed-op", episodeLength: 1470, interval: { startTime: 58, endTime: 148 } }]
          : [{ skipType: "ed", episodeLength: 1470, interval: { startTime: 1370, endTime: 1460 } }],
      }),
    };
  };

  const segments = await getSkipSegments({
    kind: "anime",
    malId: 52991,
    episode: 1,
    durationSeconds: 1470,
  }, { fetchImpl });

  assert.equal(urls.length, 2);
  assert.deepEqual(urls[1].searchParams.getAll("types"), ["mixed-op", "mixed-ed"]);
  assert.deepEqual(segments.map(({ type }) => type), ["intro", "credits"]);
});

test("uses season-local episode numbers for TheIntroDB", async () => {
  let requestedUrl = "";
  const fetchImpl = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({ intro: [{ start_ms: 60000, end_ms: 120000 }] }),
    };
  };

  await getSkipSegments({
    kind: "tv",
    tmdbId: 1396,
    season: 2,
    episode: 1,
    absoluteEpisode: 8,
    durationSeconds: 2800,
  }, { fetchImpl });

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("tmdb_id"), "1396");
  assert.equal(url.searchParams.get("season"), "2");
  assert.equal(url.searchParams.get("episode"), "1");
  assert.equal(url.searchParams.get("duration_ms"), "2800000");
});

test("fails silently when a provider is unavailable", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await getSkipSegments({
      kind: "tv",
      imdbId: "tt0903747",
      season: 1,
      episode: 1,
      durationSeconds: 2800,
    }, {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.deepEqual(result, []);
  } finally {
    console.warn = originalWarn;
  }
});
