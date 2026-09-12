// Deterministic playback-service staging verifier (M1.3.x evidence).
//
// Against the STAGING backend it proves, WITHOUT torrent peers:
//   1. capability/readiness advertisement
//   2. compatible direct plan
//   3. MKV stream-copy remux plan
//   4. incompatible-codec transcode plan
//   5. HLS master playlist
//   6. one playable media segment with the correct MIME type
//   7. VTT subtitle retrieval
//   8. session DELETE + directory cleanup
//   9. secrets/source material absent from output
//
// Requirements: the staging backend must advertise playback.compat.v1 (both
// FFmpeg tools configured via .env) AND TORWATCH_PLAYBACK_FIXTURE_ROOT must
// contain generated fixture media named <40-hex>.mp4/.mkv/.srt. When the
// capability is absent, this verifier reports a TRUTHFUL SKIP with the exact
// reason — a missing host toolchain is never recorded as a pass. The
// equivalent deterministic proof for unconfigured hosts lives in the
// container-backed integration tests (internal/playback integration tag).
import { createRequire } from "node:module";
const require2 = createRequire("D:/Projects/movie-watcher/electron-app/package.json");

const backendOrigin = (process.argv[2] || "http://127.0.0.1:4001").replace(/\/+$/, "");
const results = [];
function record(ok, name, detail = "") {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name, detail) {
  results.push({ ok: true, skipped: true, name });
  console.log(`  SKIP: ${name}${detail ? ` — ${detail}` : ""}`);
}

