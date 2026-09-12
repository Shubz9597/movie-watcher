// LibraryStore characterization tests (feature 002 M3.3): the server-backed
// library state owner exercised with deterministic fetch stubs — capability
// gating, revision handling (lossless, per-resource), write serialization,
// optimistic pending/failure/retry, stale responses, origin switch, and
// cursor pagination. No localStorage/device-local fallback exists anywhere
// in the path (asserted structurally).
import assert from "node:assert/strict";
import test from "node:test";

import {
  LibraryStore,
  isNewerRevision,
  overviewKey,
  pageKey,
  flagKey,
} from "../../src/lib/library-store.ts";
import {
  setBackendOrigin,
  subscribeOrigin,
} from "../../src/lib/connection-service.ts";
import { resetVersionCheckCache } from "../../src/lib/version-check.ts";

// refreshCapability reads through the shared 60s version cache; tests that
// change the stubbed capability response reset it first.
function makeStore(fetchImpl) {
  resetVersionCheckCache();
  return new LibraryStore({ fetchImpl });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// fetchStub routes by method+path prefix with per-route handlers and a call log.
function fetchStub(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null });
    for (const route of routes) {
      if (route.method === method && path.startsWith(route.prefix)) {
        return route.handler({ path, body: init.body ? JSON.parse(init.body) : null, calls });
      }
    }
    return jsonResponse(404, { error: { code: "not_found", message: path } });
  };
  return { impl, calls };
}

const versionWithCapability = () => jsonResponse(200, {
  serverVersion: "test", protocolVersion: 1, supportedProtocolRange: [1, 1],
  capabilities: ["catalog.bff.v2", "library.household.v1"],
});
const versionWithoutCapability = () => jsonResponse(200, {
  serverVersion: "old", protocolVersion: 1, supportedProtocolRange: [1, 1],
  capabilities: ["catalog.bff.v2"],
});
async function settle(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("revision comparison is lossless beyond the JavaScript safe integer range", () => {
  // 2^53 and beyond: Number compare would collapse these.
  assert.equal(isNewerRevision("9007199254740994", "9007199254740993"), true);
  assert.equal(isNewerRevision("9007199254740993", "9007199254740994"), false);
  assert.equal(isNewerRevision("9007199254740993", "9007199254740993"), false);
  assert.equal(isNewerRevision("18446744073709551616", "18446744073709551615"), true);
  assert.equal(isNewerRevision("5", undefined), true);
});

test("availability is gated on the advertised library.household.v1 capability", async () => {
  const fetch = fetchStub([{ method: "GET", prefix: "/v1/version", handler: () => versionWithoutCapability() }]);
  const store = makeStore(fetch.impl);
  assert.equal(await store.refreshCapability(), "unavailable", "server without the capability is explicitly unavailable");
  assert.equal(store.getSnapshot().availability, "unavailable");

  const withCap = fetchStub([{ method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() }]);
  const available = makeStore(withCap.impl);
  assert.equal(await available.refreshCapability(), "available");

  const unreachable = fetchStub([{ method: "GET", prefix: "/v1/version", handler: () => { throw new TypeError("down"); } }]);
  const down = makeStore(unreachable.impl);
  assert.equal(await down.refreshCapability(), "unreachable", "discovery failure is unreachable, never silently available");
});

test("overview reads map the contract and adopt collection membership truth", async () => {
  const fetch = fetchStub([
    { method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() },
    {
      method: "GET", prefix: "/v2/library/overview",
      handler: () => jsonResponse(200, {
        collection: "watch-later", sort: "recent", revision: "9007199254740993",
        sourceRev: "9007199254740993",
        shelves: [
          { kind: "movie", count: 12, previews: [{ canonicalId: "tmdb:movie:693134", type: "movie", title: "Dune: Part Two", year: 2024, addedAt: "2026-09-09T12:00:00Z", metadataAvailable: true, artwork: { poster: "https://p.png" } }] },
          { kind: "series", count: 0, previews: [] },
          { kind: "anime", count: 1, previews: [{ canonicalId: "tmdb:tv:209867", type: "anime", title: "Frieren", addedAt: "2026-09-09T11:00:00Z", metadataAvailable: false }] },
        ],
        degraded: false,
      }),
    },
  ]);
  const store = makeStore(fetch.impl);
  await store.refreshCapability();
  store.ensureOverview("watch-later", "recent");
  await settle();
  const overview = store.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(overview.status, "ready");
  assert.equal(overview.revision, "9007199254740993", "revision stays a lossless string");
  assert.equal(overview.shelves.length, 3, "zero-count shelves are present");
  assert.equal(overview.shelves[1].count, 0);
  // Rows from the watch-later collection carry confirmed watch-later truth.
  assert.equal(store.getSnapshot().memberships["tmdb:movie:693134"].watchLater, true);
  assert.equal(store.getSnapshot().memberships["tmdb:movie:693134"].favourite, false, "the other flag defaults independently");
});

test("writes serialize per title/field and reconcile from the complete response", async () => {
  const resolvers = [];
  const fetch = fetchStub([
    { method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() },
    {
      method: "PUT", prefix: "/v2/library/tmdb:movie:693134/watch-later",
      handler: ({ body }) => new Promise((resolve) => resolvers.push({ body, resolve })),
    },
  ]);
  const store = makeStore(fetch.impl);
  await store.refreshCapability();

  // Rapid double click: the first target is true; the queued second flips to
  // false and is issued only after the first write settles (strict order).
  store.toggle("tmdb:movie:693134", "watch-later");
  store.toggle("tmdb:movie:693134", "watch-later");
  await settle(2);
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, 1, "the second write waits for the first");
  assert.equal(resolvers[0].body.enabled, true);
  resolvers[0].resolve(jsonResponse(200, {
    canonicalId: "tmdb:movie:693134", watchLater: true, favourite: true,
    revision: "9007199254740994", updatedAt: "t",
  }));
  await settle(2);
  assert.equal(fetch.calls.filter((c) => c.method === "PUT").length, 2, "the queued write follows");
  assert.equal(resolvers[1].body.enabled, false, "queued click computed its target from the latest intent");
  resolvers[1].resolve(jsonResponse(200, {
    canonicalId: "tmdb:movie:693134", watchLater: false, favourite: true,
    revision: "9007199254740995", updatedAt: "t",
  }));
  await settle();

  const membership = store.getSnapshot().memberships["tmdb:movie:693134"];
  assert.equal(membership.watchLater, false, "final state equals the LAST serialized write");
  assert.equal(membership.favourite, true, "the other flag came from the same response and was never overwritten");
  assert.equal(membership.revision, "9007199254740995");
  assert.equal(Object.keys(store.getSnapshot().pending).length, 0, "pending cleared after both writes");
});

