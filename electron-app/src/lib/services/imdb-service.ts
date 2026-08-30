import { getVodBase } from '../api-client';

export type IMDbRating = {
  imdbId: string;
  rating: number;
  votes: number;
};

export async function getIMDbRating(imdbId: string): Promise<IMDbRating | null> {
  const response = await fetch(`${getVodBase()}/v1/imdb/ratings/${encodeURIComponent(imdbId)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(2_500),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`IMDb rating request failed (${response.status})`);
  }
  return response.json() as Promise<IMDbRating>;
}
