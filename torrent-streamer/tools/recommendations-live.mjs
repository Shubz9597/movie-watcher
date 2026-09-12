// M4.1 live verification: real recommendation endpoint over the real library
// store + deterministic TMDb stub (trending + genre lists + detail genres).
// No live provider credentials — documented boundary.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SERVER = "http://127.0.0.1:54341";

const { setBackendOrigin } = await import("../../electron-app/src/lib/connection-service.ts");
setBackendOrigin(SERVER);

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

test("M4.1 live: recommendations over the real library", async () => {
  const pw = readFileSync("C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\env.ps1", "utf8").trim().replace(/^\$PGPW = '/, "").replace(/'$/, "");

  // Deterministic TMDb stub: trending candidates + genre lists + seed detail
  // genres. tmdb:movie:456 shares "Science Fiction" with the favourite seed.
  const stubSource = `
import http from "node:http";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (body, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  switch (url.pathname) {
    case "/3/genre/movie/list": return json({ genres: [{ id: 878, name: "Science Fiction" }, { id: 28, name: "Action" }] });
    case "/3/genre/tv/list": return json({ genres: [{ id: 16, name: "Animation" }] });
    case "/3/trending/all/week": return json({ page: 1, total_pages: 1, results: [
      { media_type: "movie", id: 456, title: "Sci-Fi Candidate", release_date: "2024-01-01", genre_ids: [878] },
      { media_type: "movie", id: 457, title: "Excluded Later", release_date: "2024-02-01", genre_ids: [878] },
      { media_type: "movie", id: 458, title: "Popular Fill", release_date: "2024-03-01" },
      { media_type: "tv", id: 556, name: "Anime Candidate", first_air_date: "2023-01-01", original_language: "ja", genre_ids: [16] }
    ] });
    case "/3/movie/693134": return json({ id: 693134, title: "Dune: Part Two", release_date: "2024-02-27", genres: [{ id: 878, name: "Science Fiction" }], original_language: "en" });
    case "/3/movie/457": return json({ id: 457, title: "Excluded Later", release_date: "2024-02-01", genres: [{ id: 878, name: "Science Fiction" }] });
    default: return json({ status_code: 34 }, 404);
  }
});
server.listen(54343, "127.0.0.1");
`;
  writeFileSync("C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\stub-tmdb-m41.mjs", stubSource);
  const stub = spawn("node", ["C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\stub-tmdb-m41.mjs"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1200));

  const env = {
    PG_DSN: `postgres://torwatch:${pw}@127.0.0.1:54340/torwatch_m34?sslmode=disable`,
    LISTEN: "127.0.0.1:54341",
    PROWLARR_URL: "http://127.0.0.1:59999",
    PROWLARR_API_KEY: "dummy",
    TMDB_API_KEY: "stub-key",
    TORWATCH_TMDB_BASE_URL: "http://127.0.0.1:54343",
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
  };
  const server = spawn("C:\\Users\\user\\AppData\\Local\\Temp\\opencode\\m34\\torwatch.exe", [], { env, stdio: "ignore" });
  try {
    await waitForServer();

    // Capability is advertised together with library support.
    const version = await (await fetch(`${SERVER}/v1/version`)).json();
    assert.ok(version.capabilities.includes("recommendations.basic.v1"), `capabilities: ${version.capabilities}`);

    // Empty household → fallback Popular picks.
    const empty = await (await fetch(`${SERVER}/v2/recommendations`)).json();
    assert.equal(empty.fallback, true);
    assert.equal(empty.degraded, false);
    assert.ok(empty.items.length >= 2, `fallback items: ${empty.items.length}`);
    assert.ok(empty.items.every((i) => i.reason.code === "popular"));
    assert.match(empty.revision, /^\d+$/, "revision is a lossless decimal string");

    // Limit validation.
    for (const q of ["?limit=0", "?limit=21", "?limit=x"]) {
      const bad = await fetch(`${SERVER}/v2/recommendations${q}`);
      assert.equal(bad.status, 400, `limit ${q}`);
    }

    // A favourite seed with a matching genre, and a watch-later exclusion.
    const { LibraryStore } = await import("../../electron-app/src/lib/library-store.ts");
    const client = new LibraryStore({});
    const { resetVersionCheckCache } = await import("../../electron-app/src/lib/version-check.ts");
    resetVersionCheckCache();
    assert.equal(await client.refreshCapability(), "available");
    client.toggle("tmdb:movie:693134", "favourites"); // seed (Science Fiction)
    await new Promise((r) => setTimeout(r, 400));
    client.toggle("tmdb:movie:457", "watch-later"); // trending candidate → excluded
    await new Promise((r) => setTimeout(r, 400));

    // Cold (cache rebuild after the mutation).
    const t0 = Date.now();
    const scored = await (await fetch(`${SERVER}/v2/recommendations`)).json();
    const coldMs = Date.now() - t0;
    assert.equal(scored.fallback, false);
    const sciFi = scored.items.find((i) => i.canonicalId === "tmdb:movie:456");
    assert.ok(sciFi, "the genre-matching candidate is recommended");
    assert.equal(sciFi.reason.code, "seed_genre");
    assert.equal(sciFi.reason.seedCanonicalId, "tmdb:movie:693134");
    assert.equal(sciFi.reason.text, "Because you favourited Dune: Part Two");
    assert.ok(!scored.items.some((i) => i.canonicalId === "tmdb:movie:693134"), "seed excluded");
    assert.ok(!scored.items.some((i) => i.canonicalId === "tmdb:movie:457"), "watch-later excluded");
    assert.ok(!scored.items.some((i) => i.canonicalId === "tmdb:movie:1"), "non-candidate ids never appear");

    // Warm (cached): generatedAt must be identical (no recompute).
    const warm1 = await (await fetch(`${SERVER}/v2/recommendations`)).json();
    const tWarm = Date.now();
    const warm2 = await (await fetch(`${SERVER}/v2/recommendations`)).json();
    const warmMs = Date.now() - tWarm;
    assert.equal(warm1.generatedAt, scored.generatedAt, "no-op reads stay cached");
    assert.equal(warm2.generatedAt, scored.generatedAt);

    // No-op write: revision unchanged → cache stable.
    const { putLibraryFlag } = await import("../../electron-app/src/lib/services/library-service.ts");
    const noOp = await putLibraryFlag("tmdb:movie:693134", "favourites", true);
    assert.equal(noOp.revision, (await (await fetch(`${SERVER}/v2/library/overview?collection=favourites`)).json()).revision, "no-op write keeps the revision");
    const afterNoOp = await (await fetch(`${SERVER}/v2/recommendations`)).json();
    assert.equal(afterNoOp.generatedAt, scored.generatedAt, "no-op write must not invalidate");

    // Effective write: revision advances → recompute with fresh generatedAt.
    await putLibraryFlag("tmdb:movie:693134", "favourites", false);
    await putLibraryFlag("tmdb:movie:693134", "favourites", true);
    const rebuilt = await (await fetch(`${SERVER}/v2/recommendations`)).json();
    assert.notEqual(rebuilt.generatedAt, scored.generatedAt, "effective mutation invalidates the cache");

    console.log(`[m4.1] cold=${coldMs}ms warm=${warmMs}ms items=${scored.items.length}`);
    assert.ok(warmMs < coldMs + 5, "warm (cached) read is not slower than the cold build");
  } finally {
    server.kill();
    stub.kill();
  }
});
