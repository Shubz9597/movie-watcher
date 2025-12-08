import { NextRequest, NextResponse } from "next/server";
import { detailFromTmdbMovie } from "@/lib/adapters/media";

export const runtime = "nodejs";

const TMDB_BASE_D = "https://api.themoviedb.org/3";
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN; // v4 read access token
const TMDB_API_KEY = process.env.TMDB_API_KEY;           // v3 api key

function tmdbHeaders(): HeadersInit | undefined {
  // If we have the v4 token, use Authorization header
  return TMDB_ACCESS_TOKEN ? { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` } : undefined;
}

function tmdbUrl(path: string): URL {
  // Always hit v3 endpoints; add api_key only if we don't have v4 token
  const u = new URL(`${TMDB_BASE_D}/${path}`);
  if (!TMDB_ACCESS_TOKEN && TMDB_API_KEY) u.searchParams.set("api_key", TMDB_API_KEY);
  return u;
}
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const u = tmdbUrl(`/movie/${id}`);
    u.searchParams.set("append_to_response", "external_ids,credits,videos");

    const res = await fetch(u.toString(), { headers: tmdbHeaders(), next: { revalidate: 120 } });
    if (!res.ok) throw new Error(`TMDb movie details failed: ${res.status}`);
    const it = await res.json();

    return NextResponse.json(detailFromTmdbMovie(it));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
