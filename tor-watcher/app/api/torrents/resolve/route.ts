import { NextRequest, NextResponse } from "next/server";
import { normalizeSrc } from "@/lib/torrent-src";
import { pickFileIndexForEpisode, TorrentFileEntry } from "@/lib/anime-matching";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VOD_BASE = (process.env.VOD_BASE ?? process.env.NEXT_PUBLIC_VOD_BASE ?? "http://localhost:4001").replace(/\/$/, "");

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function normalizeFiles(raw: unknown): TorrentFileEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => {
      if (typeof f !== "object" || f === null) return { index: -1, name: "" };
      const entry = f as Record<string, unknown>;
      const index =
        typeof entry.index === "number"
          ? entry.index
          : typeof entry.Index === "number"
            ? entry.Index
            : -1;
      const name =
        typeof entry.name === "string"
          ? entry.name
          : typeof entry.Name === "string"
            ? entry.Name
            : "";
      const length =
        typeof entry.length === "number"
          ? entry.length
          : typeof entry.Length === "number"
            ? entry.Length
            : undefined;
      return { index, name, length };
    })
    .filter((f) => Number.isFinite(f.index) && f.index >= 0 && f.name.length > 0);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const magnetUri = typeof body?.magnetUri === "string" ? body.magnetUri : undefined;
    const torrentUrl = typeof body?.torrentUrl === "string" ? body.torrentUrl : undefined;
    const downloadUrl = typeof body?.downloadUrl === "string" ? body.downloadUrl : undefined;
    const infoHash = typeof body?.infoHash === "string" ? body.infoHash : undefined;
    const cat =
      typeof body?.cat === "string" && body.cat.trim().length > 0
        ? body.cat.trim().toLowerCase()
        : "anime";

    const season = coerceNumber(body?.season);
    const episode = coerceNumber(body?.episode);
    const absolute = coerceNumber(body?.absolute);

    if (episode == null && absolute == null) {
      return NextResponse.json({ error: "episode or absolute number is required" }, { status: 400 });
    }

    const normalizedSrc = await normalizeSrc({
      magnet: magnetUri,
      src: torrentUrl ?? downloadUrl,
      infoHash,
    });

    if (!normalizedSrc) {
      return NextResponse.json({ error: "Unable to determine torrent source" }, { status: 400 });
    }

    const params = new URLSearchParams();
    params.set("cat", cat);
    if (normalizedSrc.startsWith("magnet:")) {
      params.set("magnet", normalizedSrc);
    } else if (/^https?:\/\//i.test(normalizedSrc)) {
      params.set("src", normalizedSrc);
    } else if (infoHash) {
      params.set("infoHash", infoHash);
    } else {
      return NextResponse.json({ error: "Unsupported source format" }, { status: 400 });
    }

    const target = `${VOD_BASE}/files?${params.toString()}`;
    const filesRes = await fetch(target, { method: "GET", cache: "no-store" });
    if (!filesRes.ok) {
      return NextResponse.json(
        { error: `File listing failed (${filesRes.status})` },
        { status: filesRes.status === 404 ? 404 : 502 }
      );
    }

    const filesJson = await filesRes.json();
    const files = normalizeFiles(filesJson);
    if (!files.length) {
      return NextResponse.json({ error: "No files returned for torrent" }, { status: 404 });
    }

    const pick = pickFileIndexForEpisode(files, { season, episode, absolute });
    if (!pick) {
      return NextResponse.json({ error: "No matching file for requested episode" }, { status: 404 });
    }

    return NextResponse.json({
      fileIndex: pick.index,
      fileName: pick.name,
      fileLength: pick.length ?? null,
      matched: pick.matched ?? false,
      score: pick.score ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to resolve episode file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

