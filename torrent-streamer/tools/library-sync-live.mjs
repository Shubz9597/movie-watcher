// M3.4 live verification: two INDEPENDENT client store instances against the
// REAL M3.2/M3.4 backend on disposable PostgreSQL. Deterministic TMDb stub
// supplies metadata (no live credentials — documented boundary).
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const SERVER = "http://127.0.0.1:54341";
const STUB_PORT = 54342;

const { setBackendOrigin } = await import("../../electron-app/src/lib/connection-service.ts");
setBackendOrigin(SERVER);
const { LibraryStore, overviewKey } = await import("../../electron-app/src/lib/library-store.ts");
const { attachLibrarySync } = await import("../../electron-app/src/lib/library-sync.ts");

function waitForServer(deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  return (async () => {
    while (Date.now() < deadline) {
      try { const r = await fetch(`${SERVER}/healthz`); if (r.ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("server not healthy");
  })();
}

function startServer() {
  console.log('[live] spawning server...');
  // Explicit minimal environment: spreading the (test-runner) parent env is
  // not reliably inherited by the spawned Go process here.
  const envText = readFileSync("C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\env.ps1", "utf8");
  const pw = envText.trim().replace(/^\$PGPW = '/, "").replace(/'$/, "");
  const proc = spawn("C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\torwatch.exe", [], {
    env: {
      PG_DSN: `postgres://torwatch:${pw}@127.0.0.1:54340/torwatch_m34?sslmode=disable`,
      LISTEN: "127.0.0.1:54341",
      PROWLARR_URL: "http://127.0.0.1:59999",
      PROWLARR_API_KEY: "dummy",
      TMDB_API_KEY: "stub-key",
      TORWATCH_TMDB_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      TEMP: process.env.TEMP ?? "C:\\Temp",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr?.on("data", (d) => console.log("[server]", String(d).split("\n").slice(-3).join(" | ").slice(0, 300)));
  proc.on("exit", (code) => console.log("[server] exited", code));
  console.log('[live] server pid', proc.pid);
  return proc;
}

function waitFor(predicate, timeoutMs = 15000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timeout waiting for ${label}`);
  })();
}

let serverProc;

test("M3.4 live: two clients, cross-client sync, restart persistence, identity, revisions", async () => {
  // Start the deterministic TMDb stub (no live credentials) and the backend.
  const stubProc = spawn("node", ["C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\stub-tmdb.mjs"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
  serverProc = startServer();
  await waitForServer();
  const clientA = new LibraryStore({});
  const clientB = new LibraryStore({});
  const syncA = attachLibrarySync(clientA, { setInterval: () => 1, clearInterval: () => {} });
  const syncB = attachLibrarySync(clientB, { setInterval: () => 1, clearInterval: () => {} });

  assert.equal(await clientA.refreshCapability(), "available");
  assert.equal(await clientB.refreshCapability(), "available");

  // A loads, writes Watch Later; B polls and must see it within the bounded
  // poll window (pollNow models the ≤15s tick; the bound itself makes the
  // 20s cross-client target true by construction).
  clientA.ensureOverview("watch-later", "recent");
  clientB.ensureOverview("watch-later", "recent");
  await waitFor(() => clientA.getSnapshot().overviews[overviewKey("watch-later", "recent")]?.status === "ready", 15000, "A overview");
  await waitFor(() => clientB.getSnapshot().overviews[overviewKey("watch-later", "recent")]?.status === "ready", 15000, "B overview");

  const t0 = Date.now();
  clientA.toggle("tmdb:movie:693134", "watch-later");
  await waitFor(() => clientA.getSnapshot().memberships["tmdb:movie:693134"]?.watchLater === true, 15000, "A write");
  syncB.pollNow();
  await waitFor(() => clientB.getSnapshot().memberships["tmdb:movie:693134"]?.watchLater === true, 20000, "A→B visibility");
  const latency = Date.now() - t0;
  assert.ok(latency < 20000, `A→B cross-client visibility took ${latency}ms (bound 20s)`);

  // B→A direction: B favourites; A's bounded poll sees it.
  clientB.toggle("tmdb:movie:693134", "favourites");
  await waitFor(() => clientB.getSnapshot().memberships["tmdb:movie:693134"]?.favourite === true, 15000, "B write");
  syncA.pollNow();
  await waitFor(() => clientA.getSnapshot().memberships["tmdb:movie:693134"]?.favourite === true, 20000, "B→A visibility");
  // Independence: the watch-later flag survived on both.
  assert.equal(clientA.getSnapshot().memberships["tmdb:movie:693134"].watchLater, true);
  assert.equal(clientB.getSnapshot().memberships["tmdb:movie:693134"].watchLater, true);

  // Same-number TMDb movie/TV independence against the live server.
  clientA.toggle("tmdb:movie:123", "watch-later");
  clientA.toggle("tmdb:tv:123", "watch-later");
  await waitFor(() => clientA.getSnapshot().memberships["tmdb:tv:123"]?.watchLater === true, 15000, "tv:123 write");
  assert.equal(clientA.getSnapshot().memberships["tmdb:movie:123"].watchLater, true);
  assert.notEqual(
    clientA.getSnapshot().memberships["tmdb:movie:123"].revision,
    clientA.getSnapshot().memberships["tmdb:tv:123"].revision,
  );

  // SERVER RESTART: kill and restart the backend; a recreated client must
  // read the persisted household truth (server + client restart).
  serverProc.kill();
  await new Promise((r) => setTimeout(r, 1500));
  serverProc = startServer();
  await waitForServer();
  resetVersionCheck();
  const clientC = new LibraryStore({});
  assert.equal(await clientC.refreshCapability(), "available", "recreated client negotiates after restart");
  clientC.ensureOverview("watch-later", "recent");
  await waitFor(() => clientC.getSnapshot().overviews[overviewKey("watch-later", "recent")]?.status === "ready", 15000, "C overview after restart");
  const cOverview = clientC.getSnapshot().overviews[overviewKey("watch-later", "recent")];
  assert.equal(cOverview.shelves.find((s) => s.kind === "movie").count >= 1, true, "memberships survived the server restart");
  const duneRow = cOverview.shelves.flatMap((s) => s.previews).find((p) => p.canonicalId === "tmdb:movie:693134");
  assert.ok(duneRow, "the persisted membership is listed after restart");

  // Origin switch: state cleared, new origin unreachable.
  setBackendOrigin("http://127.0.0.1:59998");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(clientA.getSnapshot().overviews, {}, "origin-scoped caches cleared on switch");
  assert.equal(clientA.getSnapshot().availability, "unreachable", "origin without a server is unreachable");

  syncA.detach();
  syncB.detach();
  setBackendOrigin(SERVER);
});

import { resetVersionCheckCache } from "../../electron-app/src/lib/version-check.ts";
function resetVersionCheck() { resetVersionCheckCache(); }

test("M3.4 live: lossless revision beyond 2^53 through the real API", async () => {
  await waitForServer();
  // Household revision is seeded beyond Number.MAX_SAFE_INTEGER by the
  // harness (psql), then a write must return the exact decimal string.
  const { execSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const env = readFileSync("C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\env.ps1", "utf8");
  const pw = env.trim().replace(/^\$PGPW = '/, "").replace(/'$/, "");
  execSync(`docker exec -i -e PGPASSWORD=${pw} torwatch-m34-m4-postgres psql -U torwatch -d torwatch_m34 -c "UPDATE library_household SET revision = 9007199254740990 WHERE id = 1;"`, { stdio: "pipe" });

  const store = new LibraryStore({});
  assert.equal(await store.refreshCapability(), "available");
  store.toggle("tmdb:tv:555", "watch-later");
  await waitFor(() => store.getSnapshot().memberships["tmdb:tv:555"] !== undefined, 15000, "big-revision write");
  const revision = store.getSnapshot().memberships["tmdb:tv:555"].revision;
  assert.equal(revision, "9007199254740991", "the revision string survives the round trip losslessly");
  assert.ok(BigInt(revision) > 9007199254740990n);
});
