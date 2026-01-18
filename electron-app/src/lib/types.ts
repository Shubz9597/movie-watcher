// Types for Electron app - standalone, no Next.js needed

export type MovieCard = {
  id: number;
  title: string;
  posterPath: string | null;
  year?: number;
  rating?: number;
  isNew?: boolean;
  topCast?: string[];
  originalLanguage?: string;
  tmdbRatingPct?: number;
  tmdbPopularity?: number;
};

export type TorrentRow = {
  title: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  magnetUri?: string;
  torrentUrl?: string;
  downloadUrl?: string;
  infoHash?: string;
  indexer: string;
  publishDate?: string;
  episodeMatch?: boolean;
  seasonPack?: {
    season?: number | null;
    reason?: string | null;
    keywords?: string[];
  } | null;
};



