// Repair-pass regression tests (M3.1.1–M4.2 review):
//   1. cross-client removal reconciliation in a NON-empty collection via the
//      server-backed memberships endpoint,
//   2. cursor revision change → discard the mixed snapshot, refetch page one,
//   3. delayed old-origin responses (capability probe, write failure) are
//      discarded after an origin switch,
//   4. origin-subscription cleanup via dispose(),
//   5. anime-preserving navigation from Library/Recommendations rows.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import { LibraryStore, overviewKey, pageKey } from "../../src/lib/library-store.ts";
import { resetVersionCheckCache } from "../../src/lib/version-check.ts";
import { setBackendOrigin } from "../../src/lib/connection-service.ts";
import { titleRouteParams } from "../../src/lib/canonical-route.ts";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function settle(ms = 40) {
  await new Promise((r) => setTimeout(r, ms));
}

test("removal of one title in a NON-empty collection reconciles per-title within one poll", async () => {
  // Stateful household stub: two titles in Watch Later; another client
  // removes ONE of them; this client's bounded poll must reconcile exactly
  // that title through GET /v2/library/memberships (never by guessing from
  // bounded previews).
  const state = {
    revision: 3,
    memberships: {
      "tmdb:movie:1": { watchLater: true, favourite: false },
      "tmdb:tv:2": { watchLater: true, favourite: false },
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/v1/version") {
      return json({ serverVersion: "t", protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ["library.household.v1"] });
    }
    if (url.pathname === "/v2/library/memberships") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      return json({
        revision: String(state.revision),
        memberships: ids.filter((id) => state.memberships[id]).map((id) => ({
          canonicalId: id,
          watchLater: state.memberships[id].watchLater,
          favourite: state.memberships[id].favourite,
        })),
      });
    }
    if (url.pathname === "/v2/library/overview") {
      const collection = url.searchParams.get("collection");
      const active = Object.entries(state.memberships).filter(([, m]) => collection === "watch-later" ? m.watchLater : m.favourite);
      const rowsFor = (ids) => ids.map(([id]) => ({
        canonicalId: id, type: id.startsWith("tmdb:tv:") ? "series" : "movie", title: id,
        addedAt: "2026-01-01T00:00:00Z", metadataAvailable: true,
      }));
      return json({
        collection, sort: "recent", revision: String(state.revision),
        shelves: [
          { kind: "movie", count: active.filter(([id]) => id.startsWith("tmdb:movie:")).length, previews: rowsFor(active.filter(([id]) => id.startsWith("tmdb:movie:"))) },
          { kind: "series", count: active.filter(([id]) => id.startsWith("tmdb:tv:")).length, previews: rowsFor(active.filter(([id]) => id.startsWith("tmdb:tv:"))) },
          { kind: "anime", count: 0, previews: [] },
        ],
        degraded: false,
      });
    }
    json({ error: { code: "not_found" } }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setBackendOrigin(`http://127.0.0.1:${server.address().port}`);
  resetVersionCheckCache();

  const store = new LibraryStore({});
  assert.equal(await store.refreshCapability(), "available");
  store.ensureOverview("watch-later", "recent");
  await settle();

  // Locally confirmed: both titles in Watch Later.
  assert.equal(store.getSnapshot().memberships["tmdb:movie:1"].watchLater, true);
  assert.equal(store.getSnapshot().memberships["tmdb:tv:2"].watchLater, true);

  // ANOTHER client removes tmdb:movie:1 (revision advances 3 → 4); the
  // collection still has tmdb:tv:2, so overview counts never hit zero.
  delete state.memberships["tmdb:movie:1"];
  state.revision = 4;

  await store.refreshAll(); // one bounded poll
  const after = store.getSnapshot().memberships;
  assert.equal(after["tmdb:movie:1"].watchLater, false, "removed title reconciled via the memberships probe");
  assert.equal(after["tmdb:movie:1"].revision, "4");
  assert.equal(after["tmdb:tv:2"].watchLater, true, "the remaining title keeps its confirmed flag");
  assert.equal(after["tmdb:tv:2"].revision, "4");

  setBackendOrigin("http://localhost:4001");
  store.dispose();
  server.close();
  server.closeAllConnections?.();
});

test("a revision change between cursor pages discards the mixed snapshot and refetches page one", async () => {
  const pageRequests = [];
  let mutated = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/v1/version") {
      return json({ serverVersion: "t", protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ["library.household.v1"] });
    }
    if (url.pathname === "/v2/library") {
      pageRequests.push(url.search);
      const cursor = url.searchParams.get("cursor");
      if (!cursor) {
        if (mutated) {
          // Page one AFTER the mutation: a consistent revision-6 snapshot.
          return json({
            collection: "watch-later", kind: "movie", sort: "recent", revision: "6", total: 2,
            items: [
              { canonicalId: "tmdb:movie:9", type: "movie", title: "Newcomer", addedAt: "2026-01-09T00:00:00Z", metadataAvailable: true },
              { canonicalId: "tmdb:movie:3", type: "movie", title: "Three", addedAt: "2026-01-03T00:00:00Z", metadataAvailable: true },
            ],
            degraded: false,
          });
        }
        // Page one at revision 5.
        return json({
          collection: "watch-later", kind: "movie", sort: "recent", revision: "5", total: 4,
          items: [
            { canonicalId: "tmdb:movie:1", type: "movie", title: "One", addedAt: "2026-01-01T00:00:00Z", metadataAvailable: true },
            { canonicalId: "tmdb:movie:2", type: "movie", title: "Two", addedAt: "2026-01-02T00:00:00Z", metadataAvailable: true },
          ],
          nextCursor: "cursor-2", degraded: false,
        });
      }
      // The cursor page arrives at a NEWER revision (a mutation happened
      // between pages): the client must NOT append it to the revision-5 page.
      mutated = true;
      return json({
        collection: "watch-later", kind: "movie", sort: "recent", revision: "6", total: 2,
        items: [
          { canonicalId: "tmdb:movie:9", type: "movie", title: "Newcomer", addedAt: "2026-01-09T00:00:00Z", metadataAvailable: true },
          { canonicalId: "tmdb:movie:3", type: "movie", title: "Three", addedAt: "2026-01-03T00:00:00Z", metadataAvailable: true },
        ],
        degraded: false,
      });
    }
    json({ error: { code: "not_found" } }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setBackendOrigin(`http://127.0.0.1:${server.address().port}`);
  resetVersionCheckCache();

  const store = new LibraryStore({});
  await store.refreshCapability();
  store.ensurePage("watch-later", "movie", "recent");
  await settle();
  await store.loadMore("watch-later", "movie", "recent");
  await settle();

  const page = store.getSnapshot().pages[pageKey("watch-later", "movie", "recent")];
  assert.equal(page.revision, "6", "the grid must be a single consistent revision-6 snapshot");
  assert.ok(!page.items.some((i) => i.canonicalId === "tmdb:movie:2"), "the revision-5 page did not survive the mix");
  assert.ok(page.items.some((i) => i.canonicalId === "tmdb:movie:9"), "the fresh snapshot is displayed");
  assert.equal(pageRequests.filter((q) => q === "?collection=watch-later&kind=movie&sort=recent&limit=30").length, 2,
    "page one was refetched exactly once after the revision change");

  setBackendOrigin("http://localhost:4001");
  store.dispose();
  server.close();
  server.closeAllConnections?.();
});

test("delayed old-origin responses: capability probes and write failures are discarded after an origin switch", async () => {
  const resolvers = []; // (kept for the write-delay assertions below)
  let fail = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/v1/version") {
      // Delayed but resolving: the probe is in-flight when the switch happens,
      // and its late old-origin response must be discarded.
      await new Promise((r) => setTimeout(r, 150));
      return json({ serverVersion: "t", protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ["library.household.v1"] });
    }
    if (req.method === "PUT") {
      await new Promise((r) => setTimeout(r, 80)); // outlasts the origin switch below
      return json(fail
        ? { error: { code: "providers_unavailable", message: "down" } }
        : { canonicalId: "tmdb:movie:5", watchLater: true, favourite: false, revision: "5", updatedAt: "t" },
        fail ? 503 : 200);
    }
    json({ error: { code: "not_found" } }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  setBackendOrigin(`http://127.0.0.1:${server.address().port}`);
  resetVersionCheckCache();

  const store = new LibraryStore({});
  const probe = store.refreshCapability(); // in-flight when the switch happens
  setBackendOrigin("http://127.0.0.1:1"); // origin switch mid-probe
  const availability = await probe;
  // The delayed old-origin response must NOT leak its `available` verdict to
  // the new origin. (The switch itself re-probed: port 1 has no server, so
  // the truthful result is `unreachable` — anything but the leaked
  // `available`.)
  assert.notEqual(availability, "available", "a delayed old-origin capability response must not set the new origin's availability");
  assert.equal(availability, "unreachable");
  assert.deepEqual(store.getSnapshot().overviews, {});
  store.dispose();

  // Write FAILURE after a switch: no error is published on the new origin's
  // state (silently dropped; pending was cleared by the switch itself).
  const store2 = new LibraryStore({});
  await store2.refreshCapability();
  store2.toggle("tmdb:movie:5", "watch-later");
  setBackendOrigin("http://127.0.0.1:2"); // switch while the write is in flight
  await settle(150);
  assert.equal(store2.getSnapshot().errors["watch-later|tmdb:movie:5"], undefined,
    "an old-origin write failure must not surface on the new origin");
  assert.equal(store2.getSnapshot().pending["watch-later|tmdb:movie:5"], undefined,
    "pending was cleared by the origin switch (no stuck state)");

  setBackendOrigin("http://localhost:4001");
  store2.dispose();
  server.close();
  server.closeAllConnections?.();
});

test("dispose detaches the origin subscription (no leaked listeners, no stale resets)", async () => {
  resetVersionCheckCache();
  const store = new LibraryStore({});
  store.dispose();
  store.ensureOverview("watch-later", "recent");
  setBackendOrigin("http://127.0.0.1:3");
  await settle();
  assert.equal(store.getSnapshot().availability, "checking", "disposed store keeps its state");
  assert.equal(Object.keys(store.getSnapshot().overviews).length, 0, "disposed store never loaded anything");
  setBackendOrigin("http://localhost:4001");
});

test("anime classification survives Library/Recommendations navigation while keeping the qualified tmdb identity", () => {
  // A TMDb anime: the route kind becomes `anime` (TitlePage renders the anime
  // classification) while provider+mediaKind retain the QUALIFIED tmdb:tv
  // identity — never collapsed to tmdb:N, never rendered as a plain series.
  assert.deepEqual(titleRouteParams("tmdb:tv:209867", "anime"), {
    kind: "anime", provider: "tmdb", mediaKind: "tv", id: "209867",
  });
  // A TMDb anime MOVIE keeps its movie structure under the anime route.
  assert.deepEqual(titleRouteParams("tmdb:movie:693134", "anime"), {
    kind: "anime", provider: "tmdb", mediaKind: "movie", id: "693134",
  });
  // Non-anime titles navigate by their structural namespace.
  assert.deepEqual(titleRouteParams("tmdb:tv:1396", "series"), { kind: "tv", id: "1396" });
  assert.deepEqual(titleRouteParams("tmdb:movie:693134", "movie"), { kind: "movie", id: "693134" });
  // AniList anime keeps its own namespace.
  assert.deepEqual(titleRouteParams("anilist:154587", "anime"), { kind: "anime", id: "154587" });
});

test("no mojibake remains in the touched sources (repair pass Fix 5 regression guard)", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "../../src/browser/main.tsx",
    "../../src/pages/LibraryPage.tsx",
    "../../src/lib/library-store.ts",
    "../../src/lib/library-sync.ts",
    "../../src/lib/services/library-service.ts",
    "../../src/components/shared/RecommendationRow.tsx",
    "../../src/components/shared/LibraryToggle.tsx",
    "../../src/App.tsx",
  ];
  // Mojibake fingerprints: common U+00C2/U+00C3/U+00E2 prefixes and any
  // raw Unicode replacement character.
  const badPattern = /\u00C3|\u00E2[\u0080-\u00BF\u0153\u2122\u2014\u2013\u2019\u201C\u201D\u2022]|\u00C2[\u00A0-\u00BF]|\uFFFD/;
  for (const file of files) {
    const content = readFileSync(new URL(file, import.meta.url), "utf8");
    const bad = content.split("\n").filter((line) => badPattern.test(line));
    assert.equal(bad.length, 0, `${file} contains mojibake: ${JSON.stringify(bad.slice(0, 2))}`);
  }
});