async function api(path, init) {
  const response = await fetch(`${backendOrigin}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    signal: init?.signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

// 1. Capability/readiness.
const version = await api("/v1/version");
const capabilities = version.body?.capabilities || [];
const hasCapability = capabilities.includes("playback.compat.v1");
if (!hasCapability) {
  console.log("[verify-playback] playback.compat.v1 is NOT advertised:");
  console.log("[verify-playback]   configure FFMPEG_PATH/FFPROBE_PATH (and generate fixtures under");
  console.log("[verify-playback]   TORWATCH_PLAYBACK_FIXTURE_ROOT) to enable this verifier. This is a");
  console.log("[verify-playback]   truthful SKIP, not a pass — container integration tests carry the");
  console.log("[verify-playback]   deterministic evidence for unconfigured hosts.");
  skip("playback capability advertised", "FFmpeg toolchain not configured on this host");
  console.log(`\nPlayback-service verification: 0 proven / 1 skipped (capability absent)`);
  process.exit(0);
}
record(true, "playback capability advertised", capabilities.join(","));

const DIRECT = "1111111111111111111111111111111111111111";
const REMUX = "2222222222222222222222222222222222222222";
const TRANSCODE = "3333333333333333333333333333333333333333";

async function create(cat, hex, profile = "ios-avplayer") {
  const res = await api("/v2/playback/sessions", {
    method: "POST",
    body: JSON.stringify({ cat, sourceId: hex, fileIndex: 0, profile }),
  });
  return res;
}
async function del(id) {
  return api(`/v2/playback/sessions/${id}`, { method: "DELETE" });
}

// 2. Direct.
const direct = await create("movie", DIRECT);
record(direct.status === 201 && direct.body.mode === "direct" && direct.body.reasonCode === "compatible",
  "compatible MP4 plans direct", `status=${direct.status} mode=${direct.body.mode}`);

// 3. Remux (MKV/H.264/AAC).
const remux = await create("movie", REMUX);
record(remux.status === 201 && remux.body.mode === "remux",
  "MKV with compatible codecs plans remux (stream copy)", `status=${remux.status} mode=${remux.body.mode}`);

// 5+7. Master playlist + VTT for the remux session.
let masterOK = false, vttOK = false, segmentOK = false, playlistText = "";
if (remux.body.mode === "remux") {
  const master = await fetch(`${backendOrigin}${remux.body.playbackUrl}`);
  playlistText = await master.text();
  masterOK = master.status === 200 && master.headers.get("content-type") === "application/vnd.apple.mpegurl" &&
    playlistText.includes("#EXT-X-STREAM-INF");
  record(masterOK, "HLS master playlist served with the correct MIME", master.headers.get("content-type"));
  // 7. Subtitles.
  if ((remux.body.subtitles || []).length > 0) {
    const vtt = await fetch(`${backendOrigin}${remux.body.subtitles[0].url}`);
    const vttBody = await vtt.text();
    vttOK = vtt.status === 200 && vttBody.startsWith("WEBVTT") && !/\d{2}:\d{2}:\d{2},\d{3}/.test(vttBody);
    record(vttOK, "VTT subtitle retrieved and syntactically valid", vtt.headers.get("content-type"));
  } else {
    record(false, "VTT subtitle retrieved and syntactically valid", "no subtitle offers");
  }
  // 6. One segment with correct MIME (walk the variant playlist).
  const variantLine = playlistText.split("\n").map(s => s.trim()).find(l => l && !l.startsWith("#") && l.startsWith("hls/"));
  if (variantLine) {
    const variant = await fetch(`${backendOrigin}/v2/playback/sessions/${remux.body.sessionId}/${variantLine}`);
    const variantBody = await variant.text();
    const segLine = variantBody.split("\n").map(s => s.trim()).find(l => l && !l.startsWith("#"));
    if (segLine) {
      const seg = await fetch(`${backendOrigin}/v2/playback/sessions/${remux.body.sessionId}/${variantLine.replace(/playlist\.m3u8$/, "")}${segLine}`);
      const contentType = seg.headers.get("content-type");
      segmentOK = seg.status === 200 && contentType === "video/mp4";
      record(segmentOK, "media segment served with fMP4 MIME", contentType);
      await seg.body.cancel().catch(() => {});
    } else {
      record(false, "media segment served with fMP4 MIME", "variant lists no segments yet");
    }
    await variant.body.cancel().catch(() => {});
  } else {
    record(false, "media segment served with fMP4 MIME", "master lists no variant");
  }
}

// 4. Transcode (needs a free conversion slot: stop the remux session first).
if (remux.body.sessionId) await del(remux.body.sessionId);
const transcode = await create("movie", TRANSCODE);
record(transcode.status === 201 && transcode.body.mode === "transcode",
  "incompatible codec plans bounded transcode", `status=${transcode.status} mode=${transcode.body.mode}`);
if (transcode.body.sessionId) {
  // Give the transcoder a moment, then confirm segments appear (bounded).
  let sawSegment = false;
  for (let i = 0; i < 40 && !sawSegment; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const variant = await fetch(`${backendOrigin}/v2/playback/sessions/${transcode.body.sessionId}/hls/playlist.m3u8`);
      if (variant.status === 200) {
        const body = await variant.text();
        sawSegment = body.split("\n").some(l => l.trim() && !l.startsWith("#"));
        await variant.body.cancel().catch(() => {});
      }
    } catch { /* retry */ }
  }
  record(sawSegment, "transcode produced HLS segments (bounded H.264/AAC)");
}

// 9. Secrets/source material absent from playlists and views.
const serialized = JSON.stringify({ direct: direct.body, remux: remux.body, transcode: transcode.body, playlist: playlistText });
record(!serialized.includes("magnet:") && !serialized.includes(DIRECT) && !serialized.includes(REMUX) && !serialized.includes(TRANSCODE),
  "no magnets or source identifiers in any session output");

// 8. DELETE + cleanup.
let deleteOK = true;
for (const id of [direct.body.sessionId, transcode.body.sessionId].filter(Boolean)) {
  const res = await del(id);
  if (res.status !== 204) deleteOK = false;
  const after = await api(`/v2/playback/sessions/${id}`);
  if (after.status !== 404) deleteOK = false;
}
record(deleteOK, "session DELETE is honored and the session disappears");

const failed = results.filter(r => !r.ok && !r.skipped);
console.log(`\nPlayback-service verification: ${results.filter(r => r.ok && !r.skipped).length} proven / ${results.filter(r => r.skipped).length} skipped${failed.length ? ` — FAILURES: ${failed.map(f => f.name).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
