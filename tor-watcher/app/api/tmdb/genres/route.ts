import { NextResponse } from "next/server";
import { tmdb } from "@/lib/services/tmbd-service";
import type { TmdbGenreList } from "@/lib/types";

export async function GET() {
  const data = await tmdb<TmdbGenreList>("/genre/movie/list?language=en");
  return NextResponse.json(data.genres ?? [], {
    headers: { "Cache-Control": "public, s-maxage=86400" }, // 24h
  });
}