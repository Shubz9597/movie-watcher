// M3.4 library synchronization tests: bounded polling, hidden pause,
// overlap guards, offline stale labeling, no offline write queue, old-server
// probe avoidance, and two-client cross-visibility over real HTTP round
// trips (deterministic stub server, no external dependencies).
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import {
  attachLibrarySync,
  POLL_INTERVAL_MS,
} from "../../src/lib/library-sync.ts";
import { LibraryStore, overviewKey, pageKey } from "../../src/lib/library-store.ts";
import { resetVersionCheckCache } from "../../src/lib/version-check.ts";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fetchStub(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path });
    for (const route of routes) {
      if (route.method === method && path.startsWith(route.prefix)) return route.handler({ path, calls });
    }
    return jsonResponse(404, { error: { code: "not_found" } });
  };
  return { impl, calls };
}

const versionOk = () => jsonResponse(200, { serverVersion: "t", protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ["library.household.v1"] });
const versionOld = () => jsonResponse(200, { serverVersion: "old", protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ["catalog.bff.v2"] });

const overviewBody = () => jsonResponse(200, {
  collection: "watch-later", sort: "recent", revision: "5",
  shelves: [{ kind: "movie", count: 1, previews: [{ canonicalId: "tmdb:movie:1", type: "movie", title: "One", addedAt: "2026-01-01T00:00:00Z", metadataAvailable: true }] }, { kind: "series", count: 0, previews: [] }, { kind: "anime", count: 0, previews: [] }],
  degraded: false,
});

function fakeVisibility(initial = "visible") {
  let state = initial;
  const listeners = new Set();
  return {
    get visibilityState() { return state; },
    set(next) { state = next; listeners.forEach((l) => l()); },
    addEventListener: (type, listener) => { if (type === "visibilitychange") listeners.add(listener); },
    removeEventListener: (type, listener) => { if (type === "visibilitychange") listeners.delete(listener); },
  };
}

function makeStore(routes) {
  resetVersionCheckCache();
  const fetch = fetchStub(routes);
  return { store: new LibraryStore({ fetchImpl: fetch.impl }), calls: fetch.calls, fetch };
}

test("sync polls at most every 15 seconds while visible and pauses while hidden", async () => {
  let now = 1_000_000;
  const doc = fakeVisibility("visible");
  const { store, calls } = makeStore([
    { method: "GET", prefix: "/v1/version", handler: () => versionOk() },
    { method: "GET", prefix: "/v2/library/overview", handler: () => overviewBody() },
  ]);
  await store.refreshCapability();
  store.ensureOverview("watch-later", "recent");
  await new Promise((r) => setTimeout(r, 30));
  const readsBefore = calls.filter((c) => c.path.startsWith("/v2/library/overview")).length;

  const timers = [];
  const sync = attachLibrarySync(store, {
    documentRef: doc,
    setInterval: (fn, ms) => { timers.push(ms); return 1; },
    clearInterval: () => {},
    now: () => now,
  });
  assert.deepEqual(timers, [POLL_INTERVAL_MS], "the interval is exactly the bounded 15s poll");

  sync.tick(now + 1000); // first tick: lastPoll=0 → poll
  await new Promise((r) => setTimeout(r, 30));
  const afterFirst = calls.filter((c) => c.path.startsWith("/v2/library/overview")).length;
  assert.ok(afterFirst > readsBefore, "first tick polls");

  sync.tick(now + 1000 + 1000); // 1s after the last poll: inside the 15s window → skipped
  sync.tick(now + 1000 + POLL_INTERVAL_MS + 1); // beyond the window → polls
  await new Promise((r) => setTimeout(r, 30));
  const afterThird = calls.filter((c) => c.path.startsWith("/v2/library/overview")).length;
  assert.ok(afterThird > afterFirst, "tick beyond the window polls again");

  doc.set("hidden");
  sync.tick(now + 2 * POLL_INTERVAL_MS + 1); // hidden: never polls
  await new Promise((r) => setTimeout(r, 30));
  const hiddenCount = calls.filter((c) => c.path.startsWith("/v2/library/overview")).length;
  doc.set("visible");
  sync.tick(now + 3 * POLL_INTERVAL_MS + 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls.filter((c) => c.path.startsWith("/v2/library/overview")).length > hiddenCount, "visible again resumes polling");
  assert.equal(hiddenCount, afterThird, "hidden ticks issued no requests");
  sync.detach();
});

