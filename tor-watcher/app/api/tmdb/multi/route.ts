import { NextResponse } from "next/server";

// Reuse your existing TMDb helpers if you have them:
const TMDB_API_KEY = process.env.TMDB_API_KEY!;
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p/w185"; // tiny thumbs for search

// Normalize TMDb item to a compact shape
function toBasic(item: any) {
  const media = item.media_type as "movie" | "tv" | "person";
  if (media === "person") {
    return {
      id: item.id,
      name: item.name ?? "",
      posterUrl: item.profile_path ? `${IMG_BASE}${item.profile_path}` : null,
      known_for: (item.known_for ?? [])
        .map((k: any) => k.title || k.name)
        .filter(Boolean)
        .slice(0, 3),
    };
  }
  const title = media === "movie" ? item.title : item.name;
  const date = media === "movie" ? item.release_date : item.first_air_date;
  const year = date ? Number.parseInt(date.slice(0, 4), 10) : undefined;
  return {
    id: item.id,
    title: title ?? "Untitled",
    year,
    rating: typeof item.vote_average === "number" ? item.vote_average : undefined,
    posterUrl: item.poster_path ? `${IMG_BASE}${item.poster_path}` : null,
    genreIds: Array.isArray(item.genre_ids) ? item.genre_ids : [],
  };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("query") || "").trim();
    const page = searchParams.get("page") || "1";
    const includeAdult = searchParams.get("adult") === "true"; // default false

    if (query.length < 2) {
      return NextResponse.json(
        { error: "Query must be at least 2 characters" },
        { status: 400 }
      );
    }

    const url = new URL(`${TMDB_BASE}/search/multi`);
    url.searchParams.set("api_key", TMDB_API_KEY);
    url.searchParams.set("query", query);
    url.searchParams.set("page", page);
    url.searchParams.set("include_adult", includeAdult ? "true" : "false");
    url.searchParams.set("language", "en-US");   // or pass from client
    url.searchParams.set("region", "IN");        // optional: improves relevance

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url.toString(), {
      signal: controller.signal,
      // Light caching to protect your key (adjust to taste)
      next: { revalidate: 60 },
      headers: { Accept: "application/json" },
    });
    clearTimeout(t);

    if (!res.ok) {
      return NextResponse.json({ error: `TMDb HTTP ${res.status}` }, { status: 502 });
    }

    const data = await res.json();

    // Split into groups and trim
    const grouped = { movie: [] as any[], tv: [] as any[], person: [] as any[] };
    for (const item of data.results ?? []) {
      if (item.media_type === "movie") grouped.movie.push(toBasic(item));
      else if (item.media_type === "tv") grouped.tv.push(toBasic(item));
      else if (item.media_type === "person") grouped.person.push(toBasic(item));
    }

    // Keep payload small for the command menu
    grouped.movie = grouped.movie.slice(0, 6);
    grouped.tv = grouped.tv.slice(0, 6);
    grouped.person = grouped.person.slice(0, 6);

    return NextResponse.json(grouped, {
      headers: {
        "CDN-Cache-Control": "public, max-age=60",
        "Vercel-CDN-Cache-Control": "public, max-age=60",
      },
    });
  } catch (e: any) {
    const aborted = e?.name === "AbortError";
    return NextResponse.json(
      { error: aborted ? "Upstream timeout" : e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
