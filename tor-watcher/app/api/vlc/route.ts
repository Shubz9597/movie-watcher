import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VOD_BASE =
  process.env.VOD_BASE ??
  process.env.NEXT_PUBLIC_VOD_BASE ??
  "http://localhost:4001";

export async function GET(req: NextRequest) {
  const u = new URL(req.url);

  // reuse the same query (cat, magnet, fileIndex, mux, etc.)
  const stream = `${VOD_BASE.replace(/\/$/, "")}/stream${u.search}`;

  // (optional) use a friendly title if provided
  const title = u.searchParams.get("title") || "Stream";

  const body =
    `#EXTM3U\n` +
    `#EXTINF:-1,${title}\n` +
    `${stream}\n`;

  return new Response(body, {
    headers: {
      // both work with VLC; audio/x-mpegurl is the classic
      "Content-Type": "audio/x-mpegurl",
      "Content-Disposition": `attachment; filename="${slug(title)}.m3u"`,
      "Cache-Control": "no-store",
    },
  });
}

// tiny slug helper
function slug(s: string) {
  return s.replace(/[^\w\-\.]+/g, "_").slice(0, 80);
}