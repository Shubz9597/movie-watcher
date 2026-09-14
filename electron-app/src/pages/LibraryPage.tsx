// Library page (feature 002 M2.2 presentation; M3.3 server consumer,
// WF04/04b): underlined Watch Later / Favourites tabs over grouped
// Movies/Series/Anime shelves with full-scope counts, sort, and links to
// scoped grids.
//
// Data sources, in order of preference:
//   1. `library` ” the server-backed LibraryStore (Electron desktop, M3.3),
//      gated on the server's library.household.v1 capability. A server
//      without the capability shows the explicit unavailable state; there is
//      NO localStorage/device-local/provider fallback (FR10).
//   2. `provider` ” the explicit preview-only fixture provider (development
//      browser entry), always labelled on screen.
// With neither, the page shows the truthful unavailable state.
import { useEffect, useState } from 'react';
import { ChevronRight, Film, Ghost, ListFilter, Tv } from 'lucide-react';
import { SelectionSurface, UnderlineTabs } from '../components/primitives';
import { FOCUS_RING_CLASS } from '../lib/design-tokens';
import { useLibrary, useLibraryState } from '../lib/library-react';
import type { LibraryController } from '../lib/library-store.ts';
import { overviewKey, pageKey } from '../lib/library-store.ts';
import { titleRouteParams } from '../lib/canonical-route';
import { usePullToRefresh } from '../lib/pull-to-refresh';
import type {
  LibraryCollection,
  LibraryItemRow,
  LibraryMediaKind,
  LibraryProvider,
  LibrarySort,
} from '../lib/services/library-service';
import type { MovieCard } from '../lib/types';

const COLLECTION_TABS = [
  { id: 'watch-later' as const, label: 'Watch Later' },
  { id: 'favourites' as const, label: 'Favourites' },
];

const SORT_OPTIONS: Array<{ id: LibrarySort; label: string }> = [
  { id: 'recent', label: 'Recently added' },
  { id: 'title', label: 'Title A–Z' },
];

const SHELF_META: Record<LibraryMediaKind, { label: string; icon: React.ReactNode }> = {
  movie: { label: 'Movies', icon: <Film className="h-4 w-4" aria-hidden="true" /> },
  series: { label: 'Series', icon: <Tv className="h-4 w-4" aria-hidden="true" /> },
  anime: { label: 'Anime', icon: <Ghost className="h-4 w-4" aria-hidden="true" /> },
};

const UNAVAILABLE_COPY = 'The library is not available on this server. Update the TorWatch server to sync your collection.';

type Navigate = (path: string, params?: Record<string, string>, options?: { replace?: boolean }) => void;

// Canonical-id \u2014 route mapping moved to lib/canonical-route.ts (M4.2) so the
// recommendation row and the Library share one implementation.
export { routeIdFromCanonical, titleRouteParams } from '../lib/canonical-route';

type LibraryPageProps = {
  navigate: Navigate;
  /** Server-backed store (Electron desktop, M3.3). */
  library: LibraryController | null;
  /** Preview-only fixture provider (development browser entry). */
  provider: LibraryProvider | null;
  /** Controlled by the route (M2.2 restoration): the tab survives back/forward. */
  collection: LibraryCollection;
  /** Route-controlled sort (kept across back navigation per design-system). */
  sort?: LibrarySort;
};

