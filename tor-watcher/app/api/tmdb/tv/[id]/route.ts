import { NextRequest, NextResponse } from "next/server";
import { detailFromTmdbTv } from "@/lib/adapters/media";

export const runtime = "nodejs";

const TMDB_BASE_TVD = "https://api.themoviedb.org/3";
const TMDB_TOKEN_TVD = process.env.TMDB_BEARER || process.env.TMDB_TOKEN || process.env.TMDB_API_KEY;

function authTvd() {
  if (!TMDB_TOKEN_TVD) throw new Error("TMDB token missing");
  return { Authorization: `Bearer ${TMDB_TOKEN_TVD}` };
}

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  try {
    const id = await ctx.params.id;
    const u = new URL(`${TMDB_BASE_TVD}/tv/${id}`);
    u.searchParams.set("append_to_response", "external_ids,credits,videos");

    const res = await fetch(u.toString(), { headers: authTvd(), next: { revalidate: 120 } });
    if (!res.ok) throw new Error(`TMDb TV details failed: ${res.status}`);
    const it = await res.json();

    return NextResponse.json(detailFromTmdbTv(it));
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed" }, { status: 500 });
  }
}