// Offline-download subtitles: the job request carries the chosen language
// and sanitized catalog hints only when the server can package sidecars.
import assert from "node:assert/strict";
import test from "node:test";

const { downloadJobRequest } = await import("../../src/mobile/download-queue.ts");

const selection = {
  seriesId: "tmdb:movie:693134",
  sourceId: "opaque-source",
  sourceKind: "movie",
  season: 0,
  episode: 0,
  title: "Dune: Part Two",
  subtitles: ["en"],
  subtitleHints: { title: "Dune: Part Two\n", year: 2024, imdbId: "tt15239678" },
};

test("subtitle request includes language and sanitized hints when supported", () => {
  const body = downloadJobRequest(selection, ["downloads.offline.v1", "downloads.subtitles.v1"], "device-1", "attempt-1");
  assert.deepEqual(body.subtitles, ["en"]);
  assert.deepEqual(body.subtitleHints, { title: "Dune: Part Two", year: 2024, imdbId: "tt15239678" });
  assert.equal(body.idempotencyKey, "attempt-1");
});

test("malformed hints are dropped instead of failing the download", () => {
  const body = downloadJobRequest(
    { ...selection, subtitleHints: { title: "x".repeat(400), year: 12, imdbId: "15239678" } },
    ["downloads.subtitles.v1"], "device-1", "attempt-2",
  );
  assert.equal(body.subtitleHints.title.length, 300);
  assert.equal(body.subtitleHints.year, undefined);
  assert.equal(body.subtitleHints.imdbId, undefined);
});

test("no subtitles: the request omits subtitle fields entirely", () => {
  const body = downloadJobRequest({ ...selection, subtitles: [] }, ["downloads.offline.v1"], "device-1", "attempt-3");
  assert.equal("subtitles" in body, false);
  assert.equal("subtitleHints" in body, false);
});

test("requesting subtitles from an older server is an explicit error", () => {
  assert.throws(
    () => downloadJobRequest(selection, ["downloads.offline.v1"], "device-1", "attempt-4"),
    /need a server update/,
  );
});
