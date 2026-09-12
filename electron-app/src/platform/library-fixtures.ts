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

// M3.3 fixture-state imports are merged into the import block below (the
// type-only additions at the bottom of this file share these identifiers).

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

// --- M3.3 capture/state fixtures ---------------------------------------------

// createLibraryStateFixture implements the LibraryController surface with
// deterministic behaviors so the REAL shared Library pages and LibraryToggle
// can be captured/tested in every required state. It is injected ONLY by the
// development browser fixture entry; no production path imports it.
import type { LibraryItemRow } from '../lib/services/library-service';
import type { LibraryController, LibrarySnapshot } from '../lib/library-store.ts';

export type LibraryFixtureScenario =
  | 'populated'      // populated shelves incl. a zero-count shelf + unavailable metadata
  | 'empty'          // fully empty collection
  | 'error'          // overview/page fetch failure
  | 'unavailable'    // server without the library capability
  | 'write-failure'  // every write fails (Retry keeps failing)
  | 'write-pending'; // writes never settle (pending state)

function row(canonicalId: string, title: string, kind: LibraryMediaKind, year?: number, poster?: string, metadataAvailable = true): LibraryItemRow {
  return {
    canonicalId, type: kind, title, year,
    artwork: poster ? { poster } : undefined,
    addedAt: '2026-09-09T12:00:00Z',
    metadataAvailable,
  };
}

const FIXTURE_ROWS: Record<string, LibraryItemRow> = {
  dune: row('tmdb:movie:693134', 'Dune: Part Two', 'movie', 2024, 'https://image.tmdb.org/t/p/w342/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg'),
  blade: row('tmdb:movie:335984', 'Blade Runner 2049', 'movie', 2017, 'https://image.tmdb.org/t/p/w342/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg'),
  simpsons: row('tmdb:tv:456', 'The Simpsons', 'series', 1989, undefined, false), // unavailable metadata + no artwork
  breaking: row('tmdb:tv:1396', 'Breaking Bad', 'series', 2008, 'https://image.tmdb.org/t/p/w342/ggFHVNu6YYI5L9pCfOacjizRGt.jpg'),
  frieren: row('tmdb:tv:209867', 'Frieren: Beyond Journey\'s End', 'anime', 2023, 'https://image.tmdb.org/t/p/w342/dqZENchTd7lp5zht7BdlqM7RBhD.jpg'),
};

