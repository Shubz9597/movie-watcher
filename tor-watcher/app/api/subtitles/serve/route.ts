import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This route serves subtitle files from the torrent streamer
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
  const index = u.searchParams.get("index") || "0";
  const ext = u.searchParams.get("ext") || "vtt";

  const pass = new URLSearchParams();
  if (magnet) pass.set("magnet", magnet);
  if (src) pass.set("src", src);
  if (infoHash) pass.set("infoHash", infoHash);
  pass.set("cat", cat);
  pass.set("fileIndex", index);

  const target = `${VOD_BASE.replace(/\/$/, "")}/stream?${pass.toString()}`;

  try {
    const res = await fetch(target, { method: "GET" });
    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch subtitle" }, { status: res.status });
    }

    const content = await res.text();
    const contentType = ext === "vtt" ? "text/vtt" : "application/x-subrip";

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to serve subtitle" }, { status: 500 });
  }
}

