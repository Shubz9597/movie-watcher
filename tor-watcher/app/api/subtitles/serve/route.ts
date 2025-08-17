import { NextRequest } from "next/server";
import { PassThrough, Readable } from "stream";
// @ts-ignore – cjs transform stream
import srt2vtt from "srt2vtt";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VOD_BASE =
  process.env.VOD_BASE ??
  process.env.NEXT_PUBLIC_VOD_BASE ??
  "http://localhost:4001";

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const magnet = u.searchParams.get("magnet") || "";
  const src = u.searchParams.get("src") || "";
  const infoHash = u.searchParams.get("infoHash") || "";
  const cat = u.searchParams.get("cat") || "movie";
  const indexStr = u.searchParams.get("index");
  const ext = (u.searchParams.get("ext") || "").toLowerCase(); // "srt" or "vtt"

  if (!indexStr) return new Response("Missing index", { status: 400 });
  const index = Number(indexStr);
  if (!Number.isFinite(index) || index < 0) {
    return new Response("Bad index", { status: 400 });
  }

  // Build call to Go's /stream for the subtitle fileIndex
  const pass = new URLSearchParams();
  if (magnet) pass.set("magnet", magnet);
  if (src) pass.set("src", src);
  if (infoHash) pass.set("infoHash", infoHash);
  pass.set("cat", cat);
  pass.set("fileIndex", String(index));

  const target = `${VOD_BASE.replace(/\/$/, "")}/stream?${pass.toString()}`;

  const res = await fetch(target, { method: "GET" });
  if (!res.ok || !res.body) {
    return new Response("Subtitle fetch failed", { status: res.status || 502 });
  }

  // Convert SRT -> VTT on the fly if needed
  if (ext === "srt") {
    const nodeReadable = Readable.fromWeb(res.body as any); // web -> node stream
    const out = new PassThrough();
    nodeReadable.pipe(srt2vtt()).pipe(out);
    return new Response(out as any, {
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  // Already VTT (or unknown) – pass through
  return new Response(res.body, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}