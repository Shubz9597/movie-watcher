import { NextRequest } from "next/server";
import type { Instance as WebTorrentInstance, Torrent } from "webtorrent";
import { normalizeSrc, waitForMetadata } from "@/lib/torrent-src";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let client: WebTorrentInstance | null = null;

async function getClient(): Promise<WebTorrentInstance> {
  if (client) return client;
  (process as any).env.WEBTORRENT_UTP = "false";
  (globalThis as any).WEBTORRENT_UTP = "false";
  const mod = await import("webtorrent");
  const WebTorrent = (mod as any).default || mod;
  client = new WebTorrent({ utp: false });
  return client!;
}

function toLangTagFromName(name: string) {
  const lower = name.toLowerCase();
  if (/\b(hin|hindi)\b/.test(lower)) return "hi";
  if (/\b(eng|english|en)\b/.test(lower)) return "en";
  if (/\b(fr|french)\b/.test(lower)) return "fr";
  if (/\b(es|spanish)\b/.test(lower)) return "es";
  return "und";
}

export async function GET(req: NextRequest) {
  const magnetParam = req.nextUrl.searchParams.get("magnet");
  const srcParam    = req.nextUrl.searchParams.get("src");
  const infoHash    = req.nextUrl.searchParams.get("infoHash");

  const src = await normalizeSrc({ magnet: magnetParam, src: srcParam, infoHash });
  if (!src) return new Response(JSON.stringify({ subtitles: [] }), { headers: { "Content-Type": "application/json" } });

  const client = await getClient();
  const torrent: Torrent = await new Promise((resolve, reject) => {
    const ex = client.get(src);
    if (ex) return resolve(ex as unknown as Torrent);
    client.add(src, (t: Torrent) => resolve(t)).once("error", reject);
  });

  try { await waitForMetadata(torrent, 15000); }
  catch { return new Response(JSON.stringify({ subtitles: [] }), { headers: { "Content-Type": "application/json" } }); }

  const files = Array.isArray(torrent.files) ? torrent.files : [];
  const subs = files
    .filter(f => { const n = f.name.toLowerCase(); return n.endsWith(".srt") || n.endsWith(".vtt"); })
    .map((f, i) => ({
      source: "torrent" as const,
      label: f.name,
      lang: toLangTagFromName(f.name),
      url: `/api/subtitles/serve?${magnetParam ? "magnet" : srcParam ? "src" : "infoHash"}=${encodeURIComponent(magnetParam ?? srcParam ?? (infoHash ?? ""))}&index=${i}`,
    }));

  return new Response(JSON.stringify({ subtitles: subs }), { headers: { "Content-Type": "application/json" } });
}