test("a read failure keeps the loaded snapshot labelled stale; writes never queue", async () => {
  let down = false;
  const { store, calls } = makeStore([
    { method: "GET", prefix: "/v1/version", handler: () => versionOk() },
    { method: "GET", prefix: "/v2/library/overview", handler: () => down ? jsonResponse(0, {}) : overviewBody() },
    {
      method: "PUT", prefix: "/v2/library/",
      handler: () => down ? jsonResponse(503, { error: { code: "providers_unavailable", message: "down" } })
        : jsonResponse(200, { canonicalId: "tmdb:movie:9", watchLater: true, favourite: false, revision: "9", updatedAt: "t" }),
    },
  ]);
  await store.refreshCapability();
  store.ensureOverview("watch-later", "recent");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.getSnapshot().overviews[overviewKey("watch-later", "recent")].stale, undefined);

  down = true;
  await store.loadOverview("watch-later", "recent");
  let state = store.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(state.status, "ready", "the previously loaded snapshot stays on screen");
  assert.equal(state.stale, true, "clearly labelled stale/offline");
  assert.match(state.error, /could not be reached/i);

  // Offline write: fails truthfully; nothing is queued for later.
  store.toggle("tmdb:movie:9", "watch-later");
  await new Promise((r) => setTimeout(r, 30));
  assert.match(store.getSnapshot().errors["watch-later|tmdb:movie:9"], /could not be reached|providers/i);

  down = false;
  await store.loadOverview("watch-later", "recent");
  state = store.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(state.stale, undefined, "reconnect refresh clears the stale label");
  const putCalls = calls.filter((c) => c.method === "PUT").length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.filter((c) => c.method === "PUT").length, putCalls,
    "NO offline write is replayed after reconnect — the user must Retry explicitly");
});

test("an older server is not repeatedly probed by the sync loop", async () => {
  const { store, calls } = makeStore([
    { method: "GET", prefix: "/v1/version", handler: () => versionOld() },
  ]);
  await store.refreshCapability();
  assert.equal(store.getSnapshot().availability, "unavailable");
  const versionCalls = calls.filter((c) => c.path.startsWith("/v1/version")).length;

  const doc = fakeVisibility("visible");
  const sync = attachLibrarySync(store, {
    documentRef: doc,
    setInterval: () => 1,
    clearInterval: () => {},
    now: () => Date.now(),
  });
  for (let i = 0; i < 5; i++) sync.tick(Date.now() + i * POLL_INTERVAL_MS);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.filter((c) => c.path.startsWith("/v1/version")).length, versionCalls,
    "the sync loop never re-probes a server known to lack the capability");
  sync.detach();
});

test("a jitter-early tick schedules a short catch-up instead of waiting a full interval", async () => {
  // Regression: a real timer firing a few ms before the bookkeeping interval
  // elapsed used to DROP the poll until the next full 15s tick (~30s gap),
  // which broke the ≤20s cross-client removal contract in staging.
  let now = 2_000_000;
  const doc = fakeVisibility("visible");
  const { store, calls } = makeStore([
    { method: "GET", prefix: "/v1/version", handler: () => versionOk() },
    { method: "GET", prefix: "/v2/library/overview", handler: () => overviewBody() },
  ]);
  await store.refreshCapability();
  store.ensureOverview("watch-later", "recent");
  await new Promise((r) => setTimeout(r, 30));

  let catchupFn = null;
  let catchupDelay = null;
  const sync = attachLibrarySync(store, {
    documentRef: doc,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { catchupFn = fn; catchupDelay = ms; return 2; },
    clearTimeout: () => { catchupFn = null; },
    now: () => now,
  });

  sync.tick(now); // polls (lastPoll=0) and advances lastPoll to `now`
  await new Promise((r) => setTimeout(r, 30));
  const afterFirst = calls.filter((c) => c.path.startsWith("/v2/library/overview")).length;

  now += POLL_INTERVAL_MS - 5; // jitter: tick lands 5ms before the window opens
  catchupFn = null;
  sync.tick(now);
  assert.equal(calls.filter((c) => c.path.startsWith("/v2/library/overview")).length, afterFirst,
    "the jitter-early tick itself does not poll");
  assert.notEqual(catchupFn, null, "a catch-up is scheduled, not dropped");
  assert.equal(catchupDelay, 5, "the catch-up waits exactly the remaining milliseconds");

  now += 5;
  catchupFn(); // the catch-up fires after the window has opened
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls.filter((c) => c.path.startsWith("/v2/library/overview")).length > afterFirst,
    "the catch-up polls without waiting another full interval");
  sync.detach();
});

test("an overlapping refreshAll is queued and re-run, never silently dropped", async () => {
  // Regression: a poll colliding with an in-flight refresh used to be a no-op
  // and the next opportunity was a full 15s later (effective 30s interval).
  let pending = [];
  const releaseAll = () => { const q = pending; pending = []; for (const r of q) r(); };
  const { store, calls } = makeStore([
    { method: "GET", prefix: "/v1/version", handler: () => versionOk() },
    {
      method: "GET", prefix: "/v2/library/overview",
      handler: () => new Promise((resolve) => { pending.push(() => resolve(overviewBody())); }),
    },
  ]);
  await store.refreshCapability();
  store.ensureOverview("watch-later", "recent");
  await new Promise((r) => setTimeout(r, 30));

  const first = store.refreshAll(); // in flight (handler blocked)
  await new Promise((r) => setTimeout(r, 20));
  const blockedCalls = calls.filter((c) => c.path.startsWith("/v2/library/overview")).length;
  store.refreshAll(); // overlaps: must queue one follow-up pass
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.filter((c) => c.path.startsWith("/v2/library/overview")).length, blockedCalls,
    "the overlapping call waits while the first pass is in flight");

  releaseAll(); // finish the first pass; the queued second pass starts
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.filter((c) => c.path.startsWith("/v2/library/overview")).length > blockedCalls,
    "the queued follow-up pass issues its own reads (poll not lost)");
  releaseAll(); // let the queued pass finish
  await first;
});