export function createLibraryStateFixture(scenario: string): LibraryController {
  const availability: LibrarySnapshot['availability'] = scenario === 'unavailable' ? 'unavailable' : 'available';
  let snapshot: LibrarySnapshot = {
    availability,
    overviews: {},
    pages: {},
    memberships: {
      [FIXTURE_ROWS.dune.canonicalId]: { watchLater: true, favourite: false, revision: '9007199254740993' },
    },
    pending: {},
    errors: {},
  };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<LibrarySnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  };

  const populatedShelves = (collection: LibraryCollection) => [
    collection === 'watch-later'
      ? { kind: 'movie' as const, count: 2, previews: [FIXTURE_ROWS.dune, FIXTURE_ROWS.blade] }
      : { kind: 'movie' as const, count: 1, previews: [FIXTURE_ROWS.blade] },
    { kind: 'series' as const, count: 2, previews: [FIXTURE_ROWS.breaking, FIXTURE_ROWS.simpsons] },
    { kind: 'anime' as const, count: 1, previews: [FIXTURE_ROWS.frieren] },
  ];
  const emptyShelves = [
    { kind: 'movie' as const, count: 0, previews: [] },
    { kind: 'series' as const, count: 0, previews: [] },
    { kind: 'anime' as const, count: 0, previews: [] },
  ];
  // The scoped grid pages 6 at a time with a cursor so the "Load more"
  // control is exercisable.
  const gridPage = (page: number) => {
    const all = [FIXTURE_ROWS.dune, FIXTURE_ROWS.blade, FIXTURE_ROWS.breaking, FIXTURE_ROWS.simpsons, FIXTURE_ROWS.frieren];
    const start = (page - 1) * 2;
    const items = all.slice(start, start + 2);
    return {
      collection: 'watch-later' as const,
      kind: 'all' as const,
      sort: 'recent' as const,
      revision: String(9007199254740990 + page),
      total: all.length,
      items,
      nextCursor: start + 2 < all.length ? `cursor-page-${page + 1}` : undefined,
      degraded: false,
    };
  };

  const controller: LibraryController = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    ensureOverview(collection, sort) {
      const key = `${collection}|${sort}`;
      if (snapshot.overviews[key]?.status === 'ready') return;
      if (scenario === 'error') {
        publish({ overviews: { ...snapshot.overviews, [key]: { status: 'error', shelves: [], revision: '', error: 'The library could not be loaded. Retry shortly.' } } });
        return;
      }
      publish({ overviews: { ...snapshot.overviews, [key]: { status: 'ready', revision: '9007199254740993', error: null, shelves: scenario === 'empty' ? emptyShelves : populatedShelves(collection) } } });
    },
    async loadOverview(collection, sort) {
      controller.ensureOverview(collection, sort);
    },
    ensurePage(collection, kind, sort) {
      const key = `${collection}|${kind}|${sort}`;
      if (snapshot.pages[key]?.status === 'ready') return;
      if (scenario === 'error') {
        publish({ pages: { ...snapshot.pages, [key]: { status: 'error', items: [], total: 0, revision: '', cursor: null, loadingMore: false, error: 'This collection could not be loaded. Retry shortly.' } } });
        return;
      }
      const data = gridPage(1);
      publish({ pages: { ...snapshot.pages, [key]: { status: 'ready', items: data.items, total: data.total, revision: data.revision, cursor: data.nextCursor ?? null, loadingMore: false, error: null } } });
    },
    async loadPage(collection, kind, sort) {
      controller.ensurePage(collection, kind, sort);
    },
    async loadMore(collection, kind, sort) {
      const key = `${collection}|${kind}|${sort}`;
      const page = snapshot.pages[key];
      if (!page?.cursor) return;
      const pageNumber = Number(page.cursor.replace('cursor-page-', '')) || 2;
      const data = gridPage(pageNumber);
      publish({ pages: { ...snapshot.pages, [key]: { ...page, items: [...page.items, ...data.items], total: data.total, revision: data.revision, cursor: data.nextCursor ?? null, loadingMore: false } } });
    },
    async refreshCapability() {
      return availability;
    },
    async refreshAll() {
      // Fixture controller: data is local and deterministic, nothing to sync.
    },
    toggle(canonicalId, field) {
      const key = `${field}|${canonicalId}`;
      if (scenario === 'write-pending') {
        publish({ pending: { ...snapshot.pending, [key]: true as const } });
        return; // never settles: the pending state is capturable
      }
      if (scenario === 'write-failure') {
        publish({ pending: { ...snapshot.pending, [key]: true as const } });
        setTimeout(() => {
          const pending = { ...snapshot.pending };
          delete pending[key];
          publish({
            pending,
            errors: { ...snapshot.errors, [key]: 'The TorWatch server could not be reached. Check the connection and retry.' },
          });
        }, 400);
        return;
      }
      publish({ pending: { ...snapshot.pending, [key]: true as const } });
      setTimeout(() => {
        const membership = snapshot.memberships[canonicalId] ?? { watchLater: false, favourite: false };
        const pending = { ...snapshot.pending };
        delete pending[key];
        publish({
          pending,
          memberships: {
            ...snapshot.memberships,
            [canonicalId]: {
              watchLater: field === 'watch-later' ? !membership.watchLater : membership.watchLater,
              favourite: field === 'favourites' ? !membership.favourite : membership.favourite,
              revision: String(Number(membership.revision ?? '0') + 1),
            },
          },
        });
      }, 400);
    },
    retry(canonicalId, field) {
      controller.toggle(canonicalId, field);
    },
    lastTargetFor(canonicalId, field) {
      const membership = snapshot.memberships[canonicalId];
      const current = field === 'watch-later' ? membership?.watchLater ?? false : membership?.favourite ?? false;
      return !current;
    },
    // M1.4: fixtures own no origin subscriptions; dispose is a no-op.
    dispose() {
      /* deterministic fixture: nothing to release */
    },
  };
  return controller;
}
