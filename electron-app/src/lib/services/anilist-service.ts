const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_STORAGE_KEY = 'movie-watcher:anilist:v1';
const ANILIST_CACHE_SCHEMA_VERSION = 2;
const ANILIST_STORAGE_MAX_ENTRIES = 40;
const ANILIST_STALE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ANILIST_REQUEST_TIMEOUT_MS = 8_000;

type AniListTitle = {
  english?: string | null;
  romaji?: string | null;
  native?: string | null;
  userPreferred?: string | null;
};

export type AniListMedia = {
  id: number;
  idMal?: number | null;
  title: AniListTitle;
  synonyms?: string[] | null;
  format?: string | null;
  status?: string | null;
  description?: string | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  endDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  season?: string | null;
  seasonYear?: number | null;
  episodes?: number | null;
  duration?: number | null;
  countryOfOrigin?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null; medium?: string | null } | null;
  bannerImage?: string | null;
  genres?: string[] | null;
  averageScore?: number | null;
  meanScore?: number | null;
  popularity?: number | null;
  trending?: number | null;
  isAdult?: boolean | null;
  siteUrl?: string | null;
  trailer?: { id?: string | null; site?: string | null } | null;
  externalLinks?: Array<{ site?: string | null; url?: string | null }> | null;
  nextAiringEpisode?: { episode?: number | null; airingAt?: number | null } | null;
  airingSchedule?: {
    nodes?: Array<{ episode?: number | null; airingAt?: number | null }> | null;
  } | null;
};

export type AniListPage = {
  pageInfo?: {
    total?: number | null;
    currentPage?: number | null;
    lastPage?: number | null;
    hasNextPage?: boolean | null;
    perPage?: number | null;
  } | null;
  media?: AniListMedia[] | null;
};

type CacheEntry = {
  savedAt: number;
  data: unknown;
};

const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

const CARD_FIELDS = `
  id
  idMal
  title { english romaji native userPreferred }
  synonyms
  format
  status
  description(asHtml: false)
  startDate { year month day }
  season
  seasonYear
  episodes
  duration
  countryOfOrigin
  coverImage { extraLarge large medium }
  bannerImage
  genres
  averageScore
  meanScore
  popularity
  trending
  isAdult
  siteUrl
  nextAiringEpisode { episode airingAt }
`;

const DETAIL_FIELDS = `
  ${CARD_FIELDS}
  endDate { year month day }
  trailer { id site }
  externalLinks { site url }
  airingSchedule(page: 1, perPage: 25) {
    nodes { episode airingAt }
  }
`;

function readStoredCache(): Record<string, CacheEntry> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(ANILIST_STORAGE_KEY) || '{}') as Record<string, CacheEntry>;
    const cutoff = Date.now() - ANILIST_STALE_TTL_MS;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, entry]) => Number.isFinite(entry?.savedAt) && entry.savedAt >= cutoff)
    );
  } catch {
    return {};
  }
}

function writeStoredCache(key: string, entry: CacheEntry) {
  if (typeof localStorage === 'undefined') return;
  try {
    const stored = readStoredCache();
    stored[key] = entry;
    const trimmed = Object.fromEntries(
      Object.entries(stored)
        .sort(([, left], [, right]) => right.savedAt - left.savedAt)
        .slice(0, ANILIST_STORAGE_MAX_ENTRIES)
    );
    localStorage.setItem(ANILIST_STORAGE_KEY, JSON.stringify(trimmed));
  } catch (error) {
    console.warn('[AniList] Could not persist response cache.', error);
  }
}

function storedEntry(key: string): CacheEntry | undefined {
  const memoryEntry = responseCache.get(key);
  if (memoryEntry) return memoryEntry;
  const entry = readStoredCache()[key];
  if (entry) responseCache.set(key, entry);
  return entry;
}

