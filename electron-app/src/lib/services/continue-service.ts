// Continue watching service - standalone, no Next.js needed
import { getConfig } from '../config';
import { getMovie as getTmdbMovie, getTv as getTmdbTv } from './tmdb-service';
import { getAnime as getJikanAnime } from './jikan-service';

const VOD_BASE = 'http://localhost:4001';

type RawContinueItem = {
  seriesId: string;
  season: number;
  episode: number;
  position_s: number;
  duration_s: number;
  percent: number;
  updated_at: string;
};

export type EnrichedContinueItem = RawContinueItem & {
  title: string;
  posterPath: string | null;
  year?: number;
  kind: 'movie' | 'tv' | 'anime';
  tmdbId?: number;
  malId?: number;
};

function parseSeriesId(seriesId: string): { provider: string; type: string; id: string } {
  const parts = seriesId.split(':');
  if (parts.length === 3) {
    return { provider: parts[0], type: parts[1], id: parts[2] };
  } else if (parts.length === 2) {
    return { provider: parts[0], type: 'anime', id: parts[1] };
  }
  return { provider: 'unknown', type: 'unknown', id: seriesId };
}

async function fetchTmdbMovie(id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const data = await getTmdbMovie(Number(id));
    return {
      title: data.title || '',
      posterPath: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      year: data.release_date ? Number(data.release_date.slice(0, 4)) : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchTmdbTv(id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const data = await getTmdbTv(Number(id));
    return {
      title: data.name || '',
      posterPath: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      year: data.first_air_date ? Number(data.first_air_date.slice(0, 4)) : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchJikanAnime(id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const data = await getJikanAnime(Number(id));
    if (!data) return null;
    return {
      title: data.title_english || data.title || '',
      posterPath: data.images?.jpg?.image_url || data.images?.webp?.image_url || null,
      year: data.aired?.from ? new Date(data.aired.from).getFullYear() : undefined,
    };
  } catch {
    return null;
  }
}

async function enrichItem(item: RawContinueItem): Promise<EnrichedContinueItem> {
  const { provider, type, id } = parseSeriesId(item.seriesId);

  let metadata: { title: string; posterPath: string | null; year?: number } | null = null;
  let kind: 'movie' | 'tv' | 'anime' = 'tv';
  let tmdbId: number | undefined;
  let malId: number | undefined;

  if (provider === 'tmdb' && type === 'movie') {
    kind = 'movie';
    tmdbId = Number(id);
    metadata = await fetchTmdbMovie(id);
  } else if (provider === 'tmdb' && type === 'tv') {
    kind = 'tv';
    tmdbId = Number(id);
    metadata = await fetchTmdbTv(id);
  } else if (provider === 'mal' || provider === 'anilist') {
    kind = 'anime';
    if (provider === 'mal') {
      malId = Number(id);
      metadata = await fetchJikanAnime(id);
    }
  }

  return {
    ...item,
    title: metadata?.title || item.seriesId,
    posterPath: metadata?.posterPath || null,
    year: metadata?.year,
    kind,
    tmdbId,
    malId,
  };
}

export async function getContinueList(subjectId: string, limit = 12): Promise<EnrichedContinueItem[]> {
  try {
    const vodUrl = `${VOD_BASE}/v1/continue?subjectId=${encodeURIComponent(subjectId)}&limit=${limit}`;
    const res = await fetch(vodUrl, { cache: 'no-store' });

    if (!res.ok) {
      return [];
    }

    const rawItems: RawContinueItem[] = await res.json();

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return [];
    }

    // Enrich items with metadata in parallel
    const enrichedItems = await Promise.all(rawItems.map(enrichItem));

    return enrichedItems;
  } catch (e) {
    return [];
  }
}


