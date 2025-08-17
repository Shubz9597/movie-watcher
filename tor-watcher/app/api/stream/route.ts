import { NextRequest } from "next/server";
import type { Instance as WebTorrentInstance, Torrent, TorrentFile } from "webtorrent";
import { lookup as mimeLookup } from "mime-types";
import { normalizeSrc, waitForMetadata } from "@/lib/torrent-src";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let client: WebTorrentInstance | null = null;
const TORRENT_DIR = process.env.TORRENT_DIR || "/tmp/movie-watcher-cache";

// Extra HTTP(S) trackers to help in restricted networks (merged with magnet's trackers)
const EXTRA_TRACKERS = [
  // HTTPS (works behind many firewalls)
  "https://tracker.opentrackr.org:443/announce",
  "https://tracker.tamersunion.org:443/announce",
  "https://tracker.renfei.net:443/announce",
  "https://tracker.gbitt.info:443/announce",
  "https://tracker.zemoj.com/announce",
  // HTTP fallback (often fine locally)
  "http://tracker.opentrackr.org:1337/announce",
];

async function getClient(): Promise<WebTorrentInstance> {
  if (client) return client;
  (process as any).env.WEBTORRENT_UTP = "false";
  (globalThis as any).WEBTORRENT_UTP = "false";
  const mod = await import("webtorrent");
  const WebTorrent = (mod as any).default || mod;
  client = new WebTorrent({ utp: false, dht: true, tracker: true });
  return client!;
}

function pickBestFile(t: Torrent): TorrentFile | null {
  const files = Array.isArray(t.files) ? t.files : [];
  const playable = new Set([".mp4", ".webm", ".mkv", ".mov", ".m4v"]);
  const candidates = files.filter((f) => {
    const n = f.name.toLowerCase();
    for (const ext of playable) if (n.endsWith(ext)) return true;
    return false;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

export async function GET(req: NextRequest) {
  const magnetParam = req.nextUrl.searchParams.get("magnet");
  const srcParam    = req.nextUrl.searchParams.get("src");
  const infoHash    = req.nextUrl.searchParams.get("infoHash");
  const fileIndexParam = req.nextUrl.searchParams.get("fileIndex");

  // Normalize: resolve /download -> magnet, infoHash -> magnet
  const src = await normalizeSrc({ magnet: magnetParam, src: srcParam, infoHash });
  if (!src) {
    return new Response(JSON.stringify({ error: "Missing src/magnet/infoHash" }), { status: 400 });
  }

  const range = req.headers.get("range") || "";
  const client = await getClient();

  // Add (or reuse) torrent; merge extra HTTP trackers to improve reachability
  const torrent: Torrent = await new Promise((resolve, reject) => {
    const ex = client.get(src);
    if (ex) return resolve(ex as unknown as Torrent);
    client
      .add(src, { path: TORRENT_DIR, announce: EXTRA_TRACKERS }, (t: Torrent) => resolve(t))
      .once("error", reject);
  });

  // Wait longer for metadata (30s). If still no metadata → 504 (cleanly).
  try {
    await waitForMetadata(torrent, 30_000);
  } catch {
    return new Response(JSON.stringify({ error: "Could not fetch torrent metadata (trackers/peers unreachable)" }), { status: 504 });
  }

  let file: TorrentFile | null = null;
  if (fileIndexParam && Array.isArray(torrent.files)) {
    const idx = Number(fileIndexParam);
    if (!Number.isNaN(idx) && idx >= 0 && idx < torrent.files.length) file = torrent.files[idx];
  }
  if (!file) file = pickBestFile(torrent);
  if (!file) {
    return new Response(JSON.stringify({ error: "No video file found in torrent" }), { status: 404 });
  }

  const size = file.length;
  const ct = (mimeLookup(file.name) as string) || "application/octet-stream";

  let start = 0, end = size - 1;
  const m = range.match(/bytes=(\d+)-(\d+)?/);
  if (m) {
    start = parseInt(m[1], 10);
    const parsedEnd = m[2] ? parseInt(m[2], 10) : end;
    end = Math.min(parsedEnd, end);
  }

  if (start >= size) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  const stream = file.createReadStream({ start, end });
  return new Response(stream as any, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": ct,
      "Accept-Ranges": "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Cache-Control": "no-store",
    },
  });
}