export function LibraryPage({ navigate, provider, collection, sort = 'recent' }: LibraryPageProps) {
  const library = useLibrary();
  // Tab + sort switches REPLACE the history entry (device pass): the native
  // back gesture then leaves the page directly instead of replaying every tab
  // the user toggled (which flashed the previous collection and re-probed the
  // store — the "ghost loader").
  const setCollection = (next: LibraryCollection) => {
    navigate('library', { collection: next, sort }, { replace: true });
  };
  const setSort = (next: LibrarySort) => {
    navigate('library', { collection, sort: next }, { replace: true });
  };

  // Application-wide pull-to-refresh: refetch the collection overview.
  const { indicator: pullIndicator } = usePullToRefresh(() => library?.loadOverview(collection, sort));

  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8 lg:px-12">
      {pullIndicator}
      <div className="flex items-center justify-between gap-3">
        <h1 className="type-section-title text-white">Library</h1>
        <SortButton current={sort} onSelect={setSort} />
      </div>
      <div className="mt-4">
        <UnderlineTabs
          tabs={COLLECTION_TABS}
          active={collection}
          onChange={(id) => setCollection(id as LibraryCollection)}
          ariaLabel="Library collections"
          controlsId="library-panel"
        />
      </div>

      <div id="library-panel" role="tabpanel" aria-label={`${collection === 'watch-later' ? 'Watch Later' : 'Favourites'} titles`}>
        {library ? (
          <ServerLibraryOverview library={library} collection={collection} sort={sort} navigate={navigate} />
        ) : provider ? (
          <PreviewLibraryOverview provider={provider} collection={collection} navigate={navigate} />
        ) : (
          <UnavailableState />
        )}
      </div>
    </section>
  );
}

