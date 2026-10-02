// Catalog gateway: the single dispatch layer between page call sites and the
// server's /v2/catalog/* contract. Every platform (desktop, browser, phone)
// reads the catalog through the TorWatch server; provider credentials never
// reach the client. Errors propagate so pages can show their error states.
import type { Card } from '../adapters/media.ts';
import { ensureServerCompatible } from '../version-check.ts';
import {
  backendTitleToCard,
  bffEpisodes,
  bffSearch,
  bffSectionPage,
} from './catalog-bff.ts';

export type GatewayDispatch = {
  fetchImpl?: typeof fetch;
};

export type CatalogPage = { items: Card[]; totalPages?: number };

// FR-011: the client decides compatibility from protocol ranges before
// starting a workflow; health/version discovery is never gated.
async function route<T>(dispatch: GatewayDispatch | undefined, run: () => Promise<T>): Promise<T> {
  await ensureServerCompatible({ fetchImpl: dispatch?.fetchImpl });
  return run();
}

export function createCatalogGateway() {
  return {
    // Multi search → unified rows grouped the way the search pages consume.
    // `page` is kept for call-site compatibility; the server returns one page.
    async searchMulti(query: string, _page = 1, dispatch?: GatewayDispatch) {
      return route(dispatch, async () => {
        const rows = await bffSearch(query, 'all', 24, dispatch);
        const cards = rows.map(backendTitleToCard);
        return {
          movie: cards.filter((card) => card.sourceKind === 'movie'),
          tv: cards.filter((card) => card.sourceKind === 'tv'),
          anime: cards.filter((card) => card.sourceKind === 'anime'),
          person: [],
        };
      });
    },

    async getMovies(page = 1, sort = 'trending', dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, async () => {
        const section = await bffSectionPage(sort, page, dispatch, 'movie');
        return {
          items: section.titles.filter((row) => row.type === 'movie').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async getTvShows(page = 1, sort = 'trending', dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, async () => {
        const section = await bffSectionPage(sort, page, dispatch, 'series');
        return {
          items: section.titles.filter((row) => row.type === 'series').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async getTrendingAnime(page = 1, _perPage = 25, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, async () => {
        const section = await bffSectionPage('trending', page, dispatch, 'anime');
        return {
          items: section.titles.filter((row) => row.type === 'anime').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async getAnimeList(page = 1, _perPage = 25, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, async () => {
        const section = await bffSectionPage('popular', page, dispatch, 'anime');
        return {
          items: section.titles.filter((row) => row.type === 'anime').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async getAnimeByGenre(genre: string, page = 1, _perPage = 25, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, async () => {
        const section = await bffSectionPage('popular', page, dispatch, 'anime', genre);
        return {
          items: section.titles.filter((row) => row.type === 'anime').map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    // Genre rails (T042.5) use the additive genre section parameters.
    async getTitlesByGenre(kind: 'movie' | 'tv', genreId: number, page = 1, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, async () => {
        const section = await bffSectionPage('popular', page, dispatch, kind === 'movie' ? 'movie' : 'series', genreId);
        return {
          items: section.titles
            .filter((row) => (kind === 'movie' ? row.type === 'movie' : row.type === 'series'))
            .map(backendTitleToCard),
          totalPages: section.totalPages,
        };
      });
    },

    async searchAnime(query: string, _page = 1, perPage = 24, dispatch?: GatewayDispatch): Promise<CatalogPage> {
      return route(dispatch, async () => ({ items: (await bffSearch(query, 'anime', perPage, dispatch)).map(backendTitleToCard) }));
    },

    // Season episodes: tmdb ids keep their numeric id path; anilist/imdb ids
    // ride the opaque catalog id. M3.1.1: requests use the media-qualified tv
    // id — the alias stays read-only for old clients.
    async getTvSeason(tvId: number, season: number, dispatch?: GatewayDispatch) {
      return route(dispatch, async () => {
        const episodes = await bffEpisodes(`tmdb:tv:${tvId}`, season, dispatch);
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
      return route(dispatch, async () => {
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
      return route(dispatch, async () => {
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

// Default gateway used by the pages.
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
export const getAnimeByGenre = (genre: string, page = 1, perPage = 25, dispatch?: GatewayDispatch) =>
  catalogGateway.getAnimeByGenre(genre, page, perPage, dispatch);
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
