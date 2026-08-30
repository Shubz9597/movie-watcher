const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const CINEMETA_TTL_MS = 3 * 60 * 60 * 1000;
const CINEMETA_TIMEOUT_MS = 6_000;

type CinemetaVideo = {
  season?: number | null;
  episode?: number | null;
  number?: number | null;
  thumbnail?: string | null;
  released?: string | null;
  firstAired?: string | null;
};

export type CinemetaEpisodeMetadata = {
  thumbnailUrl?: string;
  releasedAt?: string;
};

type CinemetaResponse = {
  meta?: {
    videos?: CinemetaVideo[] | null;
  } | null;
};

type CacheEntry = {
  expiresAt: number;
  data: CinemetaResponse;
};

const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CinemetaResponse>>();

function validImdbId(value?: string): value is string {
  return Boolean(value && /^tt\d+$/.test(value));
}

function safeThumbnailUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeReleasedAt(value?: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function getSeriesMeta(imdbId: string): Promise<CinemetaResponse> {
  const cached = responseCache.get(imdbId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const pending = inFlight.get(imdbId);
  if (pending) return pending;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), CINEMETA_TIMEOUT_MS);
    try {
      const response = await fetch(`${CINEMETA_BASE}/meta/series/${encodeURIComponent(imdbId)}.json`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Cinemeta HTTP ${response.status}`);

      const data = await response.json() as CinemetaResponse;
      responseCache.set(imdbId, { data, expiresAt: Date.now() + CINEMETA_TTL_MS });
      return data;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  })().finally(() => inFlight.delete(imdbId));

  inFlight.set(imdbId, request);
  return request;
}

export async function getCinemetaSeasonMetadata(
  imdbId: string | undefined,
  seasonNumber: number,
): Promise<Map<number, CinemetaEpisodeMetadata>> {
  if (!validImdbId(imdbId) || !Number.isInteger(seasonNumber) || seasonNumber < 0) {
    return new Map();
  }

  try {
    const data = await getSeriesMeta(imdbId);
    const episodes = new Map<number, CinemetaEpisodeMetadata>();
    for (const video of data.meta?.videos || []) {
      if (video.season !== seasonNumber) continue;
      const episodeNumber = video.episode ?? video.number;
      const thumbnail = safeThumbnailUrl(video.thumbnail);
      const releasedAt = safeReleasedAt(video.released || video.firstAired);
      if (Number.isInteger(episodeNumber) && Number(episodeNumber) > 0 && (thumbnail || releasedAt)) {
        episodes.set(Number(episodeNumber), {
          ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
          ...(releasedAt ? { releasedAt } : {}),
        });
      }
    }
    return episodes;
  } catch (error) {
    console.warn('[Cinemeta] Episode metadata is unavailable; keeping catalog metadata.', error);
    return new Map();
  }
}
