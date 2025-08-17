import { NextResponse } from "next/server";
import { tmdb } from "@/lib/services/tmbd-service"; // ⬅️ use the minimal client
import type { TmdbPaginated, TmdbMovie, Paginated } from "@/lib/types";
import { mapTmdbMovieToCard } from "@/lib/adapters/tmdb";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const nowYear = new Date().getFullYear();

  // Inputs
  const pageRaw = Number(searchParams.get("page") || "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(pageRaw, 1000) : 1;

  const query = (searchParams.get("query") || "").trim();
  const genreId = Number(searchParams.get("genreId") || "0") || 0;

  const sort = (searchParams.get("sort") || "trending") as
    | "trending" | "rating" | "year" | "popularity";

  const yearMinRaw = Number(searchParams.get("yearMin") || "1970");
  const yearMaxRaw = Number(searchParams.get("yearMax") || String(nowYear));
  const yearMin = Math.max(1874, Math.min(yearMinRaw || 1970, nowYear));
  const yearMax = Math.max(yearMin, Math.min(yearMaxRaw || nowYear, nowYear));

  // (Optional) If you later want to filter by original language on discover,
  // read `lang` and set with_original_language=xx only for discover.
  const lang = (searchParams.get("lang") || "").trim().toLowerCase(); // e.g. "en"

  // Build upstream
  let upstreamPath = "";
  let revalidateSeconds = 60; // default for discover
  let useCache = true;

  if (query) {
    // SEARCH → no store
    useCache = false;
    revalidateSeconds = 0;
    const params = new URLSearchParams({
      query,
      page: String(page),
      include_adult: "true",
      language: "en-US",
    });
    upstreamPath = `/search/movie?${params.toString()}`;
  } else {
    const needsDiscover =
      !!genreId ||
      sort !== "trending" ||
      yearMin !== 1970 ||
      yearMax !== nowYear ||
      !!lang;

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
      if (sort === "rating") params.set("vote_count.gte", "200");

      // Optional language filtering (discover only)
      if (lang) params.set("with_original_language", lang);

      upstreamPath = `/discover/movie?${params.toString()}`;
      revalidateSeconds = 60;
    } else {
      upstreamPath = `/trending/movie/day?page=${page}`;
      revalidateSeconds = 30;
    }
  }

  try {
    const init = ({ next: { revalidate: revalidateSeconds }, cache: "force-cache", signal: (req as any).signal } as RequestInit & { next: { revalidate: number } })

    const data = await tmdb<TmdbPaginated<TmdbMovie>>(upstreamPath, init) ;

    // If you ever pass `lang` for search (not supported by TMDB as a filter),
    // you could post-filter here:
    // const rows = lang && query ? data.results.filter(r => r.original_language === lang) : data.results;

    const results = (data.results ?? []).map(mapTmdbMovieToCard);

    return NextResponse.json(
      { page: data.page, total_pages: data.total_pages, results } satisfies Paginated<ReturnType<typeof mapTmdbMovieToCard>>,
      {
        headers: {
          "Cache-Control": query
            ? "no-store"
            : "public, s-maxage=60, stale-while-revalidate=600",
        },
      }
    );
  } catch (err: unknown) {
    if ((req as any).signal?.aborted || (err as { name?: string }).name === "AbortError") {
      return NextResponse.json({ error: "Request aborted" }, { status: 499 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    const is4xx = /TMDB 4\d\d/.test(msg);
    return NextResponse.json(
      { error: "Upstream TMDB error", detail: msg },
      { status: is4xx ? 400 : 502 }
    );
  }
}