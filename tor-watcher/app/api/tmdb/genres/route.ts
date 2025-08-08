import { NextResponse } from "next/server";
import { tmdb } from "@/lib/services/tmbd-service";

export async function GET() {
  const data = await tmdb(`/genre/movie/list?language=en`);
  return NextResponse.json(data.genres ?? [], {
    headers: { "Cache-Control": "public, s-maxage=86400" }, // 24h
  });
}