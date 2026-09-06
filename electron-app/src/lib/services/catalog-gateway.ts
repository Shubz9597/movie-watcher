// Catalog gateway (plan P5): the single dispatch layer between aggregation
// call sites and the catalog implementation. catalogSource=renderer routes to
// the untouched legacy provider services; catalogSource=bff routes to the
// /v2/catalog/* BFF client. No silent fallback: bff errors propagate.
import { getCatalogSource, type CatalogSource } from '../catalog-source.ts';
import { cardFromAniList, cardFromTmdbMovie, cardFromTmdbTv, type Card } from '../adapters/media.ts';
import { ensureServerCompatible } from '../version-check.ts';
import {
  backendTitleToCard,
  bffEpisodes,
  bffSearch,
  bffSectionPage,
} from './catalog-bff.ts';

export type GatewayDispatch = {
  // Forced source (tests / callers that resolved the flag already). When
  // omitted the runtime flag is consulted.
  source?: CatalogSource;
  fetchImpl?: typeof fetch;
};

// Legacy renderer services are loaded lazily: bff mode never imports them
// and pure node tests never trigger the legacy path (extensionless Vite
// imports are not resolvable under plain node ESM).
export type CatalogPage = { items: Card[]; totalPages?: number };

type Legacy = {
  searchMulti: typeof import('./tmdb-service').searchMulti;
  getMovies: typeof import('./tmdb-service').getMovies;
  getTvShows: typeof import('./tmdb-service').getTvShows;
  getTvSeason: typeof import('./tmdb-service').getTvSeason;
  getTitlesByGenre: typeof import('./tmdb-service').getTitlesByGenre;
  searchAnime: typeof import('./anilist-service').searchAnime;
  getTrendingAnime: typeof import('./anilist-service').getTrendingAnime;
  getAnimeList: typeof import('./anilist-service').getAnimeList;
  getCinemetaSeasonMetadata: typeof import('./cinemeta-service').getCinemetaSeasonMetadata;
  getAnimeEpisodeMetadata: typeof import('./anime-episode-metadata-service').getAnimeEpisodeMetadata;
};

let legacyPromise: Promise<Legacy> | null = null;

function loadLegacy(): Promise<Legacy> {
  legacyPromise ??= (async () => {
    const [tmdb, anilist, cinemeta, animeMeta] = await Promise.all([
      import('./tmdb-service'),
      import('./anilist-service'),
      import('./cinemeta-service'),
      import('./anime-episode-metadata-service'),
    ]);
    return {
      searchMulti: tmdb.searchMulti,
      getMovies: tmdb.getMovies,
      getTvShows: tmdb.getTvShows,
      getTvSeason: tmdb.getTvSeason,
      getTitlesByGenre: tmdb.getTitlesByGenre,
      searchAnime: anilist.searchAnime,
      getTrendingAnime: anilist.getTrendingAnime,
      getAnimeList: anilist.getAnimeList,
      getCinemetaSeasonMetadata: cinemeta.getCinemetaSeasonMetadata,
      getAnimeEpisodeMetadata: animeMeta.getAnimeEpisodeMetadata,
    };
  })();
  return legacyPromise;
}

async function route<T>(
  dispatch: GatewayDispatch | undefined,
  legacyImpl: Legacy | null,
  legacyFn: (legacy: Legacy) => Promise<T>,
  bffFn: () => Promise<T>,
): Promise<T> {
  const source: CatalogSource = dispatch?.source ?? (await getCatalogSource());
  if (source === 'bff') {
    // FR-011: the client decides compatibility from protocol ranges before
    // starting a workflow; health/version discovery is never gated.
    await ensureServerCompatible({ fetchImpl: dispatch?.fetchImpl });
    return bffFn();
  }
  const legacy = legacyImpl ?? (await loadLegacy());
  return legacyFn(legacy);
}

