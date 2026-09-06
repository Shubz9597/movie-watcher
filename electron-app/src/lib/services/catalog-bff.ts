// BFF catalog client (plan P5): maps the renderer's card/detail/episode
// shapes onto the versioned /v2/catalog/* contract
// (specs/001-build-torwatch-version/contracts/v2-catalog-api.md).
// No silent fallback: provider failures surface as CatalogBffError — the
// renderer provider code is NOT called in bff mode.
import { buildBackendUrl } from '../api-client.ts';
import { backendGeneration, trackAbort } from '../connection-service.ts';
import { getDeviceId } from '../device-id.ts';
import type { Card } from '../adapters/media';

export type BffDeps = { fetchImpl?: typeof fetch };

export class CatalogBffError extends Error {
  code: string;
  degradedProviders: string[];

  constructor(code: string, message: string, degradedProviders: string[] = []) {
    super(message);
    this.name = 'CatalogBffError';
    this.code = code;
    this.degradedProviders = degradedProviders;
  }
}

type BffTitle = {
  id: string;
  type: 'movie' | 'series' | 'anime';
  title: string;
  originalTitle?: string;
  year?: number;
  overview?: string;
  artwork?: Record<string, string>;
  providerIds?: Record<string, string>;
  imdbId?: string;
  mergedFrom?: string[];
  // Detail-only enrichment (contracts/v2-catalog-api.md §title detail):
  runtime?: number;
  genres?: string[];
  externalLinks?: Record<string, string>;
  ratings?: { imdb?: { rating?: number; votes?: number; imdbId?: string } };
  seasons?: BffSeason[];
};

export type BffSeason = {
  number: number;
  name?: string;
  episodeCount?: number;
  airDate?: string;
  poster?: string;
};

type BffEpisode = {
  id: string;
  season: number;
  episode: number;
  title?: string;
  airDate?: string;
  still?: string;
  overview?: string;
  duration_s?: number;
  providerIds?: Record<string, string>;
};

async function catalogFetch<T>(path: string, deps?: BffDeps): Promise<T> {
  const doFetch = deps?.fetchImpl ?? fetch.bind(globalThis);
  // Origin-switch guard (M1.2): a request started on one server origin is
  // aborted on switch, and a response that raced the switch is discarded
  // instead of being applied to the new origin's state.
  const startedGeneration = backendGeneration();
  const controller = new AbortController();
  const unregister = deps?.fetchImpl ? undefined : trackAbort(controller);
  let response: Response;
  try {
    response = await doFetch(buildBackendUrl(path), {
      headers: { Accept: 'application/json' },
      signal: deps?.fetchImpl ? undefined : controller.signal,
    });
  } catch (error) {
    if (!deps?.fetchImpl && backendGeneration() !== startedGeneration) {
      throw new CatalogBffError('origin_changed', 'The server origin changed while this request was in flight.');
    }
    throw new CatalogBffError('backend_unreachable', `catalog backend unreachable: ${String(error)}`);
  } finally {
    unregister?.();
  }
  if (backendGeneration() !== startedGeneration) {
    throw new CatalogBffError('origin_changed', 'The server origin changed while this request was in flight; its response was discarded.');
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body = (payload ?? {}) as { error?: { code?: string; message?: string; degradedProviders?: string[] } };
    throw new CatalogBffError(
      body.error?.code ?? `http_${response.status}`,
      body.error?.message ?? `catalog request failed with status ${response.status}`,
      body.error?.degradedProviders ?? [],
    );
  }
  return payload as T;
}

