import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Where your Go streamer runs
const VOD_BASE =
  process.env.VOD_BASE ??
  process.env.NEXT_PUBLIC_VOD_BASE ??
  "http://localhost:4001";

function toLangTagFromName(name: string) {
  const lower = name.toLowerCase();
  if (/\b(hin|hindi)\b/.test(lower)) return "hi";
  if (/\b(eng|english|en)\b/.test(lower)) return "en";
  if (/\b(fr|french)\b/.test(lower)) return "fr";
  if (/\b(es|spanish)\b/.test(lower)) return "es";
  return "und";
}

function baseName(p: string) {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const magnet = u.searchParams.get("magnet") || "";
  const src = u.searchParams.get("src") || "";
  const infoHash = u.searchParams.get("infoHash") || "";
  const cat = u.searchParams.get("cat") || "movie";

  // Ask Go for the file list
  const pass = new URLSearchParams();
  if (magnet) pass.set("magnet", magnet);
  if (src) pass.set("src", src);
  if (infoHash) pass.set("infoHash", infoHash);
  pass.set("cat", cat);

  const target = `${VOD_BASE.replace(/\/$/, "")}/files?${pass.toString()}`;

  try {
    const res = await fetch(target, { method: "GET" });
    if (!res.ok) {
      // If metadata isn’t ready yet, just return empty; UI can fall back to OpenSubs.
      return NextResponse.json({ subtitles: [] });
    }
    const files: Array<{ Index: number; Name: string; Length: number } | { index: number; name: string; length: number }> =
      await res.json();

    // Normalize possible field casing (Go JSON vs TS expectations)
    type FileEntry = { index?: number; Index?: number; name?: string; Name?: string; length?: number; Length?: number };
    const norm = files.map((f: FileEntry) => ({
      index: typeof f.index === "number" ? f.index : f.Index ?? 0,
      name: typeof f.name === "string" ? f.name : f.Name ?? "",
      length: typeof f.length === "number" ? f.length : f.Length ?? 0,
    }));

    const subs = norm
      .filter((f) => {
        const n = f.name.toLowerCase();
        return n.endsWith(".srt") || n.endsWith(".vtt");
      })
      .map((f) => {
        const filename = baseName(f.name);
        const ext = filename.toLowerCase().endsWith(".srt") ? "srt" : "vtt";

        // Serve through our Next route so we can SRT->VTT if needed
        const qs = new URLSearchParams();
        if (magnet) qs.set("magnet", magnet);
        if (src) qs.set("src", src);
        if (infoHash) qs.set("infoHash", infoHash);
        qs.set("cat", cat);
        qs.set("index", String(f.index));
        qs.set("ext", ext);

        return {
          source: "torrent" as const,
          label: filename,
          lang: toLangTagFromName(filename),
          url: `/api/subtitles/serve?${qs.toString()}`,
        };
      });

    return NextResponse.json({ subtitles: subs });
  } catch {
    return NextResponse.json({ subtitles: [] });
  }
}