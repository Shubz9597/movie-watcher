const ANIZIP_EPISODES_URL = 'https://api.ani.zip/mappings';
const ANIME_KITSU_META_BASE = 'https://anime-kitsu.strem.fun/meta/series';
const ANIZIP_TTL_MS = 15 * 60 * 1000;
const METADATA_TIMEOUT_MS = 6_000;

type AniZipEpisode = {
  image?: string | null;
};

type AniZipResponse = {
  episodes?: Record<string, AniZipEpisode> | null;
  mappings?: {
    kitsu_id?: number | null;
  } | null;
};

type KitsuVideo = {
  episode?: number | null;
  thumbnail?: string | null;
};

type KitsuResponse = {
  meta?: {
    videos?: KitsuVideo[] | null;
  } | null;
};

type AnimeEpisodeMetadata = {
  stillUrl: string;
};

type CacheEntry = {
  expiresAt: number;
  episodes: Map<number, AnimeEpisodeMetadata>;
};

const responseCache = new Map<number, CacheEntry>();
const inFlight = new Map<number, Promise<Map<number, AnimeEpisodeMetadata>>>();

function safeImageUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function fetchMetadata<T>(url: URL): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url.hostname} HTTP ${response.status}`);
    return await response.json() as T;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function getAnimeEpisodeMetadata(
  anilistId: number,
): Promise<Map<number, AnimeEpisodeMetadata>> {
  if (!Number.isInteger(anilistId) || anilistId <= 0) return new Map();

  const cached = responseCache.get(anilistId);
  if (cached && cached.expiresAt > Date.now()) return cached.episodes;

  const pending = inFlight.get(anilistId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const url = new URL(ANIZIP_EPISODES_URL);
      url.searchParams.set('anilist_id', String(anilistId));
      const data = await fetchMetadata<AniZipResponse>(url);
      const episodes = new Map<number, AnimeEpisodeMetadata>();
      for (const [episodeKey, episode] of Object.entries(data.episodes || {})) {
        if (!/^\d+$/.test(episodeKey)) continue;
        const episodeNumber = Number(episodeKey);
        const stillUrl = safeImageUrl(episode.image);
        if (episodeNumber > 0 && stillUrl) episodes.set(episodeNumber, { stillUrl });
      }

      const kitsuId = Number(data.mappings?.kitsu_id);
      if (Number.isInteger(kitsuId) && kitsuId > 0) {
        try {
          const kitsuUrl = new URL(`${ANIME_KITSU_META_BASE}/kitsu:${kitsuId}.json`);
          const kitsuData = await fetchMetadata<KitsuResponse>(kitsuUrl);
          for (const video of kitsuData.meta?.videos || []) {
            const episodeNumber = Number(video.episode);
            const stillUrl = safeImageUrl(video.thumbnail);
            if (Number.isInteger(episodeNumber) && episodeNumber > 0 && stillUrl) {
              episodes.set(episodeNumber, { stillUrl });
            }
          }
        } catch (error) {
          console.warn('[Anime Kitsu] Episode artwork is unavailable; using AniZip artwork.', error);
        }
      }

      responseCache.set(anilistId, {
        episodes,
        expiresAt: Date.now() + ANIZIP_TTL_MS,
      });
      return episodes;
    } catch (error) {
      console.warn('[AniZip] Anime episode artwork is unavailable; keeping placeholders.', error);
      return new Map();
    }
  })().finally(() => inFlight.delete(anilistId));

  inFlight.set(anilistId, request);
  return request;
}
