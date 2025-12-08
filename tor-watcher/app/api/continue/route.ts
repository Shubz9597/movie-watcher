import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const VOD_BASE = process.env.VOD_URL || "http://localhost:4001";
const TMDB_BASE = "https://api.themoviedb.org/3";
const JIKAN_BASE = "https://api.jikan.moe/v4";
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN;
const TMDB_API_KEY = process.env.TMDB_API_KEY;

function tmdbHeaders(): HeadersInit | undefined {
  return TMDB_ACCESS_TOKEN ? { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` } : undefined;
}

function tmdbUrl(path: string): string {
  const u = new URL(`${TMDB_BASE}${path}`);
  if (!TMDB_ACCESS_TOKEN && TMDB_API_KEY) u.searchParams.set("api_key", TMDB_API_KEY);
  return u.toString();
}

type RawContinueItem = {
  seriesId: string;
  season: number;
  episode: number;
  position_s: number;
  duration_s: number;
  percent: number;
  updated_at: string;
};

export type EnrichedContinueItem = RawContinueItem & {
  title: string;
  posterPath: string | null;
  year?: number;
  kind: "movie" | "tv" | "anime";
  tmdbId?: number;
  malId?: number;
};

// Parse seriesId format: "tmdb:movie:123", "tmdb:tv:456", "mal:789", "anilist:xxx"
function parseSeriesId(seriesId: string): { provider: string; type: string; id: string } {
  const parts = seriesId.split(":");
  if (parts.length === 3) {
    // tmdb:movie:123 or tmdb:tv:456
    return { provider: parts[0], type: parts[1], id: parts[2] };
  } else if (parts.length === 2) {
    // mal:123 or anilist:123
    return { provider: parts[0], type: "anime", id: parts[1] };
  }
  return { provider: "unknown", type: "unknown", id: seriesId };
}

async function fetchTmdbMovie(id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const res = await fetch(tmdbUrl(`/movie/${id}`), { headers: tmdbHeaders(), next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.title || "",
      posterPath: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      year: data.release_date ? Number(data.release_date.slice(0, 4)) : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchTmdbTv(id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const res = await fetch(tmdbUrl(`/tv/${id}`), { headers: tmdbHeaders(), next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.name || "",
      posterPath: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      year: data.first_air_date ? Number(data.first_air_date.slice(0, 4)) : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchJikanAnime(id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const res = await fetch(`${JIKAN_BASE}/anime/${id}`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const json = await res.json();
    const data = json.data;
    if (!data) return null;
    return {
      title: data.title_english || data.title || "",
      posterPath: data.images?.jpg?.image_url || data.images?.webp?.image_url || null,
      year: data.aired?.from ? new Date(data.aired.from).getFullYear() : undefined,
    };
  } catch {
    return null;
  }
}

async function enrichItem(item: RawContinueItem): Promise<EnrichedContinueItem> {
  const { provider, type, id } = parseSeriesId(item.seriesId);
  
  let metadata: { title: string; posterPath: string | null; year?: number } | null = null;
  let kind: "movie" | "tv" | "anime" = "tv";
  let tmdbId: number | undefined;
  let malId: number | undefined;

  if (provider === "tmdb" && type === "movie") {
    kind = "movie";
    tmdbId = Number(id);
    metadata = await fetchTmdbMovie(id);
  } else if (provider === "tmdb" && type === "tv") {
    kind = "tv";
    tmdbId = Number(id);
    metadata = await fetchTmdbTv(id);
  } else if (provider === "mal" || provider === "anilist") {
    kind = "anime";
    if (provider === "mal") {
      malId = Number(id);
      metadata = await fetchJikanAnime(id);
    }
    // For anilist, we'd need a different API - for now just show the ID
  }

  return {
    ...item,
    title: metadata?.title || item.seriesId,
    posterPath: metadata?.posterPath || null,
    year: metadata?.year,
    kind,
    tmdbId,
    malId,
  };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const subjectId = searchParams.get("subjectId");
    const limit = searchParams.get("limit") || "12";

    if (!subjectId) {
      return NextResponse.json({ error: "subjectId required" }, { status: 400 });
    }

    // Fetch raw continue items from Go backend
    const vodUrl = `${VOD_BASE}/v1/continue?subjectId=${encodeURIComponent(subjectId)}&limit=${limit}`;
    const res = await fetch(vodUrl, { cache: "no-store" });
    
    if (!res.ok) {
      // If VOD backend is not available, return empty array
      console.warn(`[continue] VOD backend error: ${res.status}`);
      return NextResponse.json([]);
    }

    const rawItems: RawContinueItem[] = await res.json();
    
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return NextResponse.json([]);
    }

    // Enrich items with metadata in parallel
    const enrichedItems = await Promise.all(rawItems.map(enrichItem));

    return NextResponse.json(enrichedItems);
  } catch (e) {
    console.error("[continue] Error:", e);
    return NextResponse.json([]);
  }
}