test("two clients see each other's changes through bounded polling (both directions)", async () => {
  // A real HTTP server so both store instances share ONE backend, exactly
  // like two devices against one household server.
  let down = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (down) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { code: "providers_unavailable", message: "down" } })); return; }
    if (url.pathname === "/v1/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ serverVersion: "t", protocolVersion: 1, supportedProtocolRange: [1, 1], capabilities: ["library.household.v1"] }));
      return;
    }
    if (url.pathname.startsWith("/v2/library/")) {
      // Minimal contract behavior for cross-visibility: forward to the real
      // backend is unnecessary — emulate the household truth in-process.
      const body = await new Promise((resolve) => { let data = ""; req.on("data", (c) => (data += c)); req.on("end", () => resolve(data ? JSON.parse(data) : null)); });
      if (req.method === "PUT") {
        state.writeLater = body.enabled;
        state.revision = String(Number(state.revision) + 1);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ canonicalId: "tmdb:movie:1", watchLater: state.writeLater, favourite: false, revision: state.revision, updatedAt: "t" }));
        return;
      }
      if (url.pathname === "/v2/library/overview") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          collection: url.searchParams.get("collection"), sort: "recent", revision: state.revision,
          shelves: [{ kind: "movie", count: state.writeLater ? 1 : 0, previews: state.writeLater ? [{ canonicalId: "tmdb:movie:1", type: "movie", title: "One", addedAt: "2026-01-01T00:00:00Z", metadataAvailable: true }] : [] }, { kind: "series", count: 0, previews: [] }, { kind: "anime", count: 0, previews: [] }],
          degraded: false,
        }));
        return;
      }
    }
    res.writeHead(404); res.end("{}");
  });
  const state = { writeLater: false, revision: "0" };
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const { setBackendOrigin } = await import("../../src/lib/connection-service.ts");
  setBackendOrigin(origin);
  resetVersionCheckCache();
  const clientA = new LibraryStore({});
  const clientB = new LibraryStore({});
  assert.equal(await clientA.refreshCapability(), "available");
  await new Promise((r) => setTimeout(r, 20));
  resetVersionCheckCache();
  assert.equal(await clientB.refreshCapability(), "available");

  clientA.ensureOverview("watch-later", "recent");
  clientB.ensureOverview("watch-later", "recent");
  await new Promise((r) => setTimeout(r, 50));

  // Client A writes Watch Later; client B must see it via its bounded poll.
  clientA.toggle("tmdb:movie:1", "watch-later");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(clientA.getSnapshot().memberships["tmdb:movie:1"].watchLater, true);
  const syncB = attachLibrarySync(clientB, { setInterval: () => 1, clearInterval: () => {} });
  syncB.pollNow(); // bounded poll (≤15s in production)
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(clientB.getSnapshot().memberships["tmdb:movie:1"].watchLater, true, "A → B visible after one poll");

  // Direction B → A.
  clientB.toggle("tmdb:movie:1", "watch-later"); // remove
  await new Promise((r) => setTimeout(r, 50));
  const syncA = attachLibrarySync(clientA, { setInterval: () => 1, clearInterval: () => {} });
  syncA.pollNow();
  await new Promise((r) => setTimeout(r, 60));
  assert.notEqual(clientA.getSnapshot().memberships["tmdb:movie:1"], undefined);
  assert.equal(clientA.getSnapshot().memberships["tmdb:movie:1"].watchLater, false, "B → A visible after one poll");

  // Client recreation: a brand-new store sees the same server truth — the
  // collection is empty (the removal is server state, not client-local).
  resetVersionCheckCache();
  const clientC = new LibraryStore({});
  await clientC.refreshCapability();
  clientC.ensureOverview("watch-later", "recent");
  await new Promise((r) => setTimeout(r, 60));
  const cOverview = clientC.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(cOverview.status, "ready");
  assert.equal(cOverview.shelves.reduce((sum, shelf) => sum + shelf.count, 0), 0,
    "recreated client reads the removal as server truth");
  assert.notEqual(clientC.getSnapshot().memberships["tmdb:movie:1"]?.watchLater, true,
    "no client-local membership survives that the server did not confirm");

  // Origin switch: old-origin responses must not alter the new origin's state.
  setBackendOrigin("http://127.0.0.1:1");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(clientA.getSnapshot().overviews, {}, "origin-scoped caches cleared on switch");

  syncA.detach();
  syncB.detach();
  setBackendOrigin("http://localhost:4001");
  server.close();
  server.closeAllConnections?.();
});
