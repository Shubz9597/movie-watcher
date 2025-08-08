// app/api/tmdb/movie/[id]/route.ts
import { NextResponse } from "next/server";
import { tmdb, posterUrl, backdropUrl } from "@/lib/services/tmbd-service";
import type { MovieDetail, TmdbMovieDetail } from "@/lib/types";
import { mapTmdbDetailToMovieDetail } from "@/lib/adapters/tmdb";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> } // 👈 params is a Promise
) {
  const { id } = await ctx.params;        // 👈 await it
  const idNum = Number(id);

  if (!Number.isFinite(idNum) || idNum <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const path =
    `/movie/${idNum}?language=en-US&append_to_response=images,credits,videos&include_image_language=en,null`;



  try {
    const raw = await tmdb<TmdbMovieDetail>(path, { ttlMs: 15 * 60_000, cacheable: true });
    const resp: MovieDetail = mapTmdbDetailToMovieDetail(raw);
    return NextResponse.json(resp, {
      headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" },
    });

  } catch (err: any) {
    if (err?.name === "AbortError") {
      return NextResponse.json({ error: "Aborted" }, { status: 499 });
    }
    return NextResponse.json(
      { error: "Upstream TMDb error", detail: err?.message ?? "fetch failed" },
      { status: 502 }
    );
  }
}