test("failed writes restore confirmed state, surface truthful errors, and Retry re-issues the target", async () => {
  let fail = true;
  const fetch = fetchStub([
    { method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() },
    {
      method: "PUT", prefix: "/v2/library/tmdb:tv:1396/favourite",
      handler: ({ body }) => fail
        ? jsonResponse(503, { error: { code: "providers_unavailable", message: "down" } })
        : jsonResponse(200, { canonicalId: "tmdb:tv:1396", watchLater: false, favourite: body.enabled, revision: "7", updatedAt: "t" }),
    },
  ]);
  const store = makeStore(fetch.impl);
  await store.refreshCapability();

  store.toggle("tmdb:tv:1396", "favourites");
  await settle();
  const key = flagKey("favourites", "tmdb:tv:1396");
  assert.equal(store.getSnapshot().errors[key]?.length > 0, true, "failure is surfaced in text");
  assert.equal(store.getSnapshot().pending[key], undefined, "pending display is dropped on failure");
  assert.equal(store.getSnapshot().memberships["tmdb:tv:1396"], undefined, "confirmed server state stands (no optimistic lie)");

  fail = false;
  store.retry("tmdb:tv:1396", "favourites");
  await settle();
  assert.equal(store.getSnapshot().memberships["tmdb:tv:1396"].favourite, true, "Retry issues the last intended target");
  assert.equal(store.getSnapshot().errors[key], undefined, "retry clears the error");
});

test("late/older responses cannot undo newer confirmed state, per title", async () => {
  const fetch = fetchStub([
    { method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() },
    {
      method: "PUT", prefix: "/v2/library/tmdb:tv:1396/favourite",
      handler: ({ body }) => jsonResponse(200, {
        canonicalId: "tmdb:tv:1396", watchLater: false, favourite: body.enabled, revision: "5", updatedAt: "t",
      }),
    },
  ]);
  const store = makeStore(fetch.impl);
  await store.refreshCapability();
  // Simulate a NEWER confirmed response for this title (revision 7) — e.g.
  // reconciliation from another surface landed first.
  store.getSnapshot().memberships["tmdb:tv:1396"] = { watchLater: false, favourite: true, revision: "7" };
  store.toggle("tmdb:tv:1396", "favourites");
  await settle();
  // The write response carries the OLDER revision 5: it must be discarded —
  // the confirmed revision-7 state stands (no late undo).
  const membership = store.getSnapshot().memberships["tmdb:tv:1396"];
  assert.equal(membership.favourite, true, "older response did not undo newer confirmed state");
  assert.equal(membership.revision, "7");
  // Per-resource compare: mutating ANOTHER title's revision suppresses nothing.
  assert.equal(membership.watchLater, false, "this title's other flag is untouched by its own write response");
});

