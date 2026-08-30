// Title types - copied from Next.js
export type EpisodeSummary = {
  id: number;
  name: string;
  overview?: string;
  stillUrl?: string | null;
  episodeNumber: number;
  seasonNumber: number;
  airDate?: string | null;
  availableAt?: string | null;
  continuationAvailable?: boolean;
  runtime?: number | null;
  absoluteNumber?: number | null;
};

export type SeasonSummary = {
  seasonNumber: number;
  name: string;
  episodeCount?: number;
  airDate?: string | null;
  posterUrl?: string | null;
};



