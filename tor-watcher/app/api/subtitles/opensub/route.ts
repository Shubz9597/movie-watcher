import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// TEMP stub: returns no subtitles, but 200 OK so the UI doesn't 404.
export async function GET(req: NextRequest) {
  const imdbId = req.nextUrl.searchParams.get("imdbId") || "";
  const langs  = (req.nextUrl.searchParams.get("langs") || "").split(",").filter(Boolean);

  // TODO: replace with real OpenSubtitles fetch.
  // For now just return an empty list with the echo of what was requested.
  return NextResponse.json({
    subtitles: [],
    source: "opensubtitles",
    query: { imdbId, langs },
  });
}