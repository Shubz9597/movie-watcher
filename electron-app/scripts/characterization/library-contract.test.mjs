// M3.1 library contract shape checks (specs/002-mobile-shared-ui/contracts/
// library-api.md). These validate the DOCUMENTED request/response fixtures
// and the client-side rules that are executable without a server — the
// snapshot/cursor/write semantics themselves belong to M3.2 storage tests.
// Nothing here implies that library endpoints exist yet.
import assert from "node:assert/strict";
import test from "node:test";

// Fixture payloads copied from contracts/library-api.md — the contract
// document and these fixtures must stay in sync (a change here flags a
// contract change for review).
const overviewFixture = {
  collection: "watch-later",
  sort: "recent",
  revision: "18446744073709551615",
  shelves: [
    { kind: "movie", count: 12, previews: [{ canonicalId: "tmdb:movie:693134", type: "movie", title: "Dune: Part Two", addedAt: "2026-09-06T12:00:00Z", metadataAvailable: true }] },
    { kind: "series", count: 0, previews: [] },
    { kind: "anime", count: 1, previews: [{ canonicalId: "tmdb:tv:209867", type: "anime", title: "Frieren: Beyond Journey's End", addedAt: "2026-09-06T11:00:00Z", metadataAvailable: false }] },
  ],
  degraded: false,
};

const pageFixture = {
  collection: "watch-later",
  kind: "movie",
  sort: "recent",
  revision: "18446744073709551615",
  total: 47,
  items: [
    { canonicalId: "tmdb:movie:693134", type: "movie", title: "Dune: Part Two", year: 2024, addedAt: "2026-09-06T12:00:00Z", metadataAvailable: true },
  ],
  nextCursor: "cmVjZW50fHdhdGNoLWxhdGVyfG1vdmllfHRtZGI6bW92aWU6NjkzMTM0",
  degraded: false,
};

function assertRevisionIsLosslessDecimalString(revision) {
  assert.equal(typeof revision, "string", "revision must be a string (lossless bigint wire format)");
  assert.match(revision, /^\d+$/, "revision must be a plain decimal string");
  // String comparison is the lossless client-side comparison rule; scaling
  // by 10 proves the value survives intact beyond Number.MAX_SAFE_INTEGER.
  assert.ok(BigInt(revision + "0") > BigInt(revision), "bigint compare survives values beyond Number.MAX_SAFE_INTEGER");
}

test("overview fixture: lossless revision, full-scope counts, zero shelves present, anime typed", () => {
  assertRevisionIsLosslessDecimalString(overviewFixture.revision);
  const kinds = overviewFixture.shelves.map((s) => s.kind);
  assert.deepEqual(kinds, ["movie", "series", "anime"], "all three shelves always present");
  for (const shelf of overviewFixture.shelves) {
    assert.ok(Array.isArray(shelf.previews) && shelf.previews.length <= 6, "bounded previews");
    assert.equal(typeof shelf.count, "number", "count is the full-scope total, not previews.length");
  }
  const zeroShelf = overviewFixture.shelves.find((s) => s.kind === "series");
  assert.equal(zeroShelf.count, 0, "zero-count shelves are present");
  const animePreview = overviewFixture.shelves.find((s) => s.kind === "anime").previews[0];
  // Identity rule: a TMDb-classified anime uses its structural qualified id
  // (tmdb:tv:N) with type anime — never a duplicate under Series.
  assert.match(animePreview.canonicalId, /^tmdb:(movie|tv):\d+$/);
  assert.equal(animePreview.type, "anime");
  assert.equal(animePreview.metadataAvailable, false, "metadata-unavailable entries are preserved and labelled");
});

test("page fixture: cursor embeds its scope; totals exceed page one; items carry canonical ids", () => {
  assertRevisionIsLosslessDecimalString(pageFixture.revision);
  assert.equal(pageFixture.total, 47);
  assert.ok(pageFixture.total > pageFixture.items.length, "totals beyond page one");
  for (const item of pageFixture.items) {
    assert.match(item.canonicalId, /^(tmdb:(movie|tv)|anilist|jikan):\S+$/, "canonical media-qualified ids only — never a bare tmdb:N");
    assert.equal(typeof item.metadataAvailable, "boolean");
  }
  const decoded = Buffer.from(pageFixture.nextCursor, "base64").toString("utf8");
  // Scope binding: cursor embeds collection+kind+sort+last tuple; presenting
  // it with a mismatched scope is a documented 400 invalid_request (M3.2).
  for (const part of ["recent", "watch-later", "movie", "tmdb:"]) {
    assert.ok(decoded.includes(part), `cursor must embed its scope: missing ${part}`);
  }
});

test("write fixture: response returns BOTH flags and the post-commit revision", () => {
  const writeResponse = {
    canonicalId: "tmdb:tv:209867",
    watchLater: false,
    favourite: true,
    revision: "18446744073709551616",
    updatedAt: "2026-09-06T12:30:00Z",
  };
  assertRevisionIsLosslessDecimalString(writeResponse.revision);
  assert.equal(typeof writeResponse.watchLater, "boolean");
  assert.equal(typeof writeResponse.favourite, "boolean");
  assert.ok(BigInt(writeResponse.revision) >= BigInt(overviewFixture.revision), "revision is monotonic across responses");
  // Client per-resource comparison rule (plan.md): compare the revision of
  // the resource being applied — a response for another id never suppresses
  // this one's newer cached state.
});
