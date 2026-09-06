// Fixture library provider (feature 002 M2.2) — EXPLICITLY ISOLATED PREVIEW
// DATA. It exists so the Library surfaces can be designed before M3
// implements persistence. It is injected only by the development browser
// entry; it never writes, never contacts a server, and its source label
// makes clear that nothing is saved or synced.
import type { MovieCard } from '../lib/types';
import type {
  LibraryCollection,
  LibraryMediaKind,
  LibraryOverview,
  LibraryProvider,
} from '../lib/services/library-service';

export const LIBRARY_PREVIEW_LABEL = 'Preview data — not synced or saved';

const CARDS: Record<string, MovieCard> = {
  frieren: {
    id: 154587, title: 'Frieren: Beyond Journey\'s End', year: 2023,
    posterPath: 'https://image.tmdb.org/t/p/w342/dqZENchTd7lp5zht7BdlqM7RBhD.jpg',
    sourceProvider: 'anilist', sourceKind: 'anime', sourceLabel: 'ANILIST',
  },
  dune2: {
    id: 693134, title: 'Dune: Part Two', year: 2024,
    posterPath: 'https://image.tmdb.org/t/p/w342/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg',
    sourceProvider: 'tmdb', sourceKind: 'movie', sourceLabel: 'TMDB',
  },
  breakingBad: {
    id: 1396, title: 'Breaking Bad', year: 2008,
    posterPath: 'https://image.tmdb.org/t/p/w342/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
    sourceProvider: 'tmdb', sourceKind: 'tv', sourceLabel: 'TMDB',
  },
  dune1: {
    id: 438631, title: 'Dune', year: 2021,
    posterPath: 'https://image.tmdb.org/t/p/w342/d5NXSklXo0qyIYkgV94XAgMIckC.jpg',
    sourceProvider: 'tmdb', sourceKind: 'movie', sourceLabel: 'TMDB',
  },
  blade2049: {
    id: 335984, title: 'Blade Runner 2049', year: 2017,
    posterPath: 'https://image.tmdb.org/t/p/w342/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg',
    sourceProvider: 'tmdb', sourceKind: 'movie', sourceLabel: 'TMDB',
  },
  simpsons: {
    id: 456, title: 'The Simpsons', year: 1989,
    // No artwork in the fixture: exercises the poster fallback path.
    posterPath: null,
    sourceProvider: 'tmdb', sourceKind: 'tv', sourceLabel: 'TMDB',
  },
};

const WATCH_LATER: Record<LibraryMediaKind, MovieCard[]> = {
  movie: [CARDS.dune2, CARDS.blade2049, CARDS.dune1],
  series: [CARDS.breakingBad, CARDS.simpsons],
  anime: [CARDS.frieren],
};

const FAVOURITES: Record<LibraryMediaKind, MovieCard[]> = {
  movie: [CARDS.dune2],
  series: [CARDS.breakingBad],
  anime: [CARDS.frieren],
};

function shelf(collection: LibraryCollection, kind: LibraryMediaKind) {
  const items = collection === 'watch-later' ? WATCH_LATER[kind] : FAVOURITES[kind];
  return { kind, count: items.length, previews: items.slice(0, 6) };
}

export const fixtureLibraryProvider: LibraryProvider = {
  async overview(collection: LibraryCollection): Promise<LibraryOverview> {
    return {
      shelves: [shelf(collection, 'movie'), shelf(collection, 'series'), shelf(collection, 'anime')],
      sourceLabel: LIBRARY_PREVIEW_LABEL,
    };
  },
  async category(collection: LibraryCollection, kind: LibraryMediaKind) {
    const items = collection === 'watch-later' ? WATCH_LATER[kind] : FAVOURITES[kind];
    return { items, count: items.length, sourceLabel: LIBRARY_PREVIEW_LABEL };
  },
};

// M2.4 measurement fixture: N titled cards for the bounded-list/scroll
// workload. Explicitly preview-only like the rest of the fixture provider.
// `artworkBase` (when provided) points at harness-served placeholder
// images so a cached-artwork workload can be measured alongside the
// text-only grid; the default keeps cards artwork-free.
export function createStressLibraryFixture(count: number, artworkBase?: string): LibraryProvider {
  const stressCards: MovieCard[] = Array.from({ length: count }, (_, index) => ({
    id: 100000 + index,
    title: index % 7 === 0
      ? `Stress Test Title ${index + 1} With A Deliberately Long Name That Wraps Across Two Lines`
      : `Stress Title ${index + 1}`,
    year: 1990 + (index % 35),
    posterPath: artworkBase ? `${artworkBase}${index % 10}.png` : null,
    sourceProvider: 'tmdb',
    sourceKind: 'movie',
    sourceLabel: 'TMDB',
  }));
  return {
    async overview() {
      return {
        shelves: [
          { kind: 'movie', count, previews: stressCards.slice(0, 6) },
          { kind: 'series', count: 0, previews: [] },
          { kind: 'anime', count: 0, previews: [] },
        ],
        sourceLabel: `${LIBRARY_PREVIEW_LABEL} · stress ${count}`,
      };
    },
    async category() {
      return { items: stressCards, count, sourceLabel: `${LIBRARY_PREVIEW_LABEL} · stress ${count}` };
    },
  };
}
