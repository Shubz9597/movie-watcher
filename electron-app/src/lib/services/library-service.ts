// Library service boundary (feature 002). M2.2 ships the PRESENTATION only:
// the provider interface exists so the fixture implementation can be
// explicitly injected by the development entry. The server-backed provider
// (GET /v2/library/...) arrives with M3 persistence — until then NOTHING
// here writes, saves, or implies durability, and every consumer must render
// the provider's truthful source label ("Preview data").
import type { MovieCard } from '../types';
export type LibraryCollection = 'watch-later' | 'favourites';
export type LibraryMediaKind = 'movie' | 'series' | 'anime';

export type LibraryShelf = {
  kind: LibraryMediaKind;
  count: number;
  previews: MovieCard[];
};

export type LibraryOverview = {
  shelves: LibraryShelf[];
  /** Truthful source label rendered by consumers, e.g. "Preview data — not synced". */
  sourceLabel: string;
};

export type LibraryCategoryPageData = {
  items: MovieCard[];
  count: number;
  sourceLabel: string;
};

export interface LibraryProvider {
  overview(collection: LibraryCollection): Promise<LibraryOverview>;
  category(collection: LibraryCollection, kind: LibraryMediaKind): Promise<LibraryCategoryPageData>;
}
