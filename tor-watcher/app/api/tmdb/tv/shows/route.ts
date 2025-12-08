import { NextRequest, NextResponse } from "next/server";
import { cardFromTmdbTv } from "@/lib/adapters/media";

export const runtime = "nodejs";

const TMDB_BASE_TV = "https://api.themoviedb.org/3";
const TMDB_ACCESS_TOKEN = process.env.TMDB_ACCESS_TOKEN; // v4 read access token
const TMDB_API_KEY = process.env.TMDB_API_KEY;           // v3 api key

function tmdbHeaders(): HeadersInit | undefined {
  // If we have the v4 token, use Authorization header
  return TMDB_ACCESS_TOKEN ? { Authorization: `Bearer ${TMDB_ACCESS_TOKEN}` } : undefined;
}

function tmdbUrl(path: string): URL {
  // Always hit v3 endpoints; add api_key only if we don't have v4 token
  const u = new URL(`${TMDB_BASE_TV}/${path}`);
  if (!TMDB_ACCESS_TOKEN && TMDB_API_KEY) u.searchParams.set("api_key", TMDB_API_KEY);
  return u;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const page = Number(searchParams.get("page") || 1);
    const genreId = Number(searchParams.get("genreId") || 0);
    const sort = (searchParams.get("sort") || "trending").toString();
    const yearMin = Number(searchParams.get("yearMin") || 1970);
    const yearMax = Number(searchParams.get("yearMax") || new Date().getFullYear());
    const query = (searchParams.get("query") || "").trim();

    let url: string;
    if (query) {
      const u = tmdbUrl(`/search/tv`);
      u.searchParams.set("query", query);
      u.searchParams.set("page", String(page));
      url = u.toString();
    } else if (sort === "trending") {
      const u = tmdbUrl(`/trending/tv/day`);
      u.searchParams.set("page", String(page));
      url = u.toString();
    } else {
      const u = tmdbUrl(`/discover/tv`);
      u.searchParams.set("page", String(page));
      const map: Record<string, string> = {
        popularity: "popularity.desc",
        rating: "vote_average.desc",
        year: "first_air_date.desc",
      };
      u.searchParams.set("sort_by", map[sort] || "popularity.desc");
      if (genreId) u.searchParams.set("with_genres", String(genreId));
      u.searchParams.set("first_air_date.gte", `${yearMin}-01-01`);
      u.searchParams.set("first_air_date.lte", `${yearMax}-12-31`);
      u.searchParams.set("vote_count.gte", "100");
      url = u.toString();
    }

    const res = await fetch(url, { headers: tmdbHeaders(), next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`TMDb TV list failed: ${res.status}`);
    const json = await res.json();

    const results = (json.results || []).map(cardFromTmdbTv);
    return NextResponse.json({ page: json.page, total_pages: json.total_pages, total_results: json.total_results, results });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}