function SortButton({ current, onSelect }: { current: LibrarySort; onSelect: (sort: LibrarySort) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Sort library"
        aria-haspopup="dialog"
        className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-2 text-white/70 transition hover:text-white ${FOCUS_RING_CLASS}`}
      >
        <ListFilter className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
        <span className="text-sm">Sort by</span>
      </button>
      <SelectionSurface open={open} title="Sort library" onClose={() => setOpen(false)}>
        <div className="space-y-1" role="radiogroup" aria-label="Sort order">
          {SORT_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === current}
              onClick={() => {
                setOpen(false);
                onSelect(option.id);
              }}
              className={`flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-left text-sm transition hover:bg-white/[0.06] ${FOCUS_RING_CLASS} ${
                option.id === current ? 'text-white' : 'text-white/70'
              }`}
            >
              {option.label}
              {option.id === current ? <span aria-hidden="true" className="font-label text-[#ffc285]">{'\u2713'}</span> : null}
            </button>
          ))}
        </div>
      </SelectionSurface>
    </>
  );
}

function UnavailableState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="mt-8 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-6 text-center" role="status">
      <p className="type-body text-white/75">{UNAVAILABLE_COPY}</p>
      <p className="type-secondary mt-2 text-white/50">
        Your collection is kept on the TorWatch server — nothing is stored on this device.
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-4 min-h-11 rounded-full border border-white/15 px-5 text-sm text-white/85 hover:border-white/35 ${FOCUS_RING_CLASS}`}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

function ErrorState({ message, onRetry, label }: { message: string; onRetry: () => void; label: string }) {
  return (
    <div className="mt-8 rounded-lg border border-red-300/20 bg-red-950/30 px-4 py-3" role="alert">
      <p className="text-sm text-red-100">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        aria-label={`Retry ${label}`}
        className={`mt-3 min-h-11 rounded-full border border-white/15 px-5 text-sm text-white/85 hover:border-white/35 ${FOCUS_RING_CLASS}`}
      >
        Retry
      </button>
    </div>
  );
}

// --- Server-backed overview (M3.3) -------------------------------------------

function ServerLibraryOverview({ library, collection, sort, navigate }: {
  library: LibraryController;
  collection: LibraryCollection;
  sort: LibrarySort;
  navigate: Navigate;
}) {
  const state = useLibrarySnapshot(library);
  const key = overviewStateKey(collection, sort);

  useEffect(() => {
    if (state.availability === 'available') {
      library.ensureOverview(collection, sort);
    }
  }, [library, state.availability, collection, sort]);

  if (state.availability === 'checking') {
    return <ShelfSkeleton />;
  }
  if (state.availability === 'unavailable') {
    return <UnavailableState onRetry={() => void library.refreshCapability()} />;
  }
  if (state.availability === 'unreachable') {
    return <ErrorState message="The TorWatch server could not be reached. The library is stored on the server." onRetry={() => void library.refreshCapability()} label="library availability" />;
  }

  const overview = state.overviews[key];
  if (!overview || overview.status === 'loading') {
    return <ShelfSkeleton />;
  }
  if (overview.status === 'error') {
    return <ErrorState message={overview.error ?? 'The library could not be loaded.'} onRetry={() => void library.loadOverview(collection, sort)} label="library overview" />;
  }

  return (
    <div className="mt-4 space-y-8">
      {overview.stale ? (
        <p className="text-xs text-white/45" role="note">
          Offline — showing the last data this server sent you. It refreshes automatically on reconnect.
        </p>
      ) : null}
      {overview.shelves.map((shelf) => (
        <ServerShelfRow
          key={shelf.kind}
          kind={shelf.kind}
          count={shelf.count}
          previews={shelf.previews}
          collection={collection}
          sort={sort}
          navigate={navigate}
        />
      ))}
    </div>
  );
}

function ServerShelfRow({ kind, count, previews, collection, sort, navigate }: {
  kind: LibraryMediaKind;
  count: number;
  previews: LibraryItemRow[];
  collection: LibraryCollection;
  sort: LibrarySort;
  navigate: Navigate;
}) {
  const meta = SHELF_META[kind];
  return (
    <section aria-label={`${meta.label} shelf`}>
      <div className="shelf-heading mb-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          {meta.icon}
          {meta.label}
          {/* Full-scope count from the server ” independent of preview length. */}
          <span className="text-numeric text-sm font-normal text-white/50">{count}</span>
        </h2>
        <button
          type="button"
          onClick={() => navigate('library-category', { collection, kind, sort })}
          className={`shelf-see-all rounded-lg text-sm text-white/75 hover:text-white ${FOCUS_RING_CLASS}`}
          aria-label={`View all ${meta.label} (${count})`}
        >
          View all
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {count === 0 ? (
        <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/55">
          Nothing here yet. Save a title with the bookmark or heart control on its page.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {previews.map((row) => (
            <LibraryCardButton
              key={row.canonicalId}
              row={row}
              navigate={navigate}
              label={`Open ${row.title}${row.metadataAvailable ? '' : ' (metadata unavailable)'}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryCardButton({ row, navigate, label }: {
  row: LibraryItemRow;
  navigate: Navigate;
  label: string;
}) {
  // The server's canonical classification (row.type) drives the route kind so
  // a TMDb anime navigates as anime while retaining its qualified tmdb:tv /
  // tmdb:movie identity (repair pass Fix 6).
  const params = titleRouteParams(row.canonicalId, row.type);
  return (
    <button
      type="button"
      onClick={() => navigate('title', params)}
      className={`group relative aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] ${FOCUS_RING_CLASS}`}
      aria-label={label}
    >
      {row.artwork?.poster ? (
        <img
          src={row.artwork.poster}
          alt=""
          width="342"
          height="513"
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.08] to-white/[0.025]">
          <span className="text-3xl opacity-30" aria-hidden="true"><Film className="h-7 w-7" /></span>
        </div>
      )}
      {!row.metadataAvailable ? (
        <span className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white/80" aria-label="Metadata unavailable">
          Info unavailable
        </span>
      ) : null}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6 text-left">
        {/* Stored snapshot title: an unavailable-metadata entry renders from
            the server's snapshot, never a guessed name. */}
        <span className="line-clamp-2 text-xs font-medium leading-4 text-white">{row.title}</span>
      </div>
    </button>
  );
}

function ShelfSkeleton() {
  return (
    <div className="mt-8 grid grid-cols-3 gap-4 sm:grid-cols-6" role="status" aria-label="Loading library">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="aspect-[2/3] animate-pulse rounded-lg bg-white/[0.06]" />
      ))}
    </div>
  );
}

// --- Preview fixtures (development browser entry only) ------------------------

function PreviewLibraryOverview({ provider, collection, navigate }: {
  provider: LibraryProvider;
  collection: LibraryCollection;
  navigate: Navigate;
}) {
  const [overview, setOverview] = useState<import('../lib/services/library-service').LibraryOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    provider.overview(collection)
      .then((data) => { if (active) setOverview(data); })
      .catch((err: unknown) => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [provider, collection]);

  if (error) {
    return <ErrorState message={error} onRetry={() => setError(null)} label="library preview" />;
  }
  if (!overview) {
    return <ShelfSkeleton />;
  }
  return (
    <div className="mt-4 space-y-8">
      <p className="text-xs text-white/45" role="note">{overview.sourceLabel}</p>
      {overview.shelves.map((shelf) => (
        <section key={shelf.kind} aria-label={`${SHELF_META[shelf.kind].label} shelf`}>
          <div className="shelf-heading mb-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              {SHELF_META[shelf.kind].icon}
              {SHELF_META[shelf.kind].label}
              <span className="text-numeric text-sm font-normal text-white/50">{shelf.count}</span>
            </h2>
            <button
              type="button"
              onClick={() => navigate('library-category', { collection, kind: shelf.kind })}
              className={`shelf-see-all rounded-lg text-sm text-white/75 hover:text-white ${FOCUS_RING_CLASS}`}
              aria-label={`View all ${SHELF_META[shelf.kind].label} (${shelf.count})`}
            >
              View all
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {shelf.count === 0 ? (
            <p className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/55">
              Nothing here yet. Saving arrives with library sync.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {shelf.previews.map((card) => (
                <button
                  key={`${shelf.kind}-${card.id}`}
                  type="button"
                  onClick={() => navigate('title', { kind: shelf.kind === 'anime' ? 'anime' : shelf.kind === 'movie' ? 'movie' : 'tv', id: String(card.id) })}
                  className={`group relative aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] ${FOCUS_RING_CLASS}`}
                  aria-label={`Open ${card.title}`}
                >
                  {card.posterPath ? (
                    <img
                      src={card.posterPath}
                      alt=""
                      width="342"
                      height="513"
                      loading="lazy"
                      decoding="async"
                      className="absolute inset-0 h-full w-full object-cover transition group-hover:scale-105"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-white/[0.08] to-white/[0.025]">
                      <span className="text-3xl opacity-30" aria-hidden="true"><Film className="h-7 w-7" /></span>
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6 text-left">
                    <span className="line-clamp-2 text-xs font-medium leading-4 text-white">{card.title}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// --- Shared snapshot hook ------------------------------------------------------

function useLibrarySnapshot(library: LibraryController) {
  return useLibraryState() ?? library.getSnapshot();
}

function overviewStateKey(collection: LibraryCollection, sort: LibrarySort): string {
  return overviewKey(collection, sort);
}

// --- Scoped grid (WF04b) -------------------------------------------------------

type LibraryCategoryPageProps = {
  navigate: Navigate;
  library: LibraryController | null;
  provider: LibraryProvider | null;
  collection: LibraryCollection;
  kind: LibraryMediaKind;
  sort?: LibrarySort;
};

export function LibraryCategoryPage({ navigate, provider, collection, kind, sort = 'recent' }: LibraryCategoryPageProps) {
  const library = useLibrary();
  const title = `${collection === 'watch-later' ? 'Watch Later' : 'Favourites'} — ${SHELF_META[kind].label}`;
  const setSort = (next: LibrarySort) => {
    navigate('library-category', { collection, kind, sort: next }, { replace: true });
  };

  // Application-wide pull-to-refresh: refetch this collection's grid.
  const { indicator: pullIndicator } = usePullToRefresh(() => library?.loadPage(collection, kind, sort));

  return (
    <section className="mx-auto max-w-[1600px] px-5 py-6 md:px-8 lg:px-12">
      {pullIndicator}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => navigate('library', { collection, sort })}
          className={`inline-flex min-h-11 items-center rounded-full text-sm text-white/65 hover:text-white ${FOCUS_RING_CLASS}`}
        >
          {'\u2039'} Library
        </button>
        <SortButton current={sort} onSelect={setSort} />
      </div>
      <h1 className="type-section-title mt-2 text-white">{title}</h1>

      {library ? (
        <ServerLibraryGrid library={library} collection={collection} kind={kind} sort={sort} navigate={navigate} />
      ) : provider ? (
        <PreviewLibraryGrid provider={provider} collection={collection} kind={kind} />
      ) : (
        <UnavailableState />
      )}
    </section>
  );
}

function ServerLibraryGrid({ library, collection, kind, sort, navigate }: {
  library: LibraryController;
  collection: LibraryCollection;
  kind: LibraryMediaKind;
  sort: LibrarySort;
  navigate: Navigate;
}) {
  const state = useLibrarySnapshot(library);
  const key = pageKey(collection, kind, sort);

  useEffect(() => {
    if (state.availability === 'available') {
      library.ensurePage(collection, kind, sort);
    }
  }, [library, state.availability, collection, kind, sort]);

  if (state.availability === 'checking') {
    return <ShelfSkeleton />;
  }
  if (state.availability === 'unavailable') {
    return <UnavailableState onRetry={() => void library.refreshCapability()} />;
  }
  if (state.availability === 'unreachable') {
    return <ErrorState message="The TorWatch server could not be reached. The library is stored on the server." onRetry={() => void library.refreshCapability()} label="library availability" />;
  }

  const page = state.pages[key];
  if (!page || page.status === 'loading') {
    return <ShelfSkeleton />;
  }
  if (page.status === 'error') {
    return <ErrorState message={page.error ?? 'This collection could not be loaded.'} onRetry={() => void library.loadPage(collection, kind, sort)} label="this collection" />;
  }

  return (
    <>
      {page.stale ? (
        <p className="mt-2 text-xs text-white/45" role="note">
          Offline — showing the last synced data · {page.total} {page.total === 1 ? 'title' : 'titles'}
        </p>
      ) : null}
      <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {page.items.map((row) => (
          <LibraryCardButton key={row.canonicalId} row={row} navigate={navigate} label={`Open ${row.title}${row.metadataAvailable ? '' : ' (metadata unavailable)'}`} />
        ))}
      </div>
      {page.items.length === 0 ? (
        <p className="mt-6 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/55">
          Nothing here yet. Save a title with the bookmark or heart control on its page.
        </p>
      ) : null}
      {page.error ? (
        <div className="mt-4 rounded-lg border border-red-300/20 bg-red-950/30 px-4 py-3" role="alert">
          <p className="text-sm text-red-100">{page.error}</p>
          <button
            type="button"
            onClick={() => (page.cursor ? void library.loadMore(collection, kind, sort) : void library.loadPage(collection, kind, sort))}
            className={`mt-3 min-h-11 rounded-full border border-white/15 px-5 text-sm text-white/85 hover:border-white/35 ${FOCUS_RING_CLASS}`}
          >
            {page.cursor ? 'Retry' : 'Reload from the first page'}
          </button>
        </div>
      ) : null}
      {page.cursor ? (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => void library.loadMore(collection, kind, sort)}
            disabled={page.loadingMore}
            aria-label={`Load more titles (${page.items.length} of ${page.total} shown)`}
            className={`min-h-11 rounded-full border border-white/15 px-6 text-sm text-white/85 transition hover:border-white/35 disabled:opacity-50 ${FOCUS_RING_CLASS}`}
          >
            {page.loadingMore ? 'Loading\u2026' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  );
}

function PreviewLibraryGrid({ provider, collection, kind }: {
  provider: LibraryProvider;
  collection: LibraryCollection;
  kind: LibraryMediaKind;
}) {
  const [state, setState] = useState<{ items: MovieCard[]; count: number; sourceLabel: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    provider.category(collection, kind)
      .then((data) => { if (active) setState(data); })
      .catch((err: unknown) => { if (active) setError(String(err)); });
    return () => { active = false; };
  }, [provider, collection, kind]);

  if (error) {
    return <ErrorState message={error} onRetry={() => setError(null)} label="library preview" />;
  }
  if (!state) {
    return <ShelfSkeleton />;
  }
  return (
    <>
      <p className="mt-2 text-xs text-white/45" role="note">{state.sourceLabel} · {state.count} titles</p>
      <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {state.items.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => window.location.hash = `title?kind=${kind === 'anime' ? 'anime' : kind === 'movie' ? 'movie' : 'tv'}&id=${card.id}`}
            className={`group relative aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08] bg-[#151515] ${FOCUS_RING_CLASS}`}
            aria-label={`Open ${card.title}`}
          >
            {card.posterPath ? (
              <img src={card.posterPath} alt="" width="342" height="513" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
            ) : null}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 pb-1.5 pt-6 text-left">
              <span className="line-clamp-2 text-xs font-medium leading-4 text-white">{card.title}</span>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
