// app/api/subtitles/serve/route.ts
import { NextRequest } from "next/server";
import type { Instance as WebTorrentInstance, Torrent } from "webtorrent";
import { PassThrough } from "stream";
// @ts-ignore - srt2vtt has no great types; we just use it as a transform stream
import srt2vtt from "srt2vtt";

import { normalizeSrc, waitForMetadata } from "@/lib/torrent-src";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let client: WebTorrentInstance | null = null;

async function getClient(): Promise<WebTorrentInstance> {
  if (client) return client;
  // Hard-disable uTP on Windows/Node 22
  (process as any).env.WEBTORRENT_UTP = "false";
  (globalThis as any).WEBTORRENT_UTP = "false";

  const mod = await import("webtorrent");
  const WebTorrent = (mod as any).default || mod;
  client = new WebTorrent({ utp: false });
  return client!;
}

export async function GET(req: NextRequest) {
  const magnetParam = req.nextUrl.searchParams.get("magnet");
  const srcParam    = req.nextUrl.searchParams.get("src");
  const infoHash    = req.nextUrl.searchParams.get("infoHash");
  const indexStr    = req.nextUrl.searchParams.get("index");

  const src = await normalizeSrc({ magnet: magnetParam, src: srcParam, infoHash });
  if (!src || indexStr === null) {
    return new Response("Missing source and/or index", { status: 400 });
  }

  const index = Number(indexStr);
  if (!Number.isFinite(index) || index < 0) {
    return new Response("Bad index", { status: 400 });
  }

  const client = await getClient();

  const torrent: Torrent = await new Promise((resolve, reject) => {
    const ex = client.get(src);
    if (ex) return resolve(ex as unknown as Torrent);
    client.add(src, (t: Torrent) => resolve(t)).once("error", reject);
  });

  try {
    await waitForMetadata(torrent, 15000);
  } catch {
    return new Response("Could not fetch torrent metadata", { status: 504 });
  }

  const files = Array.isArray(torrent.files) ? torrent.files : [];
  const subFiles = files.filter((f) => {
    const n = f.name.toLowerCase();
    return n.endsWith(".srt") || n.endsWith(".vtt");
  });

  const file = subFiles[index];
  if (!file) {
    return new Response("Subtitle not found", { status: 404 });
  }

  const isSrt = file.name.toLowerCase().endsWith(".srt");
  const passthrough = new PassThrough();

  const read = file.createReadStream().on("error", (err) => passthrough.destroy(err));
  if (isSrt) {
    // Convert SRT → VTT on the fly
    // @ts-ignore - transform stream without types
    read.pipe(srt2vtt()).pipe(passthrough);
  } else {
    read.pipe(passthrough);
  }

  return new Response(passthrough as any, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}