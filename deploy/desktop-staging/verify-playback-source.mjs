const baseUrl = String(process.argv[2] || "http://127.0.0.1:4001").replace(/\/+$/, "");
const title = "Big Buck Bunny";
const streamTimeoutMs = 30_000;

async function jsonRequest(path, options = {}, timeoutMs = 45_000) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...options.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${payload.error || "unknown error"}`);
  return payload;
}

function sourceResolutionBody(row) {
  if (String(row.magnetUri || "").toLowerCase().startsWith("magnet:?")) {
    return { magnetUri: row.magnetUri };
  }
  if (row.sourceId) return { sourceId: row.sourceId };
  if (row.infoHash) return { infoHash: row.infoHash };
  throw new Error("Selected source has no resolvable identity");
}

try {
  const search = await jsonRequest("/v1/torrents/search", {
    method: "POST",
    body: JSON.stringify({ kind: "movie", title, year: 2008 }),
  });
  const candidates = (Array.isArray(search.results) ? search.results : [])
    .filter((row) => /big[ ._-]+buck[ ._-]+bunny/i.test(String(row.title || "")) && Number(row.seeders) > 0)
    .sort((left, right) => Number(left.size || Infinity) - Number(right.size || Infinity));
  if (candidates.length === 0) {
    throw new Error(`Prowlarr returned ${search.total || 0} results but no currently seeded public-domain source`);
  }

  const selected = candidates[0];
  console.log(`PASS source search: ${search.total} results, ${candidates.length} seeded public-domain candidate(s)`);
  console.log(`  selected=${JSON.stringify(String(selected.title || ""))} seeders=${Number(selected.seeders) || 0} bytes=${Number(selected.size) || 0}`);

  const resolved = await jsonRequest("/v1/torrents/resolve", {
    method: "POST",
    body: JSON.stringify(sourceResolutionBody(selected)),
  }, 30_000);
  if (!String(resolved.magnetUri || "").toLowerCase().startsWith("magnet:?")) {
    throw new Error("Backend did not resolve the selected source to a magnet URI");
  }
  console.log("PASS source resolution: playable magnet returned (redacted)");

  const streamUrl = new URL(`${baseUrl}/stream`);
  streamUrl.searchParams.set("cat", "movie");
  streamUrl.searchParams.set("magnet", resolved.magnetUri);
  const streamResponse = await fetch(streamUrl, {
    headers: { Range: "bytes=0-65535" },
    signal: AbortSignal.timeout(streamTimeoutMs),
  });
  if (streamResponse.status !== 206) throw new Error(`/stream returned HTTP ${streamResponse.status}, expected 206`);
  const bytes = new Uint8Array(await streamResponse.arrayBuffer());
  if (bytes.length !== 65_536) throw new Error(`/stream returned ${bytes.length} bytes, expected 65536`);
  console.log(`PASS stream range: 206, ${bytes.length} bytes, ${streamResponse.headers.get("content-type") || "unknown type"}`);
  console.log("Focused playback-source verification: 3/3 PASS");
} catch (error) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  console.error(`FAIL focused playback-source verification: ${timedOut ? `no peer data within ${streamTimeoutMs / 1000}s` : error?.message || error}`);
  process.exitCode = 1;
}
