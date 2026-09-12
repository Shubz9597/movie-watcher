// Live M3.3 verification: the REAL LibraryStore (client) against the REAL
// M3.2 HTTP implementation backed by disposable PostgreSQL and a
// deterministic TMDb provider stub. Live provider credentials are NOT used
// — the boundary is documented in the evidence report.
import assert from "node:assert/strict";
import test from "node:test";

const SERVER = "http://127.0.0.1:54333";

const { setBackendOrigin } = await import("../../electron-app/src/lib/connection-service.ts");
setBackendOrigin(SERVER); // import.meta.env does not exist in node: set the origin explicitly

const { LibraryStore, overviewKey, pageKey } = await import("../../electron-app/src/lib/library-store.ts");

async function settle(times = 6) {
  // Real-network settle: enough wall time for localhost request round-trips.
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 25));
}

// Real network needs real waits: poll until predicate or deadline.
async function waitFor(predicate, timeoutMs = 15000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitForServer(deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${SERVER}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become healthy");
}

test("real server: capability, reads, writes, pagination, sort, identity, origin switch", async (t) => {
  await waitForServer();
  const store = new LibraryStore({});
  assert.equal(await store.refreshCapability(), "available", "the real server advertises library.household.v1");

  // Empty overview straight after migration.
  store.ensureOverview("watch-later", "recent");
  await waitFor(() => store.getSnapshot().overviews[overviewKey("watch-later", "recent")]?.status === "ready", 15000, "empty overview");
  const empty = store.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(empty.status, "ready");
  assert.equal(empty.revision, "0");
  assert.deepEqual(empty.shelves.map((s) => s.count), [0, 0, 0]);

  // Watch Later add → remove; Favourite add; independent flags reconciled
  // from the complete server responses.
  store.toggle("tmdb:movie:693134", "watch-later");
  await settle();
  let m = store.getSnapshot().memberships["tmdb:movie:693134"];
  assert.equal(m.watchLater, true);
  assert.equal(m.favourite, false);
  assert.equal(m.revision, "1");

  store.toggle("tmdb:movie:693134", "favourites");
  await settle();
  m = store.getSnapshot().memberships["tmdb:movie:693134"];
  assert.equal(m.watchLater, true, "watch-later untouched by the favourite write");
  assert.equal(m.favourite, true);
  assert.equal(m.revision, "2");

  store.toggle("tmdb:movie:693134", "watch-later"); // remove
  await settle();
  m = store.getSnapshot().memberships["tmdb:movie:693134"];
  assert.equal(m.watchLater, false);
  assert.equal(m.favourite, true, "favourite survived the watch-later removal");
  assert.equal(m.revision, "3");

  // Re-add for later pagination checks.
  store.toggle("tmdb:movie:693134", "watch-later");
  await settle();

  // Qualified same-number movie/TV independence against the live API.
  store.toggle("tmdb:movie:123", "watch-later");
  store.toggle("tmdb:tv:123", "watch-later");
  await settle();
  assert.notEqual(
    store.getSnapshot().memberships["tmdb:movie:123"].revision,
    store.getSnapshot().memberships["tmdb:tv:123"].revision,
    "two independent memberships, two revisions",
  );
  assert.equal(store.getSnapshot().memberships["tmdb:movie:123"].watchLater, true);
  assert.equal(store.getSnapshot().memberships["tmdb:tv:123"].watchLater, true);

  // Unqualified legacy alias is rejected with the documented 400.
  store.toggle("tmdb:999", "watch-later");
  await settle();
  const rejectedKey = "watch-later|tmdb:999";
  assert.match(store.getSnapshot().errors[rejectedKey] ?? "", /canonical media-qualified/i,
    "the alias rejection surfaces as a truthful error");

  // Unavailable metadata: create a membership, make the provider lose the
  // title (stub control endpoint), re-write, and verify the read path keeps
  // the entry with metadataAvailable=false and the stored snapshot title.
  store.toggle("tmdb:movie:99", "watch-later");
  await settle();
  assert.equal(store.getSnapshot().memberships["tmdb:movie:99"].watchLater, true);
  await fetch(`${SERVER.replace(":54333", ":54334")}/stub/vanish/99`);
  // Off→on cycle: each effective write attempts the metadata refresh; the
  // resolver can no longer resolve the title, so the stored snapshot is
  // kept and the entry is labelled metadata-unavailable.
  store.toggle("tmdb:movie:99", "watch-later");
  await settle();
  store.toggle("tmdb:movie:99", "watch-later");
  await settle();
  store.ensurePage("watch-later", "movie", "recent");
  await settle();
  let checkPage = store.getSnapshot().pages[pageKey("watch-later", "movie", "recent")];
  let vanishedRow = checkPage.items.find((i) => i.canonicalId === "tmdb:movie:99");
  let guard2 = 0;
  while (!vanishedRow && checkPage.cursor && guard2++ < 10) {
    await store.loadMore("watch-later", "movie", "recent");
    await settle();
    checkPage = store.getSnapshot().pages[pageKey("watch-later", "movie", "recent")];
    vanishedRow = checkPage.items.find((i) => i.canonicalId === "tmdb:movie:99");
  }
  assert.ok(vanishedRow, "the metadata-unavailable entry is retained in its collection");
  assert.equal(vanishedRow.metadataAvailable, false, "the entry is labelled metadata-unavailable");
  assert.equal(vanishedRow.title, "Stub Movie 99", "the stored snapshot title renders");

  // 105 more entries → cursor pagination beyond one page.
  for (let i = 0; i < 105; i++) {
    store.toggle(`tmdb:movie:${10000 + i}`, "watch-later");
    if (i % 20 === 0) await settle();
  }
  await settle(20);
  const putCount = store.getSnapshot().memberships;
  assert.ok(Object.keys(putCount).length >= 108, `expected 108+ memberships, got ${Object.keys(putCount).length}`);

  store.ensurePage("watch-later", "movie", "recent");
  await settle();
  let page = store.getSnapshot().pages[pageKey("watch-later", "movie", "recent")];
  assert.equal(page.status, "ready");
  const total = page.total;
  assert.ok(total >= 108, `full-scope total ${total} covers every page`);
  assert.equal(page.items.length, 30, "server default limit 30");
  assert.ok(page.cursor, "more pages exist");
  let seen = new Set(page.items.map((i) => i.canonicalId));
  let guard = 0;
  while (page.cursor && guard++ < 10) {
    await store.loadMore("watch-later", "movie", "recent");
    await settle();
    page = store.getSnapshot().pages[pageKey("watch-later", "movie", "recent")];
    for (const item of page.items) seen.add(item.canonicalId);
  }
  assert.equal(seen.size, page.items.length, "no duplicates across pages");
  assert.equal(page.items.length, total, `cursor pagination reached the full scope (${page.items.length}/${total})`);

  // Sort change: Title A–Z is a different resource with its own order.
  store.ensurePage("watch-later", "movie", "title");
  await settle();
  const byTitle = store.getSnapshot().pages[pageKey("watch-later", "movie", "title")];
  assert.equal(byTitle.status, "ready");
  const titles = byTitle.items.map((i) => i.title.toLowerCase());
  assert.ok(titles[0] <= titles[1], `title sort ascending (${titles[0]} <= ${titles[1]})`);

  // Post-mutation invalidation: the overview refetches fresh counts.
  store.ensureOverview("watch-later", "recent");
  await waitFor(() => store.getSnapshot().overviews[overviewKey("watch-later", "recent")]?.status === "ready", 15000, "empty overview");
  const populated = store.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(populated.status, "ready");
  const movieShelf = populated.shelves.find((s) => s.kind === "movie");
  assert.equal(movieShelf.count, total, "overview count equals the full-scope grid total");
  assert.ok(movieShelf.previews.length <= 6, "previews stay bounded while counts stay full-scope");

  // Origin switch: state cleared and capability re-checked on the new origin.
  setBackendOrigin(SERVER === "http://127.0.0.1:54333" ? "http://127.0.0.1:54333/" : SERVER); // same origin, normalized — no-op guard
  setBackendOrigin("http://127.0.0.1:54333"); // explicit re-set of the identical origin is a no-op
  // A real switch to a DIFFERENT origin clears state; switch back to recheck.
  setBackendOrigin("http://127.0.0.1:59999");
  await settle(10);
  assert.deepEqual(store.getSnapshot().overviews, {}, "origin-scoped caches cleared on switch");
  assert.deepEqual(store.getSnapshot().memberships, {}, "origin-scoped memberships cleared on switch");
  assert.equal(store.getSnapshot().availability, "unreachable", "the new origin has no server");
});
