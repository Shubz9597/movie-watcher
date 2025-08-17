// app/api/tmdb/movie/[id]/route.ts
export const runtime = "nodejs"; // needed for better-sqlite3/zlib/etc.

import { NextResponse } from "next/server";
// If you kept the original helper:
import { tmdb } from "@/lib/services/tmbd-service";
// If you migrated to the minimal helper, use:
// import { tmdb } from "@/lib/tmdb";

import type { MovieDetail, TmdbMovieDetail } from "@/lib/types";
import { mapTmdbDetailToMovieDetail } from "@/lib/adapters/tmdb";

// IMDb (SQLite) helper we built earlier
import { getImdbRating } from "@/lib/imdb/sqlite";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } } // ✅ correct Next.js signature
) {
  const param = await params; // this is a string, e.g. "123456"
  const idNum = Number(param.id);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // include external_ids to obtain imdb_id
  const path =
    `/movie/${idNum}` +
    `?language=en-US` +
    `&append_to_response=images,credits,videos,external_ids` +
    `&include_image_language=en,null`;

  try {
    // Cache TMDB detail a bit (adjust TTL to taste)
    const raw = await tmdb<TmdbMovieDetail>(path, {
      // these options exist on your current tmdb helper
      next: {
        revalidate: 900, // 15 minutes}
  }});

    // Base detail from your adapter
    const base: MovieDetail = mapTmdbDetailToMovieDetail(raw);

    // Pull IMDb id from external_ids
    const imdbId =
      (raw as any)?.external_ids?.imdb_id ??
      (raw as any)?.imdb_id ??
      base?.imdbId ??
      null;

    // Super-fast lookup from local SQLite (no network, no OMDb)
    let imdbRating: number | null = null;
    let imdbVotes: number | null = null;
    try {
      if (imdbId) {
        const row = getImdbRating(imdbId); // { rating, votes } | null
        if (row) {
          imdbRating = row.rating;
          imdbVotes = row.votes;
        }
      }
    } catch {
      // if DB missing or any issue, just omit IMDb fields
    }

    // Also surface TMDB popularity & originalLanguage
    const tmdbPopularity: number | null =
      typeof (raw as any)?.popularity === "number" ? (raw as any).popularity : null;

    const originalLanguage: string | undefined = (raw as any)?.original_language;

    // Enrich payload (widen the type inline to avoid TS friction if MovieDetail
    // doesn’t yet declare these optional fields)
    const enriched = {
      ...base,
      originalLanguage,
      tmdbPopularity,
      imdbRating,
      imdbVotes,
    } as MovieDetail & {
      originalLanguage?: string;
      tmdbPopularity: number | null;
      imdbRating: number | null;
      imdbVotes: number | null;
    };

    return NextResponse.json(enriched, {
      headers: {
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600",
      },
    });
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "AbortError") {
      return NextResponse.json({ error: "Aborted" }, { status: 499 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Upstream TMDb error", detail: msg ?? "fetch failed" },
      { status: 502 }
    );
  }
}