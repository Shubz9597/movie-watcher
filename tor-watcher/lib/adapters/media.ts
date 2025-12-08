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
  altTitles?: string[];
};

const tmdbImg = (p?: string | null, size: "w342"|"w500"|"w780"|"w1280"|"original" = "w342") => p ? `https://image.tmdb.org/t/p/${size}${p}` : null;

type TmdbMovieItem = {
  id: number;
  title?: string;
  release_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
};

type TmdbTvItem = {
  id: number;
  name?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
};

type JikanAnimeItem = {
  mal_id: number;
  title?: string;
  title_english?: string;
  titles?: Array<{ title?: string }>;
  images?: {
    jpg?: { image_url?: string | null; large_image_url?: string | null };
    webp?: { image_url?: string | null; large_image_url?: string | null };
  };
  trailer?: { images?: { maximum_image_url?: string | null } };
  synopsis?: string;
  score?: number;
  aired?: { from?: string | null };
  genres?: Array<{ name?: string }>;
  title_japanese?: string;
  title_synonyms?: string[];
};

type TmdbMovieDetail = {
  id: number;
  title?: string;
  release_date?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
  genres?: Array<{ name?: string }>;
  runtime?: number;
  credits?: { cast?: Array<{ name?: string; character?: string }> };
  videos?: { results?: Array<{ type?: string; site?: string; key?: string }> };
  external_ids?: { imdb_id?: string | null };
};

type TmdbTvDetail = {
  id: number;
  name?: string;
  first_air_date?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
  genres?: Array<{ name?: string }>;
  episode_run_time?: number[];
  credits?: { cast?: Array<{ name?: string; character?: string }> };
  videos?: { results?: Array<{ type?: string; site?: string; key?: string }> };
  external_ids?: { imdb_id?: string | null };
};

// ---------- TMDB → Card ----------
export function cardFromTmdbMovie(it: TmdbMovieItem): Card {
  const vote = typeof it.vote_average === "number" ? it.vote_average : null;
  return {
    id: it.id,
    title: it.title ?? "",
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

export function cardFromTmdbTv(it: TmdbTvItem): Card {
  const vote = typeof it.vote_average === "number" ? it.vote_average : null;
  return {
    id: it.id,
    title: it.name ?? "",
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
export function cardFromJikan(a: JikanAnimeItem): Card {
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
export function detailFromTmdbMovie(it: Record<string, unknown> & { id: number }): Detail {
  const typedIt = it as TmdbMovieDetail;
  const trailer = Array.isArray(typedIt.videos?.results)
    ? typedIt.videos.results.find((v) => (v.type === "Trailer" || v.type === "Teaser") && v.site === "YouTube")
    : null;
  const vote = typeof typedIt.vote_average === "number" ? typedIt.vote_average : null;
  return {
    id: typedIt.id,
    title: typedIt.title ?? "",
    year: typedIt.release_date ? Number(String(typedIt.release_date).slice(0, 4)) : undefined,
    overview: typedIt.overview,
    posterUrl: tmdbImg(typedIt.poster_path, "w500"),
    backdropUrl: tmdbImg(typedIt.backdrop_path, "w1280"),
    genres: Array.isArray(typedIt.genres) ? typedIt.genres.map((g) => g.name).filter((n): n is string => Boolean(n)) : [],
    runtime: typeof typedIt.runtime === "number" ? typedIt.runtime : null,
    cast: Array.isArray(typedIt.credits?.cast) ? typedIt.credits.cast.slice(0, 16).map((c) => ({ name: c.name ?? "", character: c.character })) : [],
    trailerKey: trailer?.key ?? null,
    imdbId: typedIt.external_ids?.imdb_id || undefined,
    originalLanguage: typedIt.original_language,
    tmdbPopularity: typeof typedIt.popularity === "number" ? typedIt.popularity : null,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    rating: vote,
    imdbRating: null,
    imdbVotes: null,
  };
}

export function detailFromTmdbTv(it: Record<string, unknown> & { id: number }): Detail {
  const typedIt = it as TmdbTvDetail;
  const trailer = Array.isArray(typedIt.videos?.results)
    ? typedIt.videos.results.find((v) => (v.type === "Trailer" || v.type === "Teaser") && v.site === "YouTube")
    : null;
  const vote = typeof typedIt.vote_average === "number" ? typedIt.vote_average : null;
  return {
    id: typedIt.id,
    title: typedIt.name ?? "",
    year: typedIt.first_air_date ? Number(String(typedIt.first_air_date).slice(0, 4)) : undefined,
    overview: typedIt.overview,
    posterUrl: tmdbImg(typedIt.poster_path, "w500"),
    backdropUrl: tmdbImg(typedIt.backdrop_path, "w1280"),
    genres: Array.isArray(typedIt.genres) ? typedIt.genres.map((g) => g.name).filter((n): n is string => Boolean(n)) : [],
    runtime: Array.isArray(typedIt.episode_run_time) && typedIt.episode_run_time.length ? Number(typedIt.episode_run_time[0]) : null,
    cast: Array.isArray(typedIt.credits?.cast) ? typedIt.credits.cast.slice(0, 16).map((c) => ({ name: c.name ?? "", character: c.character })) : [],
    trailerKey: trailer?.key ?? null,
    imdbId: typedIt.external_ids?.imdb_id || undefined,
    originalLanguage: typedIt.original_language,
    tmdbPopularity: typeof typedIt.popularity === "number" ? typedIt.popularity : null,
    tmdbRatingPct: vote != null ? Math.round(vote * 10) : null,
    rating: vote,
    imdbRating: null,
    imdbVotes: null,
  };
}

function collectJikanTitles(a: Partial<JikanAnimeItem>): string[] {
  const titles = new Set<string>();
  const add = (val?: string | null) => {
    if (!val) return;
    const trimmed = val.trim();
    if (trimmed) titles.add(trimmed);
  };
  add(a?.title);
  add(a?.title_english);
  add(a?.title_japanese);
  if (Array.isArray(a?.titles)) {
    for (const entry of a.titles) add(entry?.title);
  }
  if (Array.isArray(a?.title_synonyms)) {
    for (const syn of a.title_synonyms) add(syn);
  }
  return Array.from(titles);
}

export function detailFromJikan(a: Partial<JikanAnimeItem> & { mal_id?: number }): Detail {
  const poster = a?.images?.jpg?.image_url || a?.images?.webp?.image_url || null;
  const backdrop = a?.trailer?.images?.maximum_image_url || a?.images?.jpg?.large_image_url || a?.images?.webp?.large_image_url || null;
  const score = typeof a?.score === "number" ? a.score : null;
  const altTitles = collectJikanTitles(a);
  return {
    id: a.mal_id ?? 0,
    title: a.title_english || a.title || "",
    year: a?.aired?.from ? new Date(a.aired.from).getFullYear() : undefined,
    posterUrl: poster,
    backdropUrl: backdrop,
    overview: a.synopsis || "",
    genres: (a.genres || []).map((g) => g.name).filter((n): n is string => Boolean(n)),
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
    altTitles,
  };
}
