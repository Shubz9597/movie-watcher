// lib/tmdb.ts
import "server-only";

const TMDB_BASE = "https://api.themoviedb.org/3";

// Auth: prefer Bearer; otherwise use API key on the URL
const bearer = process.env.TMDB_ACCESS_TOKEN;
const apiKey = process.env.TMDB_API_KEY;

function authHeaders(extra?: HeadersInit): HeadersInit {
  const base: Record<string, string> = { Accept: "application/json" };
  if (bearer) base.Authorization = `Bearer ${bearer}`;
  return { ...base, ...(extra as Record<string, string>) };
}

function withApiKey(url: string) {
  if (bearer) return url; // Bearer covers auth
  if (!apiKey) {
    throw new Error(
      "TMDB credentials missing. Set TMDB_ACCESS_TOKEN or TMDB_API_KEY in .env.local"
    );
  }
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}api_key=${apiKey}`;
}

/**
 * Minimal TMDB fetcher.
 * - No retries, no custom caches.
 * - Defaults to `no-store` (you can pass `next:{revalidate:N}` to opt into ISR).
 */
export async function tmdb<T>(
  path: string,
  init?: RequestInit & { next?: { revalidate?: number } }
): Promise<T> {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = withApiKey(`${TMDB_BASE}${normalized}`);

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      cache: init?.next?.revalidate ? "force-cache" : "no-store",
      headers: authHeaders(init?.headers),
    });
  } catch (err) {
    throw new Error(`TMDB network failure: ${(err as Error)?.message || err}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} ${res.statusText}: ${text}`);
  }

  return (await res.json()) as T;
}

/* ---------- Convenience helpers (kept minimal) ---------- */

export function posterUrl(path: string | null, size: "w342" | "w500" = "w500") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

export function backdropUrl(path: string | null, size: "w780" | "w1280" = "w1280") {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}

/* ---------- Optional: tiny typed wrappers you likely use ---------- */

export type MovieDetail = {
  id: number;
  title: string;
  overview: string | null;
  runtime: number | null;
  release_date: string | null;
  original_language: string;       // 👈 you wanted this
  vote_average: number;
  genres?: { id: number; name: string }[];
  poster_path: string | null;
  backdrop_path: string | null;
  imdb_id?: string | null;         // present when not using append_to_response? (varies)
};

export async function getMovieDetail(id: number) {
  // include external_ids to ensure imdb_id is available in one call
  return tmdb<MovieDetail & { external_ids?: { imdb_id?: string | null } }>(
    `/movie/${id}?append_to_response=external_ids`
  );
}

export async function searchMovie(query: string, year?: number) {
  const q = new URLSearchParams({ query });
  if (year) q.set("year", String(year));
  return tmdb<{ results: MovieDetail[] }>(`/search/movie?${q.toString()}`);
}