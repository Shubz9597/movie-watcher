import { NextResponse } from "next/server";
import { tmdb, posterUrl } from "@/lib/services/tmbd-service";
import type { TmdbPaginated, TmdbMovie, Paginated } from "@/lib/types";
import { mapTmdbMovieToCard } from "@/lib/adapters/tmdb";

function isNew(release_date?: string) {
  if (!release_date) return false;
  const d = new Date(release_date);
  const now = new Date();
  const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
  return diffDays <= 30;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const nowYear = new Date().getFullYear();

  // Parse & sanitize inputs
  const pageRaw = Number(searchParams.get("page") || "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 1000) : 1;

  const query = (searchParams.get("query") || "").trim();
  const genreId = Number(searchParams.get("genreId") || "0") || 0;

  const sort = (searchParams.get("sort") || "trending") as
    | "trending" | "rating" | "year" | "popularity";

  const yearMinRaw = Number(searchParams.get("yearMin") || "1970");
  const yearMaxRaw = Number(searchParams.get("yearMax") || String(nowYear));
  const yearMin = Math.max(1874, Math.min(yearMinRaw || 1970, nowYear)); // TMDB data floor
  const yearMax = Math.max(yearMin, Math.min(yearMaxRaw || nowYear, nowYear));

  // Build upstream URL
  let upstreamPath = "";
  let cacheable = true; // switch off for search
  let ttlMs = 60_000;   // default TTL for discover/trending

  if (query) {
    // SEARCH — no cache
    cacheable = false;
    ttlMs = 0;
    const params = new URLSearchParams({
      query,
      page: String(page),
      include_adult: "false",
      language: "en-US",
    });
    upstreamPath = `/search/movie?${params.toString()}`;
  } else {
    // DISCOVER or TRENDING
    const needsDiscover =
      !!genreId ||
      sort !== "trending" ||
      yearMin !== 1970 ||
      yearMax !== nowYear;

    if (needsDiscover) {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("include_adult", "false");
      params.set("language", "en-US");

      const sortMap: Record<string, string> = {
        trending: "popularity.desc",
        popularity: "popularity.desc",
        rating: "vote_average.desc",
        year: "primary_release_date.desc",
      };
      params.set("sort_by", sortMap[sort] ?? "popularity.desc");

      if (genreId) params.set("with_genres", String(genreId));
      params.set("primary_release_date.gte", `${yearMin}-01-01`);
      params.set("primary_release_date.lte", `${yearMax}-12-31`);

      // Guard for rating sort: avoid low-vote noise and TMDB quirks
      if (sort === "rating") params.set("vote_count.gte", "200");

      upstreamPath = `/discover/movie?${params.toString()}`;
      ttlMs = 60_000; // 60s cache is safe for discover
    } else {
      upstreamPath = `/trending/movie/day?page=${page}`;
      ttlMs = 30_000; // trending rotates fast; shorter TTL
    }
  }

  try {
    const data = await tmdb<TmdbPaginated<TmdbMovie>>(upstreamPath, {
    ttlMs,
    cacheable,
    signal: req.signal, // <-- forward cancellation
  });

    const results = data.results?.map(mapTmdbMovieToCard) ?? [];

    return NextResponse.json(
      { page: data.page, total_pages: data.total_pages, results } satisfies Paginated<ReturnType<typeof mapTmdbMovieToCard>>,
      {
        headers: {
          // Edge cache hint (doesn't affect your in-memory LRU)
          "Cache-Control": query
            ? "no-store"
            : "public, s-maxage=60, stale-while-revalidate=600",
        },
      }
    );
  } catch (err: any) {
    // Map upstream errors → cleaner status for client
    if (req.signal.aborted || err?.name === "AbortError") {
    return NextResponse.json({ error: "Request aborted" }, { status: 499 });
  }
  const msg = err?.message || "Upstream error";
  const is4xx = /TMDb 4\d\d/.test(msg);
  return NextResponse.json({ error: "Upstream TMDb error", detail: msg }, { status: is4xx ? 400 : 502 });
  }
}