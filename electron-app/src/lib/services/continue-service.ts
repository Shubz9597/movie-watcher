// Continue watching service - standalone, no Next.js needed
import { getMovie as getTmdbMovie, getTv as getTmdbTv } from './tmdb-service';
import { getAnime as getAniListAnime, getAnimeByMalId } from './anilist-service';
import type { ResumeSourceContext, SavedResumeSource } from '../types';

const VOD_BASE = 'http://localhost:4001';

type RawContinueItem = {
  seriesId: string;
  season: number;
  episode: number;
  position_s: number;
  duration_s: number;
  percent: number;
  updated_at: string;
  sourceAvailable: boolean;
  sourceName?: string;
};

export type EnrichedContinueItem = RawContinueItem & {
  title: string;
  posterPath: string | null;
  year?: number;
  kind: 'movie' | 'tv' | 'anime';
  tmdbId?: number;
  malId?: number;
  anilistId?: number;
  upNext: boolean;
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

async function fetchAniListAnime(
  id: string,
  provider: 'anilist' | 'mal',
): Promise<{ title: string; posterPath: string | null; year?: number; anilistId: number; malId?: number } | null> {
  try {
    const data = provider === 'anilist'
      ? await getAniListAnime(Number(id))
      : await getAnimeByMalId(Number(id));
    if (!data) return null;
    return {
      title: data.title?.english || data.title?.userPreferred || data.title?.romaji || '',
      posterPath: data.coverImage?.large || data.coverImage?.extraLarge || data.coverImage?.medium || null,
      year: data.startDate?.year || undefined,
      anilistId: data.id,
      malId: data.idMal || undefined,
    };
  } catch {
    return null;
  }
}

async function enrichItem(item: RawContinueItem): Promise<EnrichedContinueItem> {
  const { provider, type, id } = parseSeriesId(item.seriesId);

  let metadata: { title: string; posterPath: string | null; year?: number; anilistId?: number; malId?: number } | null = null;
  let kind: 'movie' | 'tv' | 'anime' = 'tv';
  let tmdbId: number | undefined;
  let malId: number | undefined;
  let anilistId: number | undefined;

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
    metadata = await fetchAniListAnime(id, provider);
    malId = metadata?.malId || (provider === 'mal' ? Number(id) : undefined);
    anilistId = metadata?.anilistId || (provider === 'anilist' ? Number(id) : undefined);
  }

  return {
    ...item,
    title: metadata?.title || item.seriesId,
    posterPath: metadata?.posterPath || null,
    year: metadata?.year,
    kind,
    tmdbId,
    malId,
    anilistId,
    upNext: item.position_s === 0 && item.duration_s === 0 && item.percent === 0,
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

export type SavedResumeSourceResult =
  | { found: true; source: SavedResumeSource }
  | { found: false; reason: string };

export async function getSavedResumeSource(context: ResumeSourceContext): Promise<SavedResumeSourceResult> {
  const query = new URLSearchParams({
    subjectId: context.subjectId,
    seriesId: context.seriesId,
    season: String(context.season),
    episode: String(context.episode),
  });
  try {
    const response = await fetch(`${VOD_BASE}/v1/resume/source?${query.toString()}`, { cache: 'no-store' });
    if (!response.ok) return { found: false, reason: `source_${response.status}` };
    const data = await response.json();
    if (data?.found !== true || typeof data?.sourceUri !== 'string' || !data.sourceUri) {
      return { found: false, reason: 'saved_source_missing' };
    }
    const parsedFileIndex = Number(data.fileIndex);
    return {
      found: true,
      source: {
        sourceUri: data.sourceUri,
        sourceName: data.sourceName || 'Previously used source',
        sourceKind: data.sourceKind || '',
        fileIndex: Number.isInteger(parsedFileIndex) && parsedFileIndex >= 0 ? parsedFileIndex : undefined,
      },
    };
  } catch {
    return { found: false, reason: 'source_lookup_failed' };
  }
}


