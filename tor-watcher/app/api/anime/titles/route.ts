import { NextResponse } from "next/server";
import { cardFromJikan } from "@/lib/adapters/media";

export const runtime = "nodejs";

async function jikan(path: string) {
  const r = await fetch(`https://api.jikan.moe/v4${path}`, { next: { revalidate: 120 } });
  if (!r.ok) throw new Error(`Jikan ${r.status}`);
  return r.json();
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") || "").trim();
  const page = Number(u.searchParams.get("page") || "1");
  const limit = Math.min(24, Number(u.searchParams.get("limit") || "20"));

  try {
    const data = q
      ? await jikan(`/anime?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}&order_by=score&sort=desc`)
      : await jikan(`/top/anime?limit=${limit}&page=${page}`);

    const results = (data?.data || []).map(cardFromJikan);

    const totalPages = typeof data?.pagination?.last_visible_page === "number"
      ? data.pagination.last_visible_page
      : data?.pagination?.has_next_page ? page + 1 : page;

    return NextResponse.json({ page, total_pages: totalPages, results });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "anime list failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
