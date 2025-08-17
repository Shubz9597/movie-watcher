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
  genre_ids?: number[];
  original_language?: string;        // present in discover/search
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
  imdb_id?: string | null;
};

export type TmdbGenreList = {
  genres: TmdbGenre[];
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
  originalLanguage?: string;   // e.g. "en", "ja", etc.
  tmdbRatingPct?: number;      // 0–100, derived from vote_average
  tmdbPopularity?: number;     // optional, not shown by default
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
  torrents: Torrent[];
  imdbId?: string;
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

// --- Torrents / Prowlarr ---
export type TorrentItem = {
  title: string;
  link: string;
  magnet?: string;
  sizeBytes: number;
  indexer?: string;
  seeders?: number;
  leechers?: number;
  pubDate?: string;
  quality?: string;
  codec?: string;
};

export type TorrentSearchBody = {
  type: "movie" | "tv";
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  imdbId?: string;      // pass when available for better matches
  tmdbId?: number;      // optional, useful if you map tmdb->imdb later
  categories?: number[]; // override Torznab cats if needed
};

type categories = {
  id: number;
  name: string;
  subCategories?: categories[];
};

export type TorrentSearchResponse = {
age: number;
ageHours: number;
ageMinutes: number; 
categories: categories[];
fileName: string;
guid: string;
imdbId?: string;
indexer: string;
indexerFlags: string[];
indexerId: number;
infoHash: string;
infoUrl?: string; // optional, if not provided, use magnetUrl
leechers: number;
magnetUrl?: string; // optional, if not provided, use link
protocol: string; // "torrent" or "magnet"
publishDate: string; // ISO date string
seeders: number;
size: number; // in bytes
sortTitle: string; // normalized for sorting
title: string; // normalized title
tmdbId?: number; // optional, useful if you map tmdb->imdb later
tvMazeId?: number; // optional, useful if you map tmdb->tvmaze later
tvdbId?: number; // optional, useful if you map tmdb->tvdb later
}