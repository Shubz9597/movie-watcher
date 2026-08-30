// TMDb API service - standalone, no Next.js needed
import { getAllConfig } from '../config';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const CATALOG_TTL_MS = 5 * 60 * 1000;
const DETAIL_TTL_MS = 15 * 60 * 1000;
const responseCache = new Map<string, { expiresAt: number; data: unknown }>();
const inFlight = new Map<string, Promise<unknown>>();

async function requestTmdb<T>(
  path: string,
  params: Record<string, string> = {},
  ttlMs = CATALOG_TTL_MS,
): Promise<T> {
  const cacheKey = `${path}?${new URLSearchParams(params).toString()}`;
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data as T;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending as Promise<T>;

  const request = (async () => {
    if (window.electronAPI?.requestTmdb) {
      const result = await window.electronAPI.requestTmdb<T>({ path, params });
      if (!result.ok) throw new Error(result.error || 'TMDb request failed.');
      responseCache.set(cacheKey, { data: result.data, expiresAt: Date.now() + ttlMs });
      return result.data as T;
    }

    const config = await getAllConfig();
    const accessToken = config.TMDB_ACCESS_TOKEN?.trim().replace(/^Bearer\s+/i, '');
    const apiKey = config.TMDB_API_KEY?.trim();
    if (!accessToken && !apiKey) throw new Error('Add a TMDb API key or read access token to continue.');

    const url = new URL(`${TMDB_BASE}${path}`);
    if (apiKey && !accessToken) url.searchParams.set('api_key', apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: HeadersInit = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`TMDb request failed (HTTP ${response.status}).`);
    const data = await response.json() as T;
    responseCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
    return data;
  })().finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, request);
  return request;
}

export async function searchMulti(query: string, page = 1) {
  try {
    const data = await requestTmdb<any>('/search/multi', {
      query,
      page: String(page),
      include_adult: 'false',
      language: 'en-US',
    });
    const IMG_BASE = 'https://image.tmdb.org/t/p/w185';
  
  const grouped = { movie: [] as any[], tv: [] as any[], person: [] as any[] };
  for (const item of data.results || []) {
    const basic = {
      id: item.id,
      title: item.media_type === 'movie' ? item.title : item.name,
      name: item.media_type === 'person' ? item.name : undefined,
      year: item.release_date || item.first_air_date 
        ? Number.parseInt((item.release_date || item.first_air_date).slice(0, 4), 10) 
        : undefined,
      rating: item.vote_average,
      posterUrl: item.poster_path || item.profile_path 
        ? `${IMG_BASE}${item.poster_path || item.profile_path}` 
        : null,
      originalLanguage: item.original_language,
      genreIds: Array.isArray(item.genre_ids) ? item.genre_ids : [],
      sourceProvider: 'tmdb' as const,
      sourceKind: item.media_type === 'movie' ? 'movie' as const : item.media_type === 'tv' ? 'tv' as const : undefined,
      sourceLabel: 'TMDB',
    };
    
    if (item.media_type === 'movie') grouped.movie.push(basic);
    else if (item.media_type === 'tv') grouped.tv.push(basic);
    else if (item.media_type === 'person') grouped.person.push(basic);
  }
  
    return grouped;
  } catch (err) {
    if (err instanceof Error && err.message.includes('not configured')) {
      throw err;
    }
    console.error('[TMDb] Search error:', err);
    throw err;
  }
}

function normalizedTitle(value: string) {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export async function findAnimeIMDbId(params: {
  title: string;
  aliases?: string[];
  year?: number;
  isMovie: boolean;
}) {
  const titles = [params.title, ...(params.aliases || [])]
    .map(normalizedTitle)
    .filter(Boolean);
  if (titles.length === 0) return undefined;

  const grouped = await searchMulti(params.title, 1);
  const candidates = params.isMovie ? grouped.movie : grouped.tv;
  const match = candidates.find((candidate) => {
    if (!Array.isArray(candidate.genreIds) || !candidate.genreIds.includes(16)) return false;
    if (!titles.includes(normalizedTitle(String(candidate.title || '')))) return false;
    return !params.year || !candidate.year || Math.abs(candidate.year - params.year) <= 1;
  });
  if (!match) return undefined;

  const detail = params.isMovie ? await getMovie(match.id) : await getTv(match.id);
  const imdbId = String(detail?.external_ids?.imdb_id || '').trim().toLocaleLowerCase();
  return /^tt\d{7,10}$/.test(imdbId) ? imdbId : undefined;
}

export async function getMovie(id: number) {
  return requestTmdb<any>(
    `/movie/${id}`,
    { append_to_response: 'external_ids,credits,videos' },
    DETAIL_TTL_MS,
  );
}

export async function getTv(id: number) {
  return requestTmdb<any>(
    `/tv/${id}`,
    { append_to_response: 'external_ids,credits,videos' },
    DETAIL_TTL_MS,
  );
}

export async function getMovies(page = 1, sort = 'trending') {
  const endpoint = sort === 'trending' ? '/trending/movie/week' : '/movie/popular';
  return requestTmdb<any>(endpoint, { page: String(page) });
}

export async function getTvShows(page = 1, sort = 'trending') {
  const endpoint = sort === 'trending' ? '/trending/tv/week' : '/tv/popular';
  return requestTmdb<any>(endpoint, { page: String(page) });
}

export async function getTitlesByGenre(kind: 'movie' | 'tv', genreId: number, page = 1) {
  return requestTmdb<any>(`/discover/${kind}`, {
    page: String(page),
    include_adult: 'false',
    language: 'en-US',
    sort_by: 'popularity.desc',
    with_genres: String(genreId),
  });
}

async function discoverAnime(mediaKind: 'movie' | 'tv', page = 1) {
  return requestTmdb<any>(`/discover/${mediaKind}`, {
    page: String(page),
    include_adult: 'false',
    language: 'en-US',
    sort_by: 'popularity.desc',
    with_genres: '16',
    with_original_language: 'ja',
  });
}

export function getAnimeMovies(page = 1) {
  return discoverAnime('movie', page);
}

export function getAnimeTvShows(page = 1) {
  return discoverAnime('tv', page);
}

export async function getTvSeason(tvId: number, season: number) {
  return requestTmdb<any>(`/tv/${tvId}/season/${season}`, {}, DETAIL_TTL_MS);
}