async function requestAniList<T>(
  operation: string,
  query: string,
  variables: Record<string, unknown>,
  ttlMs: number,
): Promise<T> {
  const cacheKey = `${ANILIST_CACHE_SCHEMA_VERSION}:${operation}:${JSON.stringify(variables)}`;
  const cached = storedEntry(cacheKey);
  if (cached && Date.now() - cached.savedAt <= ttlMs) return cached.data as T;

  const pending = inFlight.get(cacheKey);
  if (pending) return pending as Promise<T>;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), ANILIST_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`AniList HTTP ${response.status}`);

      const payload = await response.json() as {
        data?: T;
        errors?: Array<{ message?: string }>;
      };
      if (!payload.data || payload.errors?.length) {
        const message = payload.errors?.map((error) => error.message).filter(Boolean).join('; ');
        throw new Error(message || 'AniList returned no data');
      }

      const entry = { savedAt: Date.now(), data: payload.data } satisfies CacheEntry;
      responseCache.set(cacheKey, entry);
      writeStoredCache(cacheKey, entry);
      return payload.data;
    } catch (error) {
      if (cached) {
        console.warn('[AniList] Live request failed; using stale catalog data.', error);
        return cached.data as T;
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  })().finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, request);
  return request;
}

export async function getAnime(id: number): Promise<AniListMedia> {
  const data = await requestAniList<{ Media?: AniListMedia | null }>(
    'detail',
    `query AnimeDetail($id: Int!) { Media(id: $id, type: ANIME) { ${DETAIL_FIELDS} } }`,
    { id },
    24 * 60 * 60 * 1000,
  );
  if (!data.Media) throw new Error(`AniList anime ${id} was not found`);
  return data.Media;
}

export async function getAnimeByMalId(idMal: number): Promise<AniListMedia> {
  const data = await requestAniList<{ Media?: AniListMedia | null }>(
    'detail-by-mal',
    `query AnimeDetailByMal($idMal: Int!) { Media(idMal: $idMal, type: ANIME) { ${DETAIL_FIELDS} } }`,
    { idMal },
    24 * 60 * 60 * 1000,
  );
  if (!data.Media) throw new Error(`AniList anime for MAL ${idMal} was not found`);
  return data.Media;
}

export async function getTrendingAnime(page = 1, perPage = 25): Promise<AniListPage> {
  const data = await requestAniList<{ Page?: AniListPage | null }>(
    'trending',
    `query TrendingAnime($page: Int!, $perPage: Int!) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage lastPage hasNextPage perPage }
        media(type: ANIME, isAdult: false, sort: [TRENDING_DESC, POPULARITY_DESC]) { ${CARD_FIELDS} }
      }
    }`,
    { page, perPage },
    15 * 60 * 1000,
  );
  return data.Page || { media: [] };
}

export async function getAnimeList(page = 1, perPage = 25): Promise<AniListPage> {
  const data = await requestAniList<{ Page?: AniListPage | null }>(
    'popular',
    `query PopularAnime($page: Int!, $perPage: Int!) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage lastPage hasNextPage perPage }
        media(type: ANIME, isAdult: false, sort: [POPULARITY_DESC, SCORE_DESC]) { ${CARD_FIELDS} }
      }
    }`,
    { page, perPage },
    60 * 60 * 1000,
  );
  return data.Page || { media: [] };
}

export async function searchAnime(queryText: string, page = 1, perPage = 24): Promise<AniListPage> {
  const search = queryText.trim();
  if (!search) return { media: [] };
  const data = await requestAniList<{ Page?: AniListPage | null }>(
    'search',
    `query SearchAnime($search: String!, $page: Int!, $perPage: Int!) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage lastPage hasNextPage perPage }
        media(search: $search, type: ANIME, isAdult: false, sort: [SEARCH_MATCH, POPULARITY_DESC]) { ${CARD_FIELDS} }
      }
    }`,
    { search, page, perPage },
    10 * 60 * 1000,
  );
  return data.Page || { media: [] };
}
