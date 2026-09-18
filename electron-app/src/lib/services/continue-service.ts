// Continue watching service - standalone, no Next.js needed
import { getVodBase } from '../api-client';
import { getCatalogSource } from '../catalog-source';
import { bffTitleDetail, catalogIdForSeriesId, continueEnrichmentFromBackend } from './catalog-bff';
import type { ResumeSourceContext, SavedResumeSource } from '../types';

// Legacy provider services load lazily: bff mode never imports them and pure
// node tests never trigger the legacy path (T042.4).
type LegacyProviders = {
  getTmdbMovie: typeof import('./tmdb-service').getMovie;
  getTmdbTv: typeof import('./tmdb-service').getTv;
  getAniListAnime: typeof import('./anilist-service').getAnime;
  getAnimeByMalId: typeof import('./anilist-service').getAnimeByMalId;
};

let legacyPromise: Promise<LegacyProviders> | null = null;

function loadLegacy(): Promise<LegacyProviders> {
  legacyPromise ??= (async () => {
    const [tmdb, anilist] = await Promise.all([import('./tmdb-service'), import('./anilist-service')]);
    return {
      getTmdbMovie: tmdb.getMovie,
      getTmdbTv: tmdb.getTv,
      getAniListAnime: anilist.getAnime,
      getAnimeByMalId: anilist.getAnimeByMalId,
    };
  })();
  return legacyPromise;
}

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

async function fetchTmdbMovie(legacy: LegacyProviders, id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const data = await legacy.getTmdbMovie(Number(id));
    return {
      title: data.title || '',
      posterPath: data.poster_path ? `https://image.tmdb.org/t/p/w342${data.poster_path}` : null,
      year: data.release_date ? Number(data.release_date.slice(0, 4)) : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchTmdbTv(legacy: LegacyProviders, id: string): Promise<{ title: string; posterPath: string | null; year?: number } | null> {
  try {
    const data = await legacy.getTmdbTv(Number(id));
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
  legacy: LegacyProviders,
  id: string,
  provider: 'anilist' | 'mal',
): Promise<{ title: string; posterPath: string | null; year?: number; anilistId: number; malId?: number } | null> {
  try {
    const data = provider === 'anilist'
      ? await legacy.getAniListAnime(Number(id))
      : await legacy.getAnimeByMalId(Number(id));
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

// BFF-mode enrichment (T042.4): resolve the title through the catalog
// contract. Enrichment failures keep the raw seriesId as display fallback.
// Perf (mobile): Home mount fans out to one detail request per item; a
// pull-to-refresh repeats the burst seconds later. Enrichment metadata
// (title/poster/year) is stable, so a short TTL cache applies. Failures
// (nulls) are cached too — a doomed lookup should not re-fan-out.
const ENRICHMENT_TTL_MS = 300_000;
const enrichmentCache = new Map<string, { at: number; data: {
  title: string; posterPath: string | null; year?: number; anilistId?: number; malId?: number;
} | null }>();

async function fetchBffEnrichment(seriesId: string): Promise<{
  title: string; posterPath: string | null; year?: number; anilistId?: number; malId?: number;
} | null> {
  const cached = enrichmentCache.get(seriesId);
  if (cached && Date.now() - cached.at < ENRICHMENT_TTL_MS) return cached.data;
  if (cached) enrichmentCache.delete(seriesId);
  const catalogId = catalogIdForSeriesId(seriesId);
  let data: { title: string; posterPath: string | null; year?: number; anilistId?: number; malId?: number } | null = null;
  if (catalogId) {
    try {
      data = continueEnrichmentFromBackend(await bffTitleDetail(catalogId));
    } catch {
      data = null;
    }
  }
  enrichmentCache.set(seriesId, { at: Date.now(), data });
  return data;
}

async function enrichItem(item: RawContinueItem, useBff: boolean, legacy: LegacyProviders | null): Promise<EnrichedContinueItem> {
  const { provider, type, id } = parseSeriesId(item.seriesId);

  let metadata: { title: string; posterPath: string | null; year?: number; anilistId?: number; malId?: number } | null = null;
  let kind: 'movie' | 'tv' | 'anime' = 'tv';
  let tmdbId: number | undefined;
  let malId: number | undefined;
  let anilistId: number | undefined;

  if (provider === 'tmdb' && type === 'movie') {
    kind = 'movie';
    tmdbId = Number(id);
    metadata = useBff ? await fetchBffEnrichment(item.seriesId) : await fetchTmdbMovie(legacy!, id);
  } else if (provider === 'tmdb' && type === 'tv') {
    kind = 'tv';
    tmdbId = Number(id);
    metadata = useBff ? await fetchBffEnrichment(item.seriesId) : await fetchTmdbTv(legacy!, id);
  } else if (provider === 'mal' || provider === 'anilist') {
    kind = 'anime';
    metadata = useBff ? await fetchBffEnrichment(item.seriesId) : await fetchAniListAnime(legacy!, id, provider);
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

// Perf (mobile): concurrent getContinueList calls for the same subject (e.g.
// Strict Mode double-mount or rapid focus) share one request instead of
// firing the 1+12 network burst twice.
const continueInFlight = new Map<string, Promise<EnrichedContinueItem[]>>();

export async function getContinueList(subjectId: string, limit = 12): Promise<EnrichedContinueItem[]> {
  const key = `${subjectId}|${limit}`;
  const existing = continueInFlight.get(key);
  if (existing) return existing;
  let request!: Promise<EnrichedContinueItem[]>;
  request = getContinueListUncached(subjectId, limit).finally(() => {
    if (continueInFlight.get(key) === request) continueInFlight.delete(key);
  });
  continueInFlight.set(key, request);
  return request;
}

async function getContinueListUncached(subjectId: string, limit: number): Promise<EnrichedContinueItem[]> {
  try {
    const vodUrl = `${getVodBase()}/v1/continue?subjectId=${encodeURIComponent(subjectId)}&limit=${limit}`;
    const res = await fetch(vodUrl, { cache: 'no-store' });

    if (!res.ok) {
      return [];
    }

    const rawItems: RawContinueItem[] = await res.json();

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return [];
    }

    // Resolve the catalog flag once; legacy provider services load lazily
    // and only in renderer mode (T042.4).
    const useBff = await getCatalogSource() === 'bff';
    const legacy = useBff ? null : await loadLegacy();

    // Enrich items with metadata in parallel
    const enrichedItems = await Promise.all(rawItems.map((item) => enrichItem(item, useBff, legacy)));

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
    const response = await fetch(`${getVodBase()}/v1/resume/source?${query.toString()}`, { cache: 'no-store' });
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


