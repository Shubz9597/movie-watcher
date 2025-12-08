export type SeasonSummary = {
  seasonNumber: number;
  name: string;
  episodeCount?: number | null;
  airDate?: string | null;
  posterUrl?: string | null;
};

export type EpisodeSummary = {
  id: number;
  name: string;
  overview?: string | null;
  stillUrl?: string | null;
  episodeNumber: number;
  seasonNumber: number;
  absoluteNumber?: number;
  airDate?: string | null;
  runtime?: number | null;
};