function withClientId(path: string): string {
  const clientId = getDeviceId();
  if (!clientId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}clientId=${encodeURIComponent(clientId)}`;
}

export function canonicalProviderOf(row: BffTitle): string {
  const merged = row.mergedFrom ?? [];
  if (merged.length > 0) return merged[0];
  const namespace = row.id.split(':', 1)[0];
  return namespace || 'tmdb';
}

export function sourceKindOf(type: BffTitle['type']): 'movie' | 'tv' | 'anime' {
  if (type === 'movie') return 'movie';
  if (type === 'series') return 'tv';
  return 'anime';
}

// backendTitleToCard maps a contract Title row onto the renderer Card shape.
// Preserve provider-aware navigation IDs alongside the opaque catalog ID.
// Anime routes use AniList IDs when available, including merged titles.
export function backendTitleToCard(row: BffTitle): Card {
  const providerIds = row.providerIds ?? {};
  // Existing anime routes take AniList IDs, including for merged titles.
  const canonical = row.type === 'anime' && providerIds.anilist ? 'anilist' : canonicalProviderOf(row);
  const externalID = providerIds[canonical] ?? row.id.split(':').slice(1).join(':');
  const numericID = Number(externalID);
  return {
    id: Number.isFinite(numericID) && /^\d+$/.test(externalID ?? '') ? numericID : 0,
    title: row.title ?? '',
    year: row.year,
    posterPath: row.artwork?.poster ?? null,
    backdropUrl: row.artwork?.background ?? null,
    overview: row.overview,
    rating: null,
    tmdbRatingPct: null,
    tmdbPopularity: null,
    originalLanguage: undefined,
    genreIds: [],
    sourceProvider: canonical as Card['sourceProvider'],
    sourceKind: sourceKindOf(row.type),
    sourceLabel: canonical.toUpperCase(),
    malId: providerIds.jikan ? Number(providerIds.jikan) : null,
    // bff-mode extensions (not part of the V1 Card contract):
    catalogId: row.id,
    providerIds,
  } as Card;
}

export async function bffSearch(
  query: string,
  type: 'movie' | 'series' | 'anime' | 'all' = 'all',
  limit = 24,
  deps?: BffDeps,
): Promise<BffTitle[]> {
  const payload = await catalogFetch<{ results: BffTitle[] }>(
    withClientId(`/v2/catalog/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}&limit=${limit}`),
    deps,
  );
  return payload.results ?? [];
}

// catalogIdPathSegment percent-encodes the id but keeps ":" literal — the
// contract path form is /v2/catalog/titles/{provider}:{externalId}.
function catalogIdPathSegment(catalogId: string): string {
  return encodeURIComponent(catalogId).replace(/%3A/g, ':');
}

export async function bffTitleDetail(catalogId: string, deps?: BffDeps): Promise<BffTitle> {
  return catalogFetch<BffTitle>(withClientId(`/v2/catalog/titles/${catalogIdPathSegment(catalogId)}`), deps);
}

// catalogIdForSeriesId maps a progress seriesId ("tmdb:movie:123",
// "tmdb:tv:456", "anilist:789", "mal:1011") onto its opaque catalog id for
// bff-mode enrichment (T042.4). Unknown shapes return null; the caller keeps
// the raw seriesId as display fallback.
export function catalogIdForSeriesId(seriesId: string): string | null {
  const parts = seriesId.split(':');
  if (parts.length === 3 && parts[0] === 'tmdb' && (parts[1] === 'movie' || parts[1] === 'tv')) {
    return /^\d+$/.test(parts[2]) ? `tmdb:${parts[2]}` : null;
  }
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    if (parts[0] === 'anilist') return `anilist:${parts[1]}`;
    if (parts[0] === 'mal') return `jikan:${parts[1]}`;
  }
  return null;
}

export type ContinueEnrichment = {
  title: string;
  posterPath: string | null;
  year?: number;
  anilistId?: number;
  malId?: number;
};

// continueEnrichmentFromBackend maps a BFF title detail onto the enrichment
// shape the continue-watching renderer consumed from provider services.
export function continueEnrichmentFromBackend(row: BffTitle): ContinueEnrichment | null {
  if (!row || !row.title) return null;
  const providerIds = row.providerIds ?? {};
  const anilistId = Number(providerIds.anilist);
  const malId = Number(providerIds.jikan);
  return {
    title: row.title,
    posterPath: row.artwork?.poster ?? null,
    year: row.year,
    anilistId: Number.isFinite(anilistId) && anilistId > 0 ? anilistId : undefined,
    malId: Number.isFinite(malId) && malId > 0 ? malId : undefined,
  };
}

export async function bffEpisodes(catalogId: string, season: number, deps?: BffDeps): Promise<BffEpisode[]> {
  const payload = await catalogFetch<{ episodes: BffEpisode[] }>(
    withClientId(`/v2/catalog/titles/${catalogIdPathSegment(catalogId)}/episodes?season=${season}`),
    deps,
  );
  return payload.episodes ?? [];
}

// Provider sections include the summaries already fetched by the backend.
// Filter before limiting so one media kind cannot crowd another out of its rail.
export async function bffSection(
  kind: string, limit = 12, deps?: BffDeps, type?: BffTitle['type'], page = 1,
): Promise<BffTitle[]> {
  // Sections are currently a single curated page, not a pageable provider feed.
  if (page > 1) return [];
  const section = await bffSectionPage(kind, page, deps, type);
  return section.titles
    .filter((title) => !type || title.type === type)
    .slice(0, limit);
}

export type BffSectionPage = { titles: BffTitle[]; page: number; totalPages?: number };

// bffSectionPage requests one section page. page 1 without a genre keeps the
// original curated URL; paged/genre requests use the additive contract
// parameters (T042.1: page 1-500, genre + type movie|series).
export async function bffSectionPage(
  kind: string, page = 1, deps?: BffDeps, type?: BffTitle['type'], genreId?: number,
): Promise<BffSectionPage> {
  const params = new URLSearchParams({ kind });
  if (page > 1) params.set('page', String(page));
  if (genreId != null) {
    params.set('genre', String(genreId));
    params.set('type', type === 'series' ? 'series' : 'movie');
  }
  const payload = await catalogFetch<{
    results: BffTitle[];
    page?: number;
    totalPages?: number;
  }>(withClientId(`/v2/catalog/sections?${params.toString()}`), deps);
  if (!Array.isArray(payload?.results)) {
    throw new CatalogBffError('unsupported_capability', 'Update the TorWatch backend to load catalog sections with title summaries.');
  }
  return {
    titles: payload.results,
    page: payload.page ?? page,
    totalPages: payload.totalPages,
  };
}
