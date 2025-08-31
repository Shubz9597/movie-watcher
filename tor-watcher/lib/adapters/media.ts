export type Card = {
  id: number;
  title: string;
  year?: number;
  posterPath?: string | null;
  backdropUrl?: string | null;
  overview?: string;
  rating?: number | null;            // 0..10
  tmdbRatingPct?: number | null;     // % badge (vote_average * 10 or MAL*10)
  tmdbPopularity?: number | null;
  originalLanguage?: string;
  isNew?: boolean;
};

export type Detail = {
  id: number;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  genres?: string[];
  runtime?: number | null;
  cast?: { name: string; character?: string }[];
  trailerKey?: string | null;

  imdbId?: string | undefined;       // undefined for anime
  originalLanguage?: string;
  tmdbPopularity?: number | null;
  tmdbRatingPct?: number | null;
  rating?: number | null;            // numeric fallback (0..10)
  imdbRating?: number | null;
  imdbVotes?: number | null;
};

const tmdbImg = (p?: string | null, size: "w342"|"w500"|"w780"|"w1280"|"original" = "w342") => p ? `https://image.tmdb.org/t/p/${size}${p}` : null;

// ---------- TMDB → Card ----------
export function cardFromTmdbMovie(it: any): Card {
  const vote = typeof it.vote_average === "number" ? it.vote_average : null;
  return {
    id: it.id,
    title: it.title,
    year: it.release_date ? Number(String(it.release_date).slice(0, 4)) : undefined,
    posterPath: tmdbImg(it.poster_path, "w342"),
    backdropUrl: tmdbImg(it.backdrop_path, "w780"),
    overview: it.overview,
    rating: vote,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    tmdbPopularity: typeof it.popularity === "number" ? it.popularity : null,
    originalLanguage: it.original_language,
    isNew: !!it.release_date && new Date(it.release_date) > new Date(Date.now() - 30*864e5),
  };
}

export function cardFromTmdbTv(it: any): Card {
  const vote = typeof it.vote_average === "number" ? it.vote_average : null;
  return {
    id: it.id,
    title: it.name,
    year: it.first_air_date ? Number(String(it.first_air_date).slice(0, 4)) : undefined,
    posterPath: tmdbImg(it.poster_path, "w342"),
    backdropUrl: tmdbImg(it.backdrop_path, "w780"),
    overview: it.overview,
    rating: vote,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    tmdbPopularity: typeof it.popularity === "number" ? it.popularity : null,
    originalLanguage: it.original_language,
    isNew: !!it.first_air_date && new Date(it.first_air_date) > new Date(Date.now() - 30*864e5),
  };
}

// ---------- Jikan → Card ----------
export function cardFromJikan(a: any): Card {
  const poster = a?.images?.jpg?.image_url || a?.images?.webp?.image_url || null;
  const backdrop = a?.trailer?.images?.maximum_image_url || a?.images?.jpg?.large_image_url || a?.images?.webp?.large_image_url || null;
  const score = typeof a?.score === "number" ? a.score : null;

  return {
    id: a.mal_id,
    title: a.title_english || a.title || a?.titles?.[0]?.title || "",
    year: a?.aired?.from ? new Date(a.aired.from).getFullYear() : undefined,
    posterPath: poster,
    backdropUrl: backdrop,
    overview: a.synopsis || "",
    rating: score,
    tmdbRatingPct: score != null ? Math.round(score * 10) : null, // reuse % badge
    tmdbPopularity: null,
    originalLanguage: undefined,
    isNew: !!a?.aired?.from && new Date(a.aired.from) > new Date(Date.now() - 30*864e5),
  };
}

// ---------- Details ----------
export function detailFromTmdbMovie(it: any): Detail {
  const trailer = Array.isArray(it.videos?.results)
    ? it.videos.results.find((v: any) => (v.type === "Trailer" || v.type === "Teaser") && v.site === "YouTube")
    : null;
  const vote = typeof it.vote_average === "number" ? it.vote_average : null;
  return {
    id: it.id,
    title: it.title,
    year: it.release_date ? Number(String(it.release_date).slice(0, 4)) : undefined,
    overview: it.overview,
    posterUrl: tmdbImg(it.poster_path, "w500"),
    backdropUrl: tmdbImg(it.backdrop_path, "w1280"),
    genres: Array.isArray(it.genres) ? it.genres.map((g: any) => g.name) : [],
    runtime: typeof it.runtime === "number" ? it.runtime : null,
    cast: Array.isArray(it.credits?.cast) ? it.credits.cast.slice(0, 16).map((c: any) => ({ name: c.name, character: c.character })) : [],
    trailerKey: trailer?.key ?? null,
    imdbId: it.external_ids?.imdb_id || undefined,
    originalLanguage: it.original_language,
    tmdbPopularity: typeof it.popularity === "number" ? it.popularity : null,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    rating: vote,
    imdbRating: null,
    imdbVotes: null,
  };
}

export function detailFromTmdbTv(it: any): Detail {
  const trailer = Array.isArray(it.videos?.results)
    ? it.videos.results.find((v: any) => (v.type === "Trailer" || v.type === "Teaser") && v.site === "YouTube")
    : null;
  const vote = typeof it.vote_average === "number" ? it.vote_average : null;
  return {
    id: it.id,
    title: it.name,
    year: it.first_air_date ? Number(String(it.first_air_date).slice(0, 4)) : undefined,
    overview: it.overview,
    posterUrl: tmdbImg(it.poster_path, "w500"),
    backdropUrl: tmdbImg(it.backdrop_path, "w1280"),
    genres: Array.isArray(it.genres) ? it.genres.map((g: any) => g.name) : [],
    runtime: Array.isArray(it.episode_run_time) && it.episode_run_time.length ? Number(it.episode_run_time[0]) : null,
    cast: Array.isArray(it.credits?.cast) ? it.credits.cast.slice(0, 16).map((c: any) => ({ name: c.name, character: c.character })) : [],
    trailerKey: trailer?.key ?? null,
    imdbId: it.external_ids?.imdb_id || undefined,
    originalLanguage: it.original_language,
    tmdbPopularity: typeof it.popularity === "number" ? it.popularity : null,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    rating: vote,
    imdbRating: null,
    imdbVotes: null,
  };
}

export function detailFromJikan(a: any): Detail {
  const poster = a?.images?.jpg?.image_url || a?.images?.webp?.image_url || null;
  const backdrop = a?.trailer?.images?.maximum_image_url || a?.images?.jpg?.large_image_url || a?.images?.webp?.large_image_url || null;
  const score = typeof a?.score === "number" ? a.score : null;
  return {
    id: a.mal_id,
    title: a.title_english || a.title || "",
    year: a?.aired?.from ? new Date(a.aired.from).getFullYear() : undefined,
    posterUrl: poster,
    backdropUrl: backdrop,
    overview: a.synopsis || "",
    genres: (a.genres || []).map((g: any) => g.name),
    runtime: null,
    cast: [],
    trailerKey: null,
    imdbId: undefined,
    originalLanguage: undefined,
    tmdbPopularity: null,
    tmdbRatingPct: score != null ? Math.round(score * 10) : null,
    rating: score,
    imdbRating: null,
    imdbVotes: null,
  };
}
