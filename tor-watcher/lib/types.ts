// lib/types.ts

/** ------------------------------
 * RAW TMDB TYPES (as returned by their API)
 * Keep these 1:1 with TMDB responses
 * ------------------------------ */

export type TmdbPaginated<T> = {
  page: number;
  total_pages: number;
  total_results?: number;
  results: T[];
};

export type TmdbGenre = { id: number; name: string };

export type TmdbMovie = {
  id: number;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview?: string;
  release_date?: string;       // "YYYY-MM-DD"
  vote_average?: number;       // 0-10 float
  genre_ids?: number[];        // present in discover/search
};

export type TmdbCast = {
  id: number;
  name: string;
  character?: string;
  order?: number;
  profile_path?: string | null;
};

export type TmdbVideo = {
  id: string;
  key: string;     // YouTube key
  site: "YouTube" | string;
  type: string;    // "Trailer" | "Teaser" | ...
  official?: boolean;
};

export type TmdbCredits = {
  cast: TmdbCast[];
};

export type TmdbVideos = {
  results: TmdbVideo[];
};

/** `append_to_response=images,credits,videos` */
export type TmdbMovieDetail = {
  id: number;
  title: string;
  poster_path: string | null;
  backdrop_path: string | null;
  overview?: string;
  release_date?: string;
  runtime?: number | null;
  vote_average?: number;
  genres?: TmdbGenre[];
  credits?: TmdbCredits;
  videos?: TmdbVideos;
};

/** ------------------------------
 * APP TYPES (UI-friendly view models)
 * ------------------------------ */

export type MovieCard = {
  id: number;
  title: string;
  posterPath: string | null;   // full CDN url or null (mapped)
  year?: number;               // 4-digit year
  rating?: number;             // 0–10, 1 decimal
  isNew?: boolean;             // computed (last 30 days)
  /** Optional: only if you decide to surface cast on cards */
  topCast?: string[];
};

export type CastMember = { name: string; character?: string };

export type MovieDetail = {
  id: number;
  title: string;
  year?: number;
  rating?: number;
  overview?: string;
  backdropUrl?: string | null;
  posterUrl?: string | null;
  genres?: string[];
  runtime?: number | null;
  cast?: CastMember[];
  trailerKey?: string | null;
  torrents: Torrent[]; // stays empty until you wire torrents
};

/** ------------------------------
 * OTHER APP TYPES
 * ------------------------------ */

export type Torrent = {
  quality: "720p" | "1080p" | "2160p" | "other";
  size: string;        // "2.1 GB"
  seeds: number;
  leeches: number;
  magnet: string;
  source?: string;
  audio?: string;
  subs?: string[];
};

export type Filters = {
  genreId: number;
  sort: "trending" | "rating" | "year" | "popularity";
  quality: "any" | "720p" | "1080p" | "2160p";
  yearRange: [number, number];
  torrentOnly: boolean;
  query: string;
};

export type Paginated<T> = {
  page: number;
  total_pages: number;
  results: T[];
};