export function createCatalogGateway(options?: { legacy?: Legacy }) {
  const legacyOverride = options?.legacy ?? null;

  return {
    // TMDb multi search → unified rows grouped the way GlobalSearch consumes.
    async searchMulti(query: string, page = 1, dispatch?: GatewayDispatch) {
      return route(
        dispatch,
        legacyOverride,
        async (legacy) => {
          const result = await legacy.searchMulti(query, page);
          const toCard = (item: Card & { posterUrl?: string | null }): Card => ({ ...item, posterPath: item.posterUrl });
          return { movie: result.movie.map(toCard), tv: result.tv.map(toCard), anime: [] as Card[], person: result.person };
        },
        async () => {
          const rows = await bffSearch(query, 'all', 24, dispatch);
          const cards = rows.map(backendTitleToCard);
          return {
            movie: cards.filter((card) => card.sourceKind === 'movie'),
            tv: cards.filter((card) => card.sourceKind === 'tv'),
            anime: cards.filter((card) => card.sourceKind === 'anime'),
            person: [],
          };
        },
      );
    },

    async getMovies(page = 1, sort = 'trending', dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, legacyOverride, async (legacy) => {
        const data = await legacy.getMovies(page, sort);
        return { items: (data.results ?? []).map(cardFromTmdbMovie), totalPages: data.total_pages };
      }, async () => {
        const section = await bffSectionPage(sort, page, dispatch, 'movie');
        return {
          items: section.titles.filter((row) => row.type === 'movie').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async getTvShows(page = 1, sort = 'trending', dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, legacyOverride, async (legacy) => {
        const data = await legacy.getTvShows(page, sort);
        return { items: (data.results ?? []).map(cardFromTmdbTv), totalPages: data.total_pages };
      }, async () => {
        const section = await bffSectionPage(sort, page, dispatch, 'series');
        return {
          items: section.titles.filter((row) => row.type === 'series').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async getTrendingAnime(page = 1, perPage = 25, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, legacyOverride, async (legacy) => {
        const data = await legacy.getTrendingAnime(page, perPage);
        return { items: (data.media ?? []).map(cardFromAniList), totalPages: data.pageInfo?.lastPage ?? undefined };
      }, async () => {
        const section = await bffSectionPage('trending', page, dispatch, 'anime');
        return {
          items: section.titles.filter((row) => row.type === 'anime').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async getAnimeList(page = 1, perPage = 25, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, legacyOverride, async (legacy) => {
        const data = await legacy.getAnimeList(page, perPage);
        return { items: (data.media ?? []).map(cardFromAniList), totalPages: data.pageInfo?.lastPage ?? undefined };
      }, async () => {
        const section = await bffSectionPage('popular', page, dispatch, 'anime');
        return {
          items: section.titles.filter((row) => row.type === 'anime').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    // Genre rails (T042.5): renderer mode uses the tmdb discover service;
    // bff mode uses the additive genre section parameters.
    async getTitlesByGenre(kind: 'movie' | 'tv', genreId: number, page = 1, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, legacyOverride, async (legacy) => {
        const data = await legacy.getTitlesByGenre(kind, genreId, page);
        const toCard = kind === 'movie' ? cardFromTmdbMovie : cardFromTmdbTv;
        return { items: (data.results ?? []).map(toCard), totalPages: data.total_pages };
      }, async () => {
        const section = await bffSectionPage('popular', page, dispatch, kind === 'movie' ? 'movie' : 'series', genreId);
        return {
          items: section.titles
            .filter((row) => (kind === 'movie' ? row.type === 'movie' : row.type === 'series'))
            .map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async searchAnime(query: string, page = 1, perPage = 24, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, legacyOverride, async (legacy) => {
        const data = await legacy.searchAnime(query, page, perPage);
        return { items: (data.media ?? []).map(cardFromAniList), totalPages: data.pageInfo?.lastPage ?? undefined };
      }, async () => ({ items: (await bffSearch(query, 'anime', perPage, dispatch)).map(backendTitleToCard) }));
    },

    // Season episodes: tmdb ids keep their numeric id path; anilist/imdb ids
    // ride the opaque catalog id.
    async getTvSeason(tvId: number, season: number, dispatch?: GatewayDispatch) {
      return route(dispatch, legacyOverride, (legacy) => legacy.getTvSeason(tvId, season), async () => {
        const episodes = await bffEpisodes(`tmdb:${tvId}`, season, dispatch);
        return {
          id: Number(tvId),
          season_number: season,
          episodes: episodes.map((episode) => ({
            episode_number: episode.episode,
            season_number: episode.season,
            name: episode.title ?? '',
            air_date: episode.airDate ?? null,
            still_path: episode.still ?? null,
            overview: episode.overview ?? '',
            runtime: episode.duration_s ? Math.round(episode.duration_s / 60) : null,
          })),
        };
      });
    },

    async getCinemetaSeasonMetadata(imdbId: string | undefined, seasonNumber: number, dispatch?: GatewayDispatch) {
      return route(dispatch, legacyOverride, (legacy) => legacy.getCinemetaSeasonMetadata(imdbId, seasonNumber), async () => {
        if (!imdbId) return new Map();
        const episodes = await bffEpisodes(`imdb:${imdbId}`, seasonNumber, dispatch);
        const metadata = new Map<number, { thumbnailUrl: string; releasedAt: string }>();
        for (const episode of episodes) {
          metadata.set(episode.episode, {
            thumbnailUrl: episode.still ?? '',
            releasedAt: episode.airDate ?? '',
          });
        }
        return metadata;
      });
    },

    async getAnimeEpisodeMetadata(anilistId: number, dispatch?: GatewayDispatch) {
      return route(dispatch, legacyOverride, (legacy) => legacy.getAnimeEpisodeMetadata(anilistId), async () => {
        const episodes = await bffEpisodes(`anilist:${anilistId}`, 1, dispatch);
        const metadata = new Map<number, { stillUrl: string }>();
        for (const episode of episodes) {
          metadata.set(episode.episode, { stillUrl: episode.still ?? '' });
        }
        return metadata;
      });
    },
  };
}

// Default gateway: real legacy services (lazy) + real BFF client + runtime flag.
export const catalogGateway = createCatalogGateway();

// Named wrappers so call sites can import individual functions statically.
export const searchMulti = (query: string, page = 1, dispatch?: GatewayDispatch) =>
  catalogGateway.searchMulti(query, page, dispatch);
export const getMovies = (page = 1, sort = 'trending', dispatch?: GatewayDispatch) =>
  catalogGateway.getMovies(page, sort, dispatch);
export const getTvShows = (page = 1, sort = 'trending', dispatch?: GatewayDispatch) =>
  catalogGateway.getTvShows(page, sort, dispatch);
export const getTrendingAnime = (page = 1, perPage = 25, dispatch?: GatewayDispatch) =>
  catalogGateway.getTrendingAnime(page, perPage, dispatch);
export const getAnimeList = (page = 1, perPage = 25, dispatch?: GatewayDispatch) =>
  catalogGateway.getAnimeList(page, perPage, dispatch);
export const getTitlesByGenre = (kind: 'movie' | 'tv', genreId: number, page = 1, dispatch?: GatewayDispatch) =>
  catalogGateway.getTitlesByGenre(kind, genreId, page, dispatch);
export const searchAnime = (query: string, page = 1, perPage = 24, dispatch?: GatewayDispatch) =>
  catalogGateway.searchAnime(query, page, perPage, dispatch);
export const getTvSeason = (tvId: number, season: number, dispatch?: GatewayDispatch) =>
  catalogGateway.getTvSeason(tvId, season, dispatch);
export const getCinemetaSeasonMetadata = (imdbId: string | undefined, seasonNumber: number, dispatch?: GatewayDispatch) =>
  catalogGateway.getCinemetaSeasonMetadata(imdbId, seasonNumber, dispatch);
export const getAnimeEpisodeMetadata = (anilistId: number, dispatch?: GatewayDispatch) =>
  catalogGateway.getAnimeEpisodeMetadata(anilistId, dispatch);