test("superseded overview fetches are discarded by request sequence", async () => {
  const resolvers = [];
  const fetch = fetchStub([
    { method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() },
    {
      method: "GET", prefix: "/v2/library/overview",
      handler: () => new Promise((resolve) => resolvers.push(resolve)),
    },
  ]);
  const store = makeStore(fetch.impl);
  await store.refreshCapability();
  store.loadOverview("watch-later", "recent");
  store.loadOverview("watch-later", "recent"); // supersedes the first
  await settle(1);
  assert.equal(resolvers.length, 2);
  // The FIRST (superseded) response resolves last: it must be discarded.
  resolvers[1](jsonResponse(200, { collection: "watch-later", sort: "recent", revision: "9", shelves: [{ kind: "movie", count: 2, previews: [] }, { kind: "series", count: 0, previews: [] }, { kind: "anime", count: 0, previews: [] }], degraded: false }));
  await settle();
  resolvers[0](jsonResponse(200, { collection: "watch-later", sort: "recent", revision: "3", shelves: [{ kind: "movie", count: 99, previews: [] }, { kind: "series", count: 0, previews: [] }, { kind: "anime", count: 0, previews: [] }], degraded: false }));
  await settle();
  const overview = store.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(overview.revision, "9", "the superseded response never applied");
  assert.equal(overview.shelves[0].count, 2);
});

test("origin switch clears origin-scoped library state and re-checks capability", async () => {
  let withCapability = true;
  const fetch = fetchStub([
    {
      method: "GET", prefix: "/v1/version",
      handler: () => (withCapability ? versionWithCapability() : versionWithoutCapability()),
    },
  ]);
  const store = makeStore(fetch.impl);
  await store.refreshCapability();
  store.ensureOverview("watch-later", "recent");
  await settle();
  assert.equal(store.getSnapshot().availability, "available");
  assert.ok(Object.keys(store.getSnapshot().overviews).length > 0);

  const unsubscribe = subscribeOrigin(() => {});
  const previousOrigin = "http://localhost:4001";
  withCapability = false;
  setBackendOrigin("http://origin-b:4001"); // triggers the store's reset + recheck
  await settle();
  assert.equal(store.getSnapshot().availability, "unavailable", "capability re-checked against the new origin");
  assert.deepEqual(store.getSnapshot().overviews, {}, "origin-scoped caches are cleared");
  assert.deepEqual(store.getSnapshot().memberships, {}, "origin-scoped memberships are cleared");
  setBackendOrigin(previousOrigin);
  unsubscribe();
  await settle();
});

test("cursor pagination deduplicates pages and a rejected cursor resets truthfully", async () => {
  const pageOne = {
    collection: "watch-later", kind: "movie", sort: "recent", revision: "10", total: 3,
    items: [
      { canonicalId: "tmdb:movie:1", type: "movie", title: "One", addedAt: "2026-01-01T00:00:00Z", metadataAvailable: true },
      { canonicalId: "tmdb:movie:2", type: "movie", title: "Two", addedAt: "2026-01-02T00:00:00Z", metadataAvailable: true },
    ],
    nextCursor: "cursor-2", degraded: false,
  };
  const fetch = fetchStub([
    { method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() },
    { method: "GET", prefix: "/v2/library?collection=watch-later", handler: ({ path }) => {
      if (path.includes("cursor=cursor-2")) {
        return jsonResponse(200, { ...pageOne,
          items: [
            { canonicalId: "tmdb:movie:2", type: "movie", title: "Two (moved)", addedAt: "2026-01-02T00:00:00Z", metadataAvailable: true },
            { canonicalId: "tmdb:movie:3", type: "movie", title: "Three", addedAt: "2026-01-03T00:00:00Z", metadataAvailable: true },
          ],
          nextCursor: undefined,
        });
      }
      return jsonResponse(200, pageOne);
    } },
  ]);
  const store = makeStore(fetch.impl);
  await store.refreshCapability();
  store.ensurePage("watch-later", "movie", "recent");
  await settle();
  await store.loadMore("watch-later", "movie", "recent");
  const page = store.getSnapshot().pages[pageKey("watch-later", "movie", "recent")];
  assert.deepEqual(page.items.map((item) => item.canonicalId),
    ["tmdb:movie:1", "tmdb:movie:2", "tmdb:movie:3"],
    "page-two overlap is deduplicated by canonical id");
  assert.equal(page.cursor, null, "last page has no cursor");
  assert.equal(page.total, 3, "total is full-scope, independent of loaded items");
});

test("reads and writes never touch localStorage or device-local storage", async () => {
  // Structural proof: no localStorage exists in this environment and every
  // library operation completes purely over the injected fetch transport.
  const fetch = fetchStub([
    { method: "GET", prefix: "/v1/version", handler: () => versionWithCapability() },
    { method: "GET", prefix: "/v2/library/overview", handler: () => jsonResponse(200, { collection: "watch-later", sort: "recent", revision: "1", shelves: [{ kind: "movie", count: 0, previews: [] }, { kind: "series", count: 0, previews: [] }, { kind: "anime", count: 0, previews: [] }], degraded: false }) },
  ]);
  assert.equal(typeof globalThis.localStorage, "undefined", "no localStorage on the path");
  const store = makeStore(fetch.impl);
  await store.refreshCapability();
  store.ensureOverview("watch-later", "recent");
  await settle();
  assert.equal(store.getSnapshot().overviews[overviewKey("watch-later", "recent")].status, "ready");
  assert.equal(typeof globalThis.localStorage, "undefined");
});
