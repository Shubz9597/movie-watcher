// Jikan is a public, read-only MyAnimeList API. It does not use API keys.
const JIKAN_BASE = 'https://api.jikan.moe/v4';
const JIKAN_CACHE_TTL_MS = 15 * 60 * 1000;
const JIKAN_STALE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const JIKAN_REQUEST_INTERVAL_MS = 400; // Official limit: 3 requests/second.
const JIKAN_STORAGE_PREFIX = 'movie-watcher:jikan:v1:';
const JIKAN_STORAGE_INDEX = `${JIKAN_STORAGE_PREFIX}index`;
const JIKAN_STORAGE_MAX_ENTRIES = 24;

const responseCache = new Map<string, { expiresAt: number; data: any }>();
const inFlight = new Map<string, Promise<any>>();
const animeItemCache = new Map<number, any>();
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

type StoredResponse = { savedAt: number; data: any };

function cacheAnimeItems(data: any) {
  const rows = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
  for (const item of rows) {
    const id = Number(item?.mal_id);
    if (Number.isInteger(id) && id > 0) animeItemCache.set(id, item);
  }
}

function storageKey(url: string) {
  return `${JIKAN_STORAGE_PREFIX}${encodeURIComponent(url)}`;
}

function readStoredResponse(url: string): StoredResponse | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const value = localStorage.getItem(storageKey(url));
    if (!value) return null;
    const parsed = JSON.parse(value) as StoredResponse;
    if (!Number.isFinite(parsed?.savedAt) || parsed.data == null) return null;
    if (Date.now() - parsed.savedAt > JIKAN_STALE_CACHE_TTL_MS) {
      localStorage.removeItem(storageKey(url));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredResponse(url: string, data: any) {
  if (typeof localStorage === 'undefined') return;
  const key = storageKey(url);
  try {
    const savedAt = Date.now();
    localStorage.setItem(key, JSON.stringify({ savedAt, data } satisfies StoredResponse));
    const existing = JSON.parse(localStorage.getItem(JIKAN_STORAGE_INDEX) || '[]') as Array<{
      key: string;
      savedAt: number;
    }>;
    const entries = [{ key, savedAt }, ...existing.filter((entry) => entry.key !== key)]
      .sort((left, right) => right.savedAt - left.savedAt);
    for (const entry of entries.slice(JIKAN_STORAGE_MAX_ENTRIES)) localStorage.removeItem(entry.key);
    localStorage.setItem(JIKAN_STORAGE_INDEX, JSON.stringify(entries.slice(0, JIKAN_STORAGE_MAX_ENTRIES)));
  } catch (error) {
    // Catalog caching is best-effort. A full or disabled localStorage must not break playback.
    console.warn('[Jikan] Could not persist the catalog cache.', error);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueRequest<T>(work: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    const waitMs = Math.max(0, JIKAN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (waitMs > 0) await delay(waitMs);
    lastRequestAt = Date.now();
    return work();
  });
  requestQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function requestJikan<T = any>(path: string): Promise<T> {
  const url = `${JIKAN_BASE}${path}`;
  const cached = responseCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.data as T;

  const stored = readStoredResponse(url);
  if (stored && Date.now() - stored.savedAt <= JIKAN_CACHE_TTL_MS) {
    cacheAnimeItems(stored.data);
    responseCache.set(url, { data: stored.data, expiresAt: stored.savedAt + JIKAN_CACHE_TTL_MS });
    return stored.data as T;
  }

  const pending = inFlight.get(url);
  if (pending) return pending as Promise<T>;

  const request = enqueueRequest(async () => {
    let lastStatus = 0;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, { headers: { Accept: 'application/json' } });
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await delay(750 * (attempt + 1));
          continue;
        }
        break;
      }
      lastStatus = response.status;
      if (response.ok) {
        const data = await response.json();
        cacheAnimeItems(data);
        responseCache.set(url, { data, expiresAt: Date.now() + JIKAN_CACHE_TTL_MS });
        writeStoredResponse(url, data);
        return data as T;
      }
      if (response.status !== 429 && response.status < 500) break;
      const retryAfterSeconds = Number(response.headers.get('retry-after') || 0);
      if (attempt < 2) {
        await delay(retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 750 * (attempt + 1));
      }
    }
    if (stored) {
      cacheAnimeItems(stored.data);
      responseCache.set(url, { data: stored.data, expiresAt: Date.now() + JIKAN_CACHE_TTL_MS });
      console.warn('[Jikan] Live API unavailable; using the last saved catalog response.');
      return stored.data as T;
    }
    throw new Error(lastStatus ? `Jikan HTTP ${lastStatus}` : `Jikan network error: ${String(lastError || 'unknown')}`);
  }).finally(() => {
    inFlight.delete(url);
  });

  inFlight.set(url, request);
  return request;
}

export async function getAnime(id: number) {
  try {
    const data = await requestJikan(`/anime/${id}/full`);
    return data.data;
  } catch (error) {
    const cached = animeItemCache.get(id);
    if (cached) {
      console.warn('[Jikan] Full detail endpoint failed; using cached catalog metadata.', error);
      return cached;
    }
    throw error;
  }
}
