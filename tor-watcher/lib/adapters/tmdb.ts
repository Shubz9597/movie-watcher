import type {
  MovieCard,
  MovieDetail,
  TmdbMovie,
  TmdbMovieDetail,
} from "@/lib/types";
import { posterUrl, backdropUrl } from "@/lib/services/tmbd-service";

export function isNew(release_date?: string): boolean {
  if (!release_date) return false;
  const d = new Date(release_date);
  if (Number.isNaN(d.getTime())) return false;
  const diffDays = (Date.now() - d.getTime()) / 86_400_000;
  return diffDays <= 30;
}

export function toYear(release_date?: string): number | undefined {
  return release_date && release_date.length >= 4
    ? Number(release_date.slice(0, 4))
    : undefined;
}

export function toRating1dp(v?: number): number | undefined {
  return typeof v === "number"
    ? Number((Math.round(v * 10) / 10).toFixed(1))
    : undefined;
}

export function mapTmdbMovieToCard(m: TmdbMovie): MovieCard {
  return {
    id: m.id,
    title: m.title,
    posterPath: posterUrl(m.poster_path, "w500"),
    year: toYear(m.release_date),
    rating: toRating1dp(m.vote_average),
    isNew: isNew(m.release_date),
    originalLanguage: m.original_language,
    // topCast: [] // only if you choose to include it later
    tmdbRatingPct: typeof m.vote_average === "number" ? Math.round(m.vote_average * 10) : undefined,
    tmdbPopularity: typeof (m as any).popularity === "number" ? (m as any).popularity : undefined,
  };
}

export function mapTmdbDetailToMovieDetail(d: TmdbMovieDetail): MovieDetail {
  const trailerKey =
    d.videos?.results?.find(
      (v) => v.site === "YouTube" && v.type === "Trailer"
    )?.key ?? null;

  return {
    id: d.id,
    title: d.title,
    year: toYear(d.release_date),
    rating: toRating1dp(d.vote_average),
    overview: d.overview ?? "",
    backdropUrl: backdropUrl(d.backdrop_path, "w1280"),
    posterUrl: posterUrl(d.poster_path, "w500"),
    genres: Array.isArray(d.genres) ? d.genres.map((g) => g.name) : [],
    runtime: d.runtime ?? null,
    cast: d.credits?.cast?.slice(0, 6).map((c) => ({
      name: c.name,
      character: c.character,
    })),
    trailerKey,
    imdbId: d.imdb_id || undefined,
    torrents: [], // fill later
  };
}