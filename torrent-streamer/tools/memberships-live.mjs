// Repair-pass live verification: the new GET /v2/library/memberships
// endpoint over the real backend + disposable PostgreSQL (deterministic TMDb
// stub for metadata — no live provider credentials).
import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SERVER = "http://127.0.0.1:54346";

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

test("memberships endpoint reconciles flags and proves absence", async () => {
  const pw = readFileSync("C:/Users/user/AppData/Local/Temp/opencode/repair/env.ps1", "utf8").trim().replace(/^\$PGPW = '/, "").replace(/'$/, "");
  const stub = spawn("node", ["-e", `
    const http = require("node:http");
    http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/3/movie/693134" || url.pathname === "/3/movie/456") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ id: 693134, title: "Dune: Part Two", release_date: "2024-02-27", genres: [{ id: 878, name: "Science Fiction" }], original_language: "en" }));
      }
      res.writeHead(404); res.end("{}");
    }).listen(54347, "127.0.0.1");
  `], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
  const server = spawn("C:/Users/user/AppData/Local/Temp/opencode/repair/torwatch.exe", [], {
    env: {
      PG_DSN: `postgres://torwatch:${pw}@127.0.0.1:54345/torwatch_repair?sslmode=disable`,
      LISTEN: "127.0.0.1:54346",
      PROWLARR_URL: "http://127.0.0.1:59999",
      PROWLARR_API_KEY: "dummy",
      TMDB_API_KEY: "stub-key",
      TORWATCH_TMDB_BASE_URL: "http://127.0.0.1:54347",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    },
    stdio: "ignore",
  });
  try {
    await waitForServer();

    const put = async (id, field, enabled) => {
      const r = await fetch(`${SERVER}/v2/library/${id}/${field === "favourites" ? "favourite" : "watch-later"}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      if (r.status !== 200) console.log("[debug] PUT", id, field, r.status, await r.text());
      assert.equal(r.status, 200);
      return r.json();
    };

    // Two favourites.
    await put("tmdb:movie:693134", "watch-later", true);
    await put("tmdb:movie:456", "favourites", true);

    // The endpoint returns BOTH entries with confirmed flags at revision 2.
    const both = await (await fetch(`${SERVER}/v2/library/memberships?ids=tmdb%3Amovie%3A693134,tmdb%3Amovie%3A456,tmdb%3Amovie%3A999999`)).json();
    assert.equal(both.revision, "2");
    assert.equal(both.memberships.length, 2, "the unknown id is omitted");
    const dune = both.memberships.find((m) => m.canonicalId === "tmdb:movie:693134");
    assert.ok(dune.watchLater && !dune.favourite);

    // After a removal, the id stays (row retained) with a CONFIRMED false.
    await put("tmdb:movie:693134", "watch-later", false);
    const after = await (await fetch(`${SERVER}/v2/library/memberships?ids=tmdb%3Amovie%3A693134`)).json();
    assert.equal(after.revision, "3");
    assert.equal(after.memberships.length, 1);
    assert.equal(after.memberships[0].watchLater, false, "the removal is server-confirmed truth");

    // Malformed ids are skipped silently (never a 500).
    const mixed = await (await fetch(`${SERVER}/v2/library/memberships?ids=garbage,tmdb%3Amovie%3A456`)).json();
    assert.equal(mixed.memberships.length, 1);
    assert.equal(mixed.memberships[0].canonicalId, "tmdb:movie:456");
  } finally {
    // Windows + node --test: proc.kill() on spawned children trips a libuv
    // teardown assertion; taskkill is outside node's handle tracking.
    spawnSync("taskkill", ["/pid", String(server.pid), "/f", "/t"], { stdio: "ignore" });
    spawnSync("taskkill", ["/pid", String(stub.pid), "/f", "/t"], { stdio: "ignore" });
  }
});
