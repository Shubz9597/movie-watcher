// Types for Electron app - standalone, no Next.js needed

export type MovieCard = {
  catalogId?: string;
  id: number;
  title: string;
  posterPath?: string | null;
  backdropUrl?: string | null;
  overview?: string;
  year?: number;
  rating?: number | null;
  isNew?: boolean;
  topCast?: string[];
  originalLanguage?: string;
  tmdbRatingPct?: number | null;
  tmdbPopularity?: number | null;
  genreIds?: number[];
  sourceProvider?: 'tmdb' | 'anilist';
  sourceKind?: 'movie' | 'tv' | 'anime';
  sourceLabel?: string;
  malId?: number | null;
  /** Provider release format (tv, movie, ova, ona, special). */
  format?: string;
  popularity?: number;
};

export type TorrentRow = {
  title: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  sourceId?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  indexer: string;
  publishDate?: string;
  fileIndex?: number;
  previouslyUsed?: boolean;
  reusedSeasonPack?: boolean;
  episodeMatch?: boolean;
  /** Parsed by the server from the release name. */
  quality?: string;
  source?: string;
  audio?: string;
  pack?: 'episode' | 'range' | 'season' | 'series';
  seasonPack?: {
    season?: number | null;
    reason?: string | null;
    keywords?: string[];
  } | null;
};

export type ResumeSourceContext = {
  subjectId: string;
  seriesId: string;
  season: number;
  episode: number;
};

export type SavedResumeSource = {
  sourceUri: string;
  sourceName: string;
  sourceKind: string;
  fileIndex?: